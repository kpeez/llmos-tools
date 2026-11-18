"""Hermes Agent adapter for the llmOS plugin hooks (`../dist/hooks.js`).

Hermes loads this folder as the `llmos` plugin from `~/.hermes/plugins/llmos`,
a symbolic link to it. Each Hermes hook builds the payload the bundle reads
for Claude Code, runs `bun dist/hooks.js <event>`, and maps the output back:

- `pre_llm_call` on a session's first turn runs `session-start`; its stdout
  becomes context for that turn.
- `pre_tool_call` on `terminal` runs `guard-bash`; exit 2 blocks the call.
- `transform_tool_result` on a file tool that names a vault path runs
  `pre-tool-use` after a read and `post-tool-use` (the stamp) after a write,
  and appends the context they return to the tool result. Hermes has no
  channel for context before a tool runs, so the authoring contract that
  Claude gets before a write is not sent; the `maintain-llmos` skill carries it.
- `on_session_end` (the end of every turn) starts `stop` in the background.
- `pre_verify`, after the agent edited files, sends it back to commit and push
  the vault notes it changed this turn, at most twice.

Every failure returns None: a raised error or a timeout in `pre_tool_call`
would make Hermes block the tool call.
"""

from __future__ import annotations

import functools
import json
import logging
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

LOG = logging.getLogger(__name__)

# The plugin root the heartbeat records; `llmos-doctor` looks for the plugin here.
PLUGIN_ROOT = Path.home() / ".hermes" / "plugins" / "llmos"
BUNDLE = Path(__file__).resolve().parent.parent / "dist" / "hooks.js"
CONFIG = Path.home() / ".config" / "llmos" / "config.json"
# Under Hermes's 30 s plugin-callback limit, past which pre_tool_call fails closed.
TIMEOUT_SECONDS = 10

READ_TOOLS = {"read_file": "Read", "search_files": "Grep"}
WRITE_TOOLS = {"write_file": "Write", "patch": "Edit"}


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


def _vault_root() -> Path | None:
    raw = os.environ.get("LLMOS_ROOT")
    if not raw:
        try:
            raw = json.loads(CONFIG.read_text())["vault_root"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
    try:
        return Path(str(raw)).expanduser().resolve(strict=True)
    except OSError:
        return None


def _session_cwd(task_id: Any) -> str | None:
    """The cwd Hermes recorded for the session, as its own file tools read it."""
    try:
        from tools.terminal_tool import get_session_cwd
    except ImportError:
        return None
    cwd = get_session_cwd(task_id or None)
    return cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None


def _cwd(task_id: Any = None, workdir: Any = None) -> str:
    """The folder relative paths resolve against: the call's `workdir`, the session's cwd,
    then the launch cwd. A wrong cwd would let the guard miss a relative vault path."""
    if isinstance(workdir, str) and os.path.isabs(workdir):
        return workdir
    return _session_cwd(task_id) or os.environ.get("TERMINAL_CWD") or os.getcwd()


def _in_vault(path: Any, task_id: Any = None) -> bool:
    root = _vault_root()
    if root is None or not isinstance(path, str) or not path:
        return False
    target = Path(path).expanduser()
    if not target.is_absolute():
        target = Path(_cwd(task_id)) / target
    try:
        target = target.resolve()
    except OSError:
        return False
    return target == root or root in target.parents


def _payload(
    session_id: Any,
    tool_name: str | None = None,
    tool_input: dict | None = None,
    cwd: str | None = None,
) -> dict:
    payload: dict[str, Any] = {
        "session_id": str(session_id or "hermes"),
        "cwd": cwd or _cwd(),
    }
    if tool_name is not None:
        payload["tool_name"] = tool_name
        payload["tool_input"] = tool_input or {}
    return payload


def _command(event: str) -> list[str] | None:
    bun = _bun()
    if bun is None or not BUNDLE.is_file():
        return None
    return [bun, "--no-env-file", "--config=/dev/null", str(BUNDLE), event]


def _env() -> dict[str, str]:
    return {**os.environ, "PLUGIN_ROOT": str(PLUGIN_ROOT)}


def _run(event: str, payload: dict) -> subprocess.CompletedProcess | None:
    command = _command(event)
    if command is None:
        return None
    try:
        return subprocess.run(
            command,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            env=_env(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _additional_context(stdout: str) -> str | None:
    try:
        data = json.loads(stdout)
    except ValueError:
        return None
    context = (data.get("hookSpecificOutput") or {}).get("additionalContext")
    return context if isinstance(context, str) and context.strip() else None


def _claude_tool(
    tool_name: str, args: dict, task_id: Any = None
) -> tuple[str, dict] | None:
    """The Claude Code tool name and input for a Hermes file tool."""
    if tool_name == "patch" and args.get("mode") == "patch":
        return "apply_patch", {"command": args.get("patch", "")}
    name = READ_TOOLS.get(tool_name) or WRITE_TOOLS.get(tool_name)
    if name is None or not _in_vault(args.get("path"), task_id):
        return None
    return name, {"path": args["path"]}


def _git(repo: str, *args: str) -> str | None:
    try:
        result = subprocess.run(
            [
                "git",
                "--literal-pathspecs",
                "-c",
                "core.quotePath=false",
                "-C",
                repo,
                *args,
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def _unshared_notes(paths: list, task_id: Any = None) -> list[str]:
    """Vault notes among `paths` that are uncommitted or committed but not pushed.

    Shared project memory (`projects/*/memory/`) is left out: the hooks sync it.
    A branch with no upstream skips the unpushed check.
    """
    root = _vault_root()
    if root is None:
        return []
    top = _git(str(root), "rev-parse", "--show-toplevel")
    if not top:
        return []
    top = top.strip()
    notes: list[str] = []
    for raw in paths:
        if not _in_vault(raw, task_id):
            continue
        target = Path(raw).expanduser()
        if not target.is_absolute():
            target = Path(_cwd(task_id)) / target
        parts = target.resolve().relative_to(root).parts
        if len(parts) > 2 and parts[0] == "projects" and parts[2] == "memory":
            continue
        notes.append(os.path.relpath(target.resolve(), top))
    if not notes:
        return []
    left: set[str] = set()
    # NUL-separated names: git quotes non-ASCII names in line output.
    for args in (
        ("diff", "-z", "--name-only", "HEAD", "--"),
        ("ls-files", "-z", "--others", "--exclude-standard", "--"),
        ("log", "-z", "--name-only", "--format=", "@{upstream}..HEAD", "--"),
    ):
        out = _git(top, *args, *notes)
        if out:
            left.update(
                name.strip("\n") for name in out.split("\0") if name.strip("\n")
            )
    return sorted(left & set(notes))


def _fail_open(hook: Callable[..., Any]) -> Callable[..., Any]:
    """Return None on any error: an error raised in pre_tool_call blocks the tool call."""

    @functools.wraps(hook)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return hook(*args, **kwargs)
        except Exception:
            LOG.debug("llmos hook %s failed", hook.__name__, exc_info=True)
            return None

    return wrapper


@_fail_open
def on_pre_llm_call(session_id=None, is_first_turn=False, task_id=None, **_: Any):
    if not is_first_turn:
        return None
    result = _run("session-start", _payload(session_id, cwd=_cwd(task_id)))
    text = result.stdout.strip() if result else ""
    return {"context": text} if text else None


@_fail_open
def on_pre_tool_call(
    tool_name=None, args=None, session_id=None, task_id=None, **_: Any
):
    if tool_name != "terminal" or not isinstance(args, dict) or not args.get("command"):
        return None
    cwd = _cwd(task_id, args.get("workdir"))
    result = _run(
        "guard-bash", _payload(session_id, "Bash", {"command": args["command"]}, cwd)
    )
    if result is None or result.returncode != 2:
        return None
    message = result.stderr.strip() or "Blocked by the llmOS vault guard."
    return {"action": "block", "message": message}


@_fail_open
def on_transform_tool_result(
    tool_name=None, args=None, result=None, session_id=None, task_id=None, **_: Any
):
    if not isinstance(args, dict) or not isinstance(result, str):
        return None
    mapped = _claude_tool(tool_name or "", args, task_id)
    if mapped is None:
        return None
    name, tool_input = mapped
    event = (
        "post-tool-use" if name in ("Write", "Edit", "apply_patch") else "pre-tool-use"
    )
    ran = _run(event, _payload(session_id, name, tool_input, _cwd(task_id)))
    context = _additional_context(ran.stdout) if ran else None
    return f"{result}\n\n[llmOS vault]\n{context}" if context else None


@_fail_open
def on_session_end(session_id=None, task_id=None, **_: Any):
    """Start `stop` without waiting: the reindex and memory sync can take seconds."""
    command = _command("stop")
    if command is None:
        return
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=_env(),
        start_new_session=True,
        text=True,
    )
    process.stdin.write(json.dumps(_payload(session_id, cwd=_cwd(task_id))))
    process.stdin.close()


# Hermes allows three nudges per turn; two are enough to commit and push.
MAX_COMMIT_NUDGES = 2


@_fail_open
def on_pre_verify(changed_paths=None, attempt=0, task_id=None, **_: Any):
    """Keep the agent going while vault notes it changed this turn are not pushed."""
    if attempt >= MAX_COMMIT_NUDGES or not isinstance(changed_paths, list):
        return None
    left = _unshared_notes(changed_paths, task_id)
    if not left:
        return None
    return {
        "action": "continue",
        "message": (
            "These llmOS vault notes you changed are not committed and pushed: "
            + ", ".join(left)
            + ". Commit only them, by path, and push to main, as your SOUL.md says. "
            "If you cannot, tell the user which notes are left and why."
        ),
    }


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("transform_tool_result", on_transform_tool_result)
    ctx.register_hook("pre_verify", on_pre_verify)
    ctx.register_hook("on_session_end", on_session_end)
