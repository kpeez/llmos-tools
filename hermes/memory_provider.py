"""Hermes memory provider for shared llmOS project memory (`memory.provider: llmos`).

Shared project memory lives in the vault at `projects/<project>/memory/`: a
`MEMORY.md` index of one-line links and one topic note per memory, in the
format Claude Code writes. This provider puts the index in the system prompt
and gives Hermes `memory_save`, `memory_search`, and `memory_forget`. Each
runs `llmos memory ...` from the same install, so Hermes, the MCP tools, and
the CLI share one implementation.

Hermes's built-in `memory` tool stays on for facts only Hermes can act on.

Recall: after each turn, `queue_prefetch` starts a background thread that
takes the scope's notes sharing a word with the prompt and the notes that a
semantic `llmos memory search` finds (through the llmOS service when it
runs), merges them, and caches them for the session. `prefetch` hands that
block to the next turn once.

The project comes from the session's folder, by Hermes's own order: the
`cwd` that `initialize()` receives, else the profile's `TERMINAL_CWD`. A
folder in a vault project's repository uses that project; anything else
uses `personal`. (`agent_workspace` is a fixed label, not a folder.)

Standard library only. Every binding lives on the instance, because one
gateway process can serve several profiles.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
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
# EmbeddingGemma cosine scores: related memories scored 0.70 to 0.76, unrelated
# ones 0.30 to 0.49. Without a floor every note in scope comes back.
SEMANTIC_FLOOR = 0.6
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
    ranked = sorted(score, key=lambda path: -score[path])[:RECALL_LIMIT]
    return [{"path": path} for path in ranked]


def _merge(*rankings: list[Any], limit: int) -> list[str]:
    """Paths by reciprocal rank fusion: word-match and cosine scores do not compare."""
    scores: dict[str, float] = {}
    for hits in rankings:
        for rank, hit in enumerate(hits):
            path = hit.get("path") if isinstance(hit, dict) else None
            if isinstance(path, str):
                scores[path] = scores.get(path, 0.0) + 1.0 / (60 + rank)
    return sorted(scores, key=lambda path: -scores[path])[:limit]


class LlmosMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._scope: dict[str, Any] | None = None
        self._writes = False
        self._lock = threading.Lock()
        # session_id -> (generation, block, count); a newer recall wins.
        self._recalled: dict[str, tuple[int, str, int]] = {}
        self._generation = 0
        self._last_count = 0

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

    def _recall(self, query: str, session_id: str, generation: int) -> None:
        scope = self._scope
        if scope is None:
            return
        # index_path is the vault root joined with the vault-relative index.
        root = Path(str(scope["index_path"])[: -len(str(scope["index"]))])
        notes_by_path = {}
        # Sorted, so `_keyword` breaks score ties by path, not by the order the
        # file system lists the folder in.
        for note in sorted((root / str(scope["dir"])).glob("*.md")):
            if note.name != "MEMORY.md":
                try:
                    text = note.read_text(encoding="utf-8")
                    notes_by_path[f"{scope['dir']}/{note.name}"] = _note(text)
                except OSError:
                    continue
        text = _query(query)
        hits, error = self._llmos(
            "memory", "search", "--project", str(scope["project"]),
            "--limit", str(RECALL_LIMIT), "--", text,
        )
        if error is not None:
            LOG.debug("llmos memory recall: %s", error)
        semantic = [
            hit for hit in (hits if isinstance(hits, list) else [])
            if isinstance(hit, dict) and isinstance(hit.get("score"), (int, float))
            and hit["score"] >= SEMANTIC_FLOOR
        ]
        notes = []
        for path in _merge(_keyword(text, notes_by_path), semantic, limit=RECALL_LIMIT):
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
