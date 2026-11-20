"""Hermes memory provider for shared llmOS project memory (`memory.provider: llmos`).

Shared project memory lives in the vault at `projects/<project>/memory/`: a
`MEMORY.md` index of one-line links and one topic note per memory, in the
format Claude Code writes. This provider puts the index in the system prompt
and gives Hermes `memory_save`, `memory_search`, and `memory_forget`. Each
runs `llmos memory ...` from the same install, so Hermes, the MCP tools, and
the CLI share one implementation.

Hermes's built-in `memory` tool stays on for facts only Hermes can act on.

Recall: after each turn, `queue_prefetch` starts a background thread that
pools the scope's notes sharing a word with the prompt (top 5) and the top 5
hits of a semantic `llmos memory search` with a score of at least 0.45
(through the llmOS service when it runs). With `LLMOS_RECALL_JUDGE_URL` set, a
decision-model judge reads the pool and the provider keeps the notes it rates
helpful with a probability of at least the model's threshold, at most 5.
`LLMOS_RECALL_JUDGE_MODEL` names the model in the request (default `d1-2B`). The
threshold follows the model: 0.5 for `d1-2B`, 0.3 for `clef-flash`.
`LLMOS_RECALL_JUDGE_THRESHOLD` (0 to 1) overrides it. A model with no threshold and
no override never calls the judge, and `initialize()` logs one warning.
`LLMOS_RECALL_JUDGE_TIMEOUT` is the deadline for the whole judge call in seconds
(default 5). Without the judge, or when it fails, recall is semantic-only: the
first 2 semantic hits with a score of at least 0.75. A memory saved a moment ago
has no vector yet, so only the judge finds it until it is embedded. The block is
cached for the session. `prefetch` hands it to the next turn once.

The project comes from the session's folder, by Hermes's own order: the
`cwd` that `initialize()` receives, else the profile's `TERMINAL_CWD`. A
folder in a vault project's repository uses that project; anything else
uses `personal`. (`agent_workspace` is a fixed label, not a folder.)

Standard library only. Every binding lives on the instance, because one
gateway process can serve several profiles.
"""

from __future__ import annotations

import http.client
import json
import logging
import math
import os
import random
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

from agent.memory_provider import (
    MemoryProvider,
    RecallStatus,
    is_trivial_prompt,
    spawn_context_thread,
)

LOG = logging.getLogger(__name__)

CLI = Path(__file__).resolve().parent.parent / "cli" / "bin" / "llmos.ts"
TIMEOUT_SECONDS = 60
MEMORY_TYPES = ["user", "feedback", "project", "reference"]
RECALL_LIMIT = 5
# The service takes a query of at most 1000 characters (JavaScript string length, so
# UTF-16 code units) without control characters.
QUERY_CHARS = 1000
NOTE_CHARS = 2000
CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
DESCRIPTION = re.compile(r"^description:[ \t]*(.+)$", re.MULTILINE)
# The pool, the recall judge, and the fallback below are the settings an offline
# evaluation picked; keep them as it defined them.
POOL_K = 5
POOL_FLOOR = 0.45
# The CLI fetches the global top min(10 * limit, 200) hits, then keeps the project's
# first `limit`: 20 * 10 = 200 is the global fetch.
SEMANTIC_LIMIT = 20
JUDGE_TIMEOUT_DEFAULT = 5.0
# A joint answer for ten notes is about 2 KB; a larger one is not a judge answer.
JUDGE_ANSWER_BYTES = 1 << 20
FALLBACK_K = 2
FALLBACK_FLOOR = 0.75
JUDGE_NOTE_CHARS = 1500
MESSAGE_CHARS = 4000
TERM = re.compile(r"[a-z0-9][a-z0-9_-]{2,}")
STOPWORDS = frozenset(
    "about all and any are can could did does for from had has have how into its not our "
    "should that the their them then there they this was were what when where which who why "
    "will with would you your".split()
)

GUIDE = (
    "Shared project memory is the llmOS vault's {dir}/ (project {project}); Claude Code and "
    "the other agents read and write the same notes. Use memory_save for a fact another "
    "agent or a later session can use: a user preference, a correction, a project "
    "constraint, or a pointer to an outside resource. Use memory_search when the index "
    "lines below do not settle what you need, and memory_forget for a memory that is wrong. "
    "Use the built-in memory tool only for facts that only Hermes can act on, such as "
    "Hermes skills, gateway, or cron behavior. One session's progress is not a memory."
)

SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "memory_save",
        "description": (
            "Save one shared project memory: a topic note and its MEMORY.md index line. "
            "Saving a name again replaces that memory. Fails when the index would pass "
            "200 lines; merge or forget memories first."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Lowercase slug of the memory and its file name, such as use-uv.",
                },
                "description": {
                    "type": "string",
                    "description": "One line that says when the memory is relevant.",
                },
                "body": {
                    "type": "string",
                    "description": (
                        "The fact; for feedback and project, add **Why:** and **How to apply:**."
                    ),
                },
                "type": {
                    "type": "string",
                    "enum": MEMORY_TYPES,
                    "description": (
                        "user (who the user is), feedback (how to work), project (ongoing "
                        "work), or reference (a pointer)."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": "Link text of the index line. Default: the name with spaces.",
                },
            },
            "required": ["name", "description", "body", "type"],
        },
    },
    {
        "name": "memory_search",
        "description": "Search this project's shared memory notes by meaning.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for."},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "description": "Maximum number of results. Default: 5.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_forget",
        "description": "Delete one shared memory: its topic note and its index line.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The memory's name (its file name without .md).",
                },
            },
            "required": ["name"],
        },
    },
]

WRITE_TOOLS = {"memory_save", "memory_forget"}


def _bun() -> str | None:
    found = shutil.which("bun")
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "share" / "mise" / "shims" / "bun",
        Path.home() / ".bun" / "bin" / "bun",
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def _session_folder(kwargs: dict[str, Any]) -> str | None:
    """The session's folder, in the order Hermes itself uses: `cwd`, then TERMINAL_CWD."""
    cwd = kwargs.get("cwd")
    if isinstance(cwd, str) and os.path.isabs(cwd):
        return cwd
    try:
        from agent.runtime_cwd import scope_terminal_cwd
        from tools.terminal_scope import TerminalPolicyUnavailable
    except ImportError:
        terminal = os.environ.get("TERMINAL_CWD", "")
    else:
        try:
            terminal = scope_terminal_cwd()
        except TerminalPolicyUnavailable:
            terminal = ""
    return terminal if terminal and os.path.isabs(terminal) else None


def _query(text: str) -> str:
    """The prompt as a service query: no control characters, at most QUERY_CHARS UTF-16 units."""
    query = CONTROL.sub(" ", text).strip()
    units = query.encode("utf-16-le")[: 2 * QUERY_CHARS]
    return units.decode("utf-16-le", errors="ignore").strip()


def _note(text: str) -> tuple[str, str]:
    """(" — description" or "", the body without frontmatter, cut to NOTE_CHARS)."""
    heading, body = "", text.strip()
    if body.startswith("---\n") and "\n---" in body[4:]:
        front, body = body[4:].split("\n---", 1)
        match = DESCRIPTION.search(front)
        heading = f" — {match.group(1).strip()}" if match else ""
        body = body.strip()
    if len(body) > NOTE_CHARS:
        body = body[:NOTE_CHARS] + "\n[cut]"
    return heading, body


def _terms(text: str) -> set[str]:
    return {term for term in TERM.findall(text.lower()) if term not in STOPWORDS}


def _keyword(query: str, notes: dict[str, tuple[str, str]]) -> list[dict[str, str]]:
    """Notes whose description or body shares any query term, ranked by summed
    IDF. qmd's keyword search needs every term, so a whole prompt matches nothing."""
    wanted = _terms(query)
    found = {path: wanted & _terms(" ".join(note)) for path, note in notes.items()}
    count = {term: sum(term in terms for terms in found.values()) for term in wanted}
    score = {
        path: sum(math.log(1 + len(notes) / count[term]) for term in terms)
        for path, terms in found.items()
        if terms
    }
    ranked = sorted(score, key=lambda path: -score[path])[:POOL_K]
    return [{"path": path} for path in ranked]


def _fallback_picks(hits: list[tuple[str, float]]) -> list[str]:
    """Without the judge: the first FALLBACK_K semantic hits that score at least FALLBACK_FLOOR."""
    return [path for path, score in hits[:FALLBACK_K] if score >= FALLBACK_FLOOR]


# The judge request below is the one the offline evaluation sent. The judge's scores depend on
# every character of these templates: do not rephrase or reflow them.
# The default SystemOne model; LLMOS_RECALL_JUDGE_MODEL names another one.
JUDGE_MODEL = "d1-2B"
# The probability of "helpful" a note needs, by model. An offline evaluation picked
# each value (same pool, same request template); both recall at most RECALL_LIMIT.
JUDGE_THRESHOLDS = {"d1-2B": 0.5, "clef-flash": 0.3}
STATE = """A developer is working in project "{project}". Before the agent answers the \
developer's message, recall may add some of the project's saved memories to the agent's \
context. Most memories are irrelevant to most messages. Judge only usefulness for this \
message, not whether a memory is well written.

DEVELOPER'S MESSAGE:
<<<
{text}
>>>

CANDIDATE MEMORIES:
{memories}"""
INSTRUCTIONS = (
    "Would the agent handle THIS developer message better with memory [{label}] ({name}) "
    "in its context?"
)
HELPFUL = (
    "Yes: memory [{label}] is useful for this message. It changes what the agent should "
    "do, say, or avoid, or it is useful background for this message."
)
NOISE = (
    "No: memory [{label}] is not useful for this message. Adding it to the agent's "
    "context would only be noise."
)


def _judge_note(text: str) -> str:
    """A note as the judge sees it: its description, then its body, cut to JUDGE_NOTE_CHARS."""
    if text.startswith("---\n") and "\n---" in text[4:]:
        front, body = text[4:].split("\n---", 1)
        description = next(
            (
                line.split(":", 1)[1].strip()
                for line in front.splitlines()
                if line.strip().startswith("description:")
            ),
            "",
        )
        text = f"({description})\n{body.strip()}" if description else body.strip()
    return text[:JUDGE_NOTE_CHARS]


def _judge_message(query: str) -> str:
    """The developer's message in the judge's state: stripped, at most MESSAGE_CHARS."""
    return query.strip()[:MESSAGE_CHARS]


def _judge_order(pool: list[str], seed: str) -> list[str]:
    """The pool in the judge's order: sorted, then shuffled with a generator seeded by `seed`."""
    ordered = sorted(pool)
    random.Random(seed).shuffle(ordered)
    return ordered


def _judge_request(
    project: str,
    message: str,
    paths: list[str],
    texts: dict[str, str],
    model: str = JUDGE_MODEL,
) -> dict:
    """One SystemOne request whose fields m1..mN are the notes at `paths`, in order."""
    labels = [f"m{i}" for i in range(1, len(paths) + 1)]
    memories = "\n\n".join(
        f"[{label}] {path.rsplit('/', 1)[1]}\n{_judge_note(texts[path])}"
        for label, path in zip(labels, paths)
    )
    questions = {
        label: {
            "type": "choice",
            "instructions": INSTRUCTIONS.format(
                label=label, name=path.rsplit("/", 1)[1]
            ),
            "criteria": {
                "helpful": HELPFUL.format(label=label),
                "noise": NOISE.format(label=label),
            },
        }
        for label, path in zip(labels, paths)
    }
    state = STATE.format(project=project, text=message, memories=memories)
    return {"model": model, "state": state, "questions": questions}


def _timeout_from(value: str | None) -> float:
    try:
        timeout = float(value) if value else JUDGE_TIMEOUT_DEFAULT
    except ValueError:
        return JUDGE_TIMEOUT_DEFAULT
    return timeout if math.isfinite(timeout) and timeout > 0 else JUDGE_TIMEOUT_DEFAULT


def _post_json(url: str, body: bytes, timeout: float) -> Any:
    """POST `body` to `url` and parse the JSON answer, all within `timeout` seconds.

    The call runs on its own thread, so a slow DNS lookup or a server that sends
    a byte at a time cannot hold recall past the deadline; at the deadline the
    socket is shut down, which ends the call. Raises OSError (TimeoutError at
    the deadline), ValueError, or http.client.HTTPException.
    """
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"not an http or https URL: {url}")
    connection_class = (
        http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parts.hostname, parts.port, timeout=timeout)
    outcome: dict[str, Any] = {}

    def call() -> None:
        try:
            connection.request(
                "POST", parts.path or "/", body, {"Content-Type": "application/json"}
            )
            response = connection.getresponse()
            if response.status != 200:
                raise OSError(f"HTTP {response.status} {response.reason}")
            data = response.read(JUDGE_ANSWER_BYTES + 1)
            if len(data) > JUDGE_ANSWER_BYTES:
                raise ValueError(f"answer is larger than {JUDGE_ANSWER_BYTES} bytes")
            outcome["answer"] = json.loads(data)
        except Exception as error:  # noqa: BLE001 -- handed to the waiting thread
            outcome["error"] = error
        finally:
            connection.close()

    worker = threading.Thread(target=call, name="llmos-memory-judge", daemon=True)
    started = time.monotonic()
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        sock = connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        raise TimeoutError(f"no answer within {time.monotonic() - started:.1f} s")
    if "error" in outcome:
        raise outcome["error"]
    return outcome["answer"]


def _threshold_from(model: str, value: str | None) -> tuple[float | None, bool]:
    """The judge threshold and whether `value` was set but invalid.

    A valid `value` (a finite float in [0, 1]) wins; otherwise the table value for
    `model`, or None for an unknown model.
    """
    invalid = False
    if value:
        try:
            override = float(value)
        except ValueError:
            override = math.nan
        if math.isfinite(override) and 0 <= override <= 1:
            return override, False
        invalid = True
    return JUDGE_THRESHOLDS.get(model), invalid


def _helpful(answer: Any, label: str) -> float:
    """The probability of "helpful" for field `label`; ValueError when it is missing or bad."""
    try:
        value = answer["answers"][label]["probabilities"]["helpful"]
    except (KeyError, TypeError):
        raise ValueError(f"no helpful probability for {label}") from None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"helpful probability for {label} is not a number")
    if not 0 <= value <= 1:
        raise ValueError(f"helpful probability for {label} is outside [0, 1]")
    return float(value)


class LlmosMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._scope: dict[str, Any] | None = None
        self._writes = False
        self._lock = threading.Lock()
        # session_id -> (generation, block, count); a newer recall wins.
        self._recalled: dict[str, tuple[int, str, int]] = {}
        self._generation = 0
        self._last_count = 0
        self._judge_url: str | None = None
        self._judge_timeout = JUDGE_TIMEOUT_DEFAULT
        self._judge_model = JUDGE_MODEL
        # None when no threshold resolves; the judge is then never called.
        self._judge_threshold: float | None = JUDGE_THRESHOLDS[JUDGE_MODEL]
        # True after a failed judge call until the next success; under the lock.
        self._judge_failing = False

    @property
    def name(self) -> str:
        return "llmos"

    def is_available(self) -> bool:
        return _bun() is not None and CLI.is_file()

    def unavailable_reason(self) -> str:
        if _bun() is None:
            return "bun is not on PATH; install it, then run the llmOS install"
        return f"the llmos CLI is missing at {CLI}; run the llmOS install"

    def _llmos(self, *args: str) -> tuple[Any, str | None]:
        """Run `llmos <args>`: the parsed JSON output, or None and the error."""
        bun = _bun()
        if bun is None:
            return None, "bun is not on PATH"
        command = [
            bun,
            "--no-install",
            "--no-env-file",
            "--config=/dev/null",
            str(CLI),
            *args,
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError) as error:
            return None, str(error)
        if result.returncode != 0:
            return None, (result.stderr.strip() or f"llmos exited {result.returncode}")
        try:
            return json.loads(result.stdout), None
        except ValueError:
            return None, "llmos printed no JSON"

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        # Subagents, cron runs, and flushes read memory but never write it.
        self._writes = kwargs.get("agent_context", "primary") == "primary"
        url = os.environ.get("LLMOS_RECALL_JUDGE_URL", "").strip().rstrip("/")
        self._judge_url = url or None
        self._judge_timeout = _timeout_from(os.environ.get("LLMOS_RECALL_JUDGE_TIMEOUT"))
        self._judge_model = (
            os.environ.get("LLMOS_RECALL_JUDGE_MODEL", "").strip() or JUDGE_MODEL
        )
        raw = os.environ.get("LLMOS_RECALL_JUDGE_THRESHOLD", "").strip()
        self._judge_threshold, invalid = _threshold_from(self._judge_model, raw)
        if invalid:
            LOG.warning(
                "llmos memory recall: LLMOS_RECALL_JUDGE_THRESHOLD must be a number "
                "from 0 to 1; ignoring it"
            )
        if self._judge_url and self._judge_threshold is None:
            LOG.warning(
                "llmos memory recall: no threshold for the recall judge model %s; "
                "set LLMOS_RECALL_JUDGE_THRESHOLD to use the judge, "
                "else recall is semantic-only",
                self._judge_model,
            )
        folder = _session_folder(kwargs)
        where = ["--workspace", folder] if folder else ["--project", "personal"]
        scope, error = self._llmos("memory", "scope", *where)
        if error is not None:
            LOG.warning(
                "llmos memory: no scope for %s: %s", folder or "personal", error
            )
        self._scope = scope if isinstance(scope, dict) else None

    def system_prompt_block(self) -> str:
        scope = self._scope
        if scope is None:
            return ""
        parts = [GUIDE.format(dir=scope["dir"], project=scope["project"])]
        index = scope.get("index_text")
        if isinstance(index, str) and index:
            parts.append(f"Shared project memory ({scope['index']}):\n{index}")
        return "\n\n".join(parts)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if self._scope is None or is_trivial_prompt(query):
            return
        with self._lock:
            self._generation += 1
            generation = self._generation
        # Hermes runs this on its one memory worker, which also does writes; recall
        # gets its own thread so a slow search never holds them up.
        spawn_context_thread(
            self._recall,
            name="llmos-memory-recall",
            args=(query, session_id, generation),
        ).start()

    def _judge_helpful(
        self, project: str, message: str, paths: list[str], texts: dict[str, str]
    ) -> dict[str, float]:
        """Ask the judge how helpful each note is. Raises what `_post_json` raises,
        RecursionError for a too deeply nested answer, or ValueError for a bad one."""
        request = _judge_request(project, message, paths, texts, self._judge_model)
        answer = _post_json(
            f"{self._judge_url}/v1/systemone",
            json.dumps(request).encode("utf-8"),
            self._judge_timeout,
        )
        return {path: _helpful(answer, f"m{i}") for i, path in enumerate(paths, 1)}

    def _recall(
        self, query: str, session_id: str, generation: int, seed: str | None = None
    ) -> None:
        # `seed` orders the notes in the judge request. Hermes never passes it, so the
        # seed is the message in the request, as the evaluation seeded by its case;
        # a replay of the evaluation passes the case id.
        scope = self._scope
        if scope is None:
            return
        # index_path is the vault root joined with the vault-relative index.
        root = Path(str(scope["index_path"])[: -len(str(scope["index"]))])
        texts: dict[str, str] = {}
        # Sorted, so `_keyword` breaks score ties by path, not by the order the
        # file system lists the folder in.
        for note in sorted((root / str(scope["dir"])).glob("*.md")):
            if note.name != "MEMORY.md":
                try:
                    texts[f"{scope['dir']}/{note.name}"] = note.read_text(encoding="utf-8")
                except OSError:
                    continue
        notes_by_path = {path: _note(text) for path, text in texts.items()}
        text = _query(query)
        keyword = [hit["path"] for hit in _keyword(text, notes_by_path)]
        hits, error = self._llmos(
            "memory", "search", "--project", str(scope["project"]),
            "--limit", str(SEMANTIC_LIMIT), "--", text,
        )
        if error is not None:
            LOG.debug("llmos memory recall: %s", error)
        semantic = [
            (hit["path"], hit["score"])
            for hit in (hits if isinstance(hits, list) else [])
            if isinstance(hit, dict)
            and isinstance(hit.get("path"), str)
            and isinstance(hit.get("score"), (int, float))
            and not isinstance(hit["score"], bool)
        ]
        pool = sorted(
            set(keyword)
            | {path for path, score in semantic[:POOL_K] if score >= POOL_FLOOR}
        )
        pool = [path for path in pool if path in texts]
        picks = _fallback_picks(semantic)
        threshold = self._judge_threshold
        if self._judge_url and threshold is not None and pool:
            message = _judge_message(query)
            order = _judge_order(pool, seed if seed is not None else message)
            try:
                helpful = self._judge_helpful(str(scope["project"]), message, order, texts)
            except (OSError, ValueError, http.client.HTTPException, RecursionError) as failure:
                with self._lock:
                    first = not self._judge_failing
                    self._judge_failing = True
                LOG.log(
                    logging.WARNING if first else logging.DEBUG,
                    "llmos memory recall: the recall judge at %s failed, "
                    "using semantic-only recall: %s",
                    self._judge_url,
                    failure,
                )
            else:
                with self._lock:
                    self._judge_failing = False
                kept = sorted(
                    (path for path in order if helpful[path] >= threshold),
                    key=lambda path: (-helpful[path], path),
                )
                picks = kept[:RECALL_LIMIT]
        notes = []
        for path in picks:
            heading, body = notes_by_path.get(path, ("", ""))
            if body:
                notes.append(f"### {path}{heading}\n{body}")
        block = ""
        if notes:
            block = "Shared project memories that match this conversation:\n\n" + "\n\n".join(notes)
        with self._lock:
            current = self._recalled.get(session_id)
            if current is None or current[0] < generation:
                self._recalled[session_id] = (generation, block, len(notes))

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        with self._lock:
            generation, block, count = self._recalled.get(session_id, (0, "", 0))
            # Keep the generation, so an older recall that ends later cannot refill it.
            self._recalled[session_id] = (generation, "", 0)
            self._last_count = count
        return block

    def recall_status(self) -> RecallStatus | None:
        count = self._last_count
        return RecallStatus("llmOS memory", count) if count > 0 else None

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return SCHEMAS

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **_: Any) -> str:
        scope = self._scope
        if scope is None:
            return json.dumps(
                {"error": "llmOS shared memory is not available in this session"}
            )
        if tool_name in WRITE_TOOLS and not self._writes:
            return json.dumps(
                {"error": "this session reads shared memory but does not write it"}
            )
        options = ["--project", str(scope["project"])]
        if tool_name == "memory_save":
            options += ["--type", str(args.get("type", "project"))]
            if args.get("title"):
                options += ["--title", str(args["title"])]
            values = [str(args.get(key, "")) for key in ("name", "description", "body")]
        elif tool_name == "memory_search":
            limit = args.get("limit", 5)
            options += ["--limit", str(limit if isinstance(limit, int) else 5)]
            values = [str(args.get("query", ""))]
        elif tool_name == "memory_forget":
            values = [str(args.get("name", ""))]
        else:
            return json.dumps({"error": f"unknown tool {tool_name}"})
        verb = tool_name.removeprefix("memory_")
        # "--" ends the options, so a value that starts with "-" stays a value.
        argv = ["memory", verb, *options, "--", *values]
        result, error = self._llmos(*argv)
        return json.dumps({"error": error} if error is not None else result)
