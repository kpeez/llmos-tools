#!/usr/bin/env bun
/**
 * Verification harness for the llmOS tools: the `llmos` CLI, its MCP
 * server, and the hook bundle. Every drive runs against a scratch copy of a
 * fixture vault, with qmd isolated in a temporary home. It never touches the
 * real vault in `llmOS/`.
 *
 *   bun scripts/verify.ts launch             make a run folder and scratch state
 *   bun scripts/verify.ts doctor             read-only check of the latest run
 *   bun scripts/verify.ts drive [feature..]  drive features (default: all)
 *   bun scripts/verify.ts cleanup            remove scratch state, keep evidence
 *   bun scripts/verify.ts run [feature..]    launch, doctor, drive, cleanup
 *
 * Features: read-search, writes, claims-lint, source-capture, hooks, memory, mcp, service.
 * Evidence goes to <repo>/artifacts/verify-llmos/<timestamp>/.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpClient } from "../../../../cli/test/mcp-client.ts";

const SKILL = resolve(import.meta.dir, "..");
const REPO = resolve(SKILL, "../../..");
const CLI = join(REPO, "cli");
const FIXTURES = join(CLI, "test", "fixtures");
const BUNDLE = join(REPO, "dist", "hooks.js");
const HOT_BUNDLE = join(REPO, "dist", "pre-tool-use.js");
const EVIDENCE_ROOT = join(REPO, "artifacts", "verify-llmos");
const BUN_FLAGS = ["--no-env-file", "--config=/dev/null"];

interface State {
  run: string;
  scratch: string;
  vault: string;
  claims: string;
  realVaultStatus: string;
}

interface Outcome {
  code: number;
  out: string;
  err: string;
}

interface Check {
  feature: string;
  name: string;
  ok: boolean;
  detail: string;
}

function fail(message: string): never {
  console.error(`verify-llmos: ${message}`);
  process.exit(1);
}

function latestRun(): string {
  const argIndex = process.argv.indexOf("--run");
  if (argIndex >= 0) return resolve(process.argv[argIndex + 1] ?? fail("--run needs a folder"));
  const runs = existsSync(EVIDENCE_ROOT)
    ? readdirSync(EVIDENCE_ROOT)
        .filter((name) => existsSync(join(EVIDENCE_ROOT, name, "state.json")))
        .sort()
    : [];
  const last = runs.at(-1);
  return last ? join(EVIDENCE_ROOT, last) : fail("no run found; run `launch` first");
}

function loadState(): State {
  return JSON.parse(readFileSync(join(latestRun(), "state.json"), "utf8")) as State;
}

/** The environment of every child: qmd and HOME stay inside the scratch folder. */
function childEnv(state: State): Record<string, string> {
  const home = join(state.scratch, "home");
  return {
    HOME: home,
    // Only bun and the system tools: no obsidian-cli, so Obsidian verbs exit 3.
    PATH: `${join(state.scratch, "bin")}:/usr/bin:/bin`,
    TMPDIR: join(state.scratch, "tmp"),
    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    LLMOS_ROOT: state.vault,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    INDEX_PATH: join(home, ".cache", "qmd", "index.sqlite"),
    QMD_CONFIG_DIR: join(home, ".config", "qmd"),
    // No background service, except in the `service` feature.
    LLMOS_SERVICE: "off",
  };
}

function realVaultStatus(): string {
  const result = spawnSync("git", ["status", "--porcelain", "--", "llmOS"], {
    cwd: REPO,
    encoding: "utf8",
  });
  return result.stdout;
}

// ---------------------------------------------------------------- recording

const checks: Check[] = [];
const counters = new Map<string, number>();

/** Run `argv`, save command, exit code, and output as evidence, and return them. */
function record(
  state: State,
  feature: string,
  label: string,
  argv: string[],
  options: { stdin?: string; env?: Record<string, string>; cwd?: string } = {},
): Outcome {
  const result = spawnSync(argv[0] as string, argv.slice(1), {
    cwd: options.cwd ?? CLI,
    env: options.env ?? childEnv(state),
    input: options.stdin,
    encoding: "utf8",
    timeout: 120_000,
  });
  const outcome = { code: result.status ?? -1, out: result.stdout, err: result.stderr };
  save(state, feature, label, argv.join(" "), outcome, options.stdin);
  return outcome;
}

function save(
  state: State,
  feature: string,
  label: string,
  command: string,
  outcome: Outcome,
  stdin?: string,
): void {
  const folder = join(state.run, feature);
  mkdirSync(folder, { recursive: true });
  const n = (counters.get(feature) ?? 0) + 1;
  counters.set(feature, n);
  const text = [
    `$ ${command.replaceAll(state.scratch, "$SCRATCH")}`,
    stdin === undefined ? "" : `stdin: ${stdin}`,
    `exit: ${outcome.code}`,
    "--- stdout",
    outcome.out,
    "--- stderr",
    outcome.err,
  ].join("\n");
  writeFileSync(
    join(folder, `${String(n).padStart(2, "0")}-${label}.txt`),
    text.replaceAll(state.scratch, "$SCRATCH"),
  );
}

function check(feature: string, name: string, ok: boolean, detail = ""): void {
  checks.push({ feature, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${feature}: ${name}${ok || !detail ? "" : ` (${detail})`}`);
}

const vault = (...argv: string[]): string[] => [
  process.execPath,
  ...BUN_FLAGS,
  join(CLI, "bin", "llmos.ts"),
  ...argv,
];

// ---------------------------------------------------------------- launch

function launch(): State {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..*/, "");
  const run = join(EVIDENCE_ROOT, stamp);
  mkdirSync(run, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "verify-llmos-")));
  const state: State = {
    run,
    scratch,
    vault: join(scratch, "vault"),
    claims: join(scratch, "claims"),
    realVaultStatus: realVaultStatus(),
  };
  cpSync(join(FIXTURES, "vault"), state.vault, { recursive: true });
  cpSync(join(FIXTURES, "claims_vault"), state.claims, { recursive: true });
  for (const dir of ["home/.cache/qmd", "home/.config/qmd", "tmp", "bin"]) {
    mkdirSync(join(scratch, dir), { recursive: true });
  }
  symlinkSync(process.execPath, join(scratch, "bin", "bun"));
  writeFileSync(join(run, "state.json"), JSON.stringify(state, null, 2));
  const add = record(state, "launch", "qmd-collection-add", [
    process.execPath,
    ...BUN_FLAGS,
    join(CLI, "bin", "qmd.ts"),
    "collection",
    "add",
    state.vault,
    "--name",
    "llmos",
  ]);
  if (add.code !== 0) fail(`qmd collection add failed: ${add.err}`);
  console.log(`launched: evidence ${run}\n          scratch  ${scratch}`);
  return state;
}

// ---------------------------------------------------------------- doctor

function doctor(state: State): boolean {
  const problems: string[] = [];
  if (!process.versions.bun?.startsWith("1.4.")) problems.push(`bun ${process.versions.bun}`);
  for (const path of [state.vault, state.claims, BUNDLE, HOT_BUNDLE, join(CLI, "node_modules")]) {
    if (!existsSync(path)) problems.push(`missing ${path}`);
  }
  if (state.vault.startsWith(join(REPO, "llmOS"))) problems.push("scratch vault is the real vault");
  const env = childEnv(state);
  if (!env.INDEX_PATH?.startsWith(state.scratch)) problems.push("qmd index is not isolated");
  if (realVaultStatus() !== state.realVaultStatus) problems.push("the real vault changed");
  const read = spawnSync(process.execPath, vault("read", "notes/alpha.md").slice(1), {
    cwd: CLI,
    env,
    encoding: "utf8",
  });
  if (read.status !== 0) problems.push(`llmos read exits ${read.status}: ${read.stderr}`);
  const hasObsidian = spawnSync("sh", ["-c", "command -v obsidian-cli"], { env }).status === 0;
  console.log(`obsidian-cli on the child PATH: ${hasObsidian ? "yes (unexpected)" : "no"}`);
  console.log(problems.length ? `DOCTOR FAIL: ${problems.join("; ")}` : "DOCTOR OK");
  return problems.length === 0;
}

// ---------------------------------------------------------------- features

type Feature = (state: State) => Promise<void> | void;

const readSearch: Feature = (state) => {
  const f = "read-search";
  const read = record(state, f, "read", vault("read", "notes/alpha.md"));
  const note = JSON.parse(read.out);
  check(f, "read returns the topics property", note.properties?.topics?.[0] === "gardening");
  const list = record(state, f, "list", vault("list"));
  check(
    f,
    "list exits 0 and names every fixture note",
    list.code === 0 && list.out.includes("beta"),
  );
  const neighbors = record(state, f, "neighbors", vault("neighbors", "alpha"));
  check(
    f,
    "neighbors shows the link to beta",
    neighbors.code === 0 && neighbors.out.includes("beta"),
  );
  const health = record(state, f, "health", vault("health"));
  check(f, "health runs", health.code === 0 || health.code === 1, `exit ${health.code}`);
  const reindex = record(state, f, "reindex", vault("reindex", "--no-embed"));
  check(
    f,
    "reindex --no-embed sees the notes (launch already scanned them)",
    reindex.code === 0 && /"(indexed|unchanged)": [1-9]/.test(reindex.out),
  );
  const search = record(state, f, "search-keyword", vault("search", "gardening"));
  const paths =
    search.code === 0 ? (JSON.parse(search.out) as { path: string }[]).map((r) => r.path) : [];
  check(
    f,
    "keyword search finds alpha, beta, and gamma",
    ["alpha", "beta", "gamma"].every((n) => paths.includes(`notes/${n}.md`)),
    paths.join(","),
  );
};

const writes: Feature = (state) => {
  const f = "writes";
  const created = record(state, f, "create", vault("create", "notes/new", "--content", "hello"));
  check(
    f,
    "create writes the note",
    created.code === 0 && readFileSync(join(state.vault, "notes/new.md"), "utf8").includes("hello"),
  );
  const again = record(state, f, "create-existing", vault("create", "notes/new", "--content", "x"));
  check(f, "create refuses an existing note", again.code !== 0);
  const outsideVault = record(
    state,
    f,
    "create-escape",
    vault("create", "../../escape", "--content", "x"),
  );
  check(
    f,
    "create refuses a path outside the vault",
    outsideVault.code === 1 && !existsSync(join(state.scratch, "escape.md")),
    `exit ${outsideVault.code}`,
  );
  const set = record(
    state,
    f,
    "set-property",
    vault("set-property", "notes/new", "status", "active"),
  );
  const afterSet = readFileSync(join(state.vault, "notes/new.md"), "utf8");
  check(
    f,
    "set-property writes the frontmatter",
    set.code === 0 && afterSet.includes("status: active"),
  );
  const created2 = record(
    state,
    f,
    "set-created",
    vault("set-property", "notes/alpha", "created", "2000-01-01"),
  );
  check(
    f,
    "set-property refuses the immutable created property",
    created2.code !== 0 &&
      readFileSync(join(state.vault, "notes/alpha.md"), "utf8").includes("2026-07-01"),
  );
  const append = record(state, f, "append", vault("append", "notes/new", "tail line"));
  check(
    f,
    "append adds to the end",
    append.code === 0 &&
      readFileSync(join(state.vault, "notes/new.md"), "utf8").trimEnd().endsWith("tail line"),
  );
  const remove = record(
    state,
    f,
    "remove-property",
    vault("remove-property", "notes/new", "status"),
  );
  check(
    f,
    "remove-property drops the key",
    remove.code === 0 &&
      !readFileSync(join(state.vault, "notes/new.md"), "utf8").includes("status:"),
  );
  const symlinkTarget = join(state.scratch, "outside.md");
  writeFileSync(symlinkTarget, "---\nstatus: draft\n---\n\noutside\n");
  symlinkSync(symlinkTarget, join(state.vault, "notes/link.md"));
  const linked = record(
    state,
    f,
    "set-property-symlink-escape",
    vault("set-property", "notes/link", "status", "pwned"),
  );
  check(
    f,
    "set-property refuses a note that links outside the vault",
    linked.code !== 0 && readFileSync(symlinkTarget, "utf8").includes("draft"),
    `exit ${linked.code}`,
  );
  const move = record(state, f, "move-needs-obsidian", vault("move", "alpha", "notes/z.md"));
  check(
    f,
    "move exits 3 without Obsidian (verified-unreachable)",
    move.code === 3,
    `exit ${move.code}`,
  );
  const tpl = record(
    state,
    f,
    "create-template-needs-obsidian",
    vault("create", "notes/t", "--template", "project"),
  );
  check(
    f,
    "create --template exits 3 without Obsidian (verified-unreachable)",
    tpl.code === 3,
    `exit ${tpl.code}`,
  );
};

const claimsLint: Feature = (state) => {
  const f = "claims-lint";
  const lint = (note: string) =>
    record(state, f, note, vault("claims", "lint", `knowledge/${note}`, "--json"), {
      env: { ...childEnv(state), LLMOS_ROOT: state.claims },
    });
  const good = lint("all-correct");
  check(f, "all-correct exits 0", good.code === 0, `exit ${good.code}`);
  for (const [note, code] of [
    ["wrong-number", "number-not-in-quote"],
    ["quote-absent", "quote-not-in-source"],
    ["wrong-section", "quote-not-in-section"],
  ] as const) {
    const result = lint(note);
    check(
      f,
      `${note} exits 1 with a finding`,
      result.code === 1 && result.out.includes('"code"'),
      result.out.match(/"code": "[^"]+"/)?.[0] ?? `exit ${result.code}; expected like ${code}`,
    );
  }
};

const sourceCapture: Feature = (state) => {
  const f = "source-capture";
  const result = record(state, f, "arxiv-replayed", [
    process.execPath,
    ...BUN_FLAGS,
    join(SKILL, "scripts", "source-offline.ts"),
    state.vault,
    "1811.00743",
  ]);
  const folder = join(state.vault, "raw", "arxiv-1811.00743v2");
  check(
    f,
    "capture exits 0 and prints Captured",
    result.code === 0 && result.out.startsWith("Captured: arxiv:1811.00743v2"),
    result.out,
  );
  const manifest = existsSync(join(folder, "source.md"))
    ? readFileSync(join(folder, "source.md"), "utf8")
    : "";
  check(
    f,
    "source.md holds the manifest",
    manifest.includes("source_id: arxiv:1811.00743v2") && manifest.includes("sha256_raw"),
  );
  check(
    f,
    "raw.html and assets/ exist",
    existsSync(join(folder, "raw.html")) && existsSync(join(folder, "assets")),
  );
  const again = record(state, f, "arxiv-again", [
    process.execPath,
    ...BUN_FLAGS,
    join(SKILL, "scripts", "source-offline.ts"),
    state.vault,
    "1811.00743",
  ]);
  check(
    f,
    "a second capture changes nothing and exits 0",
    again.code === 0 && /already/i.test(again.out),
    again.out,
  );
  const refuse = record(
    state,
    f,
    "local-url-refused",
    vault("source", "add", "http://127.0.0.1:9/x"),
  );
  check(
    f,
    "a local URL is refused before any request",
    refuse.code !== 0 && /IP address|public|blocked|local|private/i.test(refuse.err + refuse.out),
    refuse.err,
  );
};

const hooks: Feature = (state) => {
  const f = "hooks";
  const run = (label: string, event: string, payload: unknown) =>
    record(
      state,
      f,
      label,
      [
        process.execPath,
        ...BUN_FLAGS,
        event === "pre-tool-use" || event === "guard-bash" ? HOT_BUNDLE : BUNDLE,
        event,
      ],
      {
        stdin: JSON.stringify(payload),
        cwd: state.scratch,
        // Claude Code sets CLAUDECODE; the hook heartbeat names the agent from it.
        env: { ...childEnv(state), CLAUDECODE: "1" },
      },
    );
  const alpha = join(state.vault, "notes", "alpha.md");
  const start = run("session-start", "session-start", { cwd: state.vault, session_id: "verify" });
  check(
    f,
    "session-start prints the vault root and AGENTS.md",
    start.code === 0 && start.out.includes(`llmOS root: ${state.vault}`),
  );
  const outside = run("session-start-outside", "session-start", {
    cwd: state.scratch,
    session_id: "verify",
  });
  check(f, "session-start is silent outside the vault", outside.code === 0 && outside.out === "");
  const pre = run("pre-tool-use-read", "pre-tool-use", {
    tool_name: "Read",
    session_id: "verify",
    cwd: state.vault,
    tool_input: { file_path: alpha },
  });
  check(
    f,
    "pre-tool-use adds context for a vault note",
    pre.code === 0 &&
      JSON.parse(pre.out).hookSpecificOutput?.additionalContext?.includes("Obsidian vault note"),
  );
  const mv = run("guard-raw-mv", "pre-tool-use", {
    tool_name: "Bash",
    cwd: state.vault,
    tool_input: { command: `mv ${alpha} /tmp/x.md` },
  });
  check(
    f,
    "pre-tool-use on a Bash call denies a raw mv of a vault note (exit 2)",
    mv.code === 2 && mv.err.includes("obsidian-cli move"),
    `exit ${mv.code}`,
  );
  const bare = run("guard-obsidian-cli", "pre-tool-use", {
    tool_name: "Bash",
    tool_input: { command: "obsidian-cli read" },
  });
  check(
    f,
    "pre-tool-use on a Bash call denies obsidian-cli read without a target (exit 2)",
    bare.code === 2 && bare.err.includes("file="),
  );
  const fine = run("guard-allowed", "pre-tool-use", {
    tool_name: "Bash",
    cwd: state.vault,
    tool_input: { command: "ls" },
  });
  check(f, "pre-tool-use allows a Bash ls (exit 0, silent)", fine.code === 0 && fine.err === "");
  const direct = run("guard-bash-event", "guard-bash", {
    tool_name: "Bash",
    cwd: state.vault,
    tool_input: { command: `mv ${alpha} /tmp/x.md` },
  });
  check(
    f,
    "the guard-bash event, which Hermes runs, denies a raw mv of a vault note (exit 2)",
    direct.code === 2 && direct.err.includes("obsidian-cli move"),
    `exit ${direct.code}`,
  );
  const post = run("post-tool-use-stamp", "post-tool-use", {
    tool_name: "Write",
    session_id: "verify",
    cwd: state.vault,
    tool_input: { file_path: alpha, content: "x" },
  });
  const stamped = readFileSync(alpha, "utf8");
  check(
    f,
    "post-tool-use stamps updated on the note",
    post.code === 0 && /updated: \d{4}-\d\d-\d\d/.test(stamped),
  );
};

const mcp: Feature = async (state) => {
  const f = "mcp";
  const argv = [process.execPath, ...BUN_FLAGS, join(CLI, "bin", "llmos.ts"), "mcp"];
  const child = Bun.spawn(argv, {
    cwd: CLI,
    env: childEnv(state),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = new McpClient((line) => {
    child.stdin.write(line);
    child.stdin.flush();
  }, child.stdout);
  const log: string[] = [];
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const init = await client.initialize("claude-code");
    log.push(`initialize: ${JSON.stringify(init)}`);
    const names = (await client.tools()).map((t) => t.name as string);
    log.push(`tools: ${names.join(", ")}`);
    check(
      f,
      "tools/list names the read, search, memory, and write tools",
      ["read", "list", "search", "memory_save", "set_property", "daily_append_thought"].every((n) =>
        names.includes(n),
      ),
      names.join(","),
    );
    check(
      f,
      "no shell, move, or create tool is served",
      !names.some((n) => /^(bash|shell|exec|move|create)$/.test(n)),
    );
    const call = async (name: string, args: unknown) => {
      const result = await client.call(name, args);
      log.push(
        `call ${name} ${JSON.stringify(args)} -> isError=${result.isError} ${result.text.slice(0, 400)}`,
      );
      return result;
    };
    const read = await call("read", { note: "notes/alpha.md" });
    check(f, "read tool returns the note", !read.isError && read.text.includes("gardening"));
    const search = await call("search", { query: "gardening" });
    check(
      f,
      "search tool finds notes (after reindex)",
      !search.isError && search.text.includes("notes/beta.md"),
      search.text.slice(0, 120),
    );
    const set = await call("set_property", {
      note: "notes/beta.md",
      key: "status",
      value: "active",
    });
    const beta = readFileSync(join(state.vault, "notes", "beta.md"), "utf8");
    check(
      f,
      "set_property writes and stamps updated",
      !set.isError && beta.includes("status: active") && /updated: \d{4}/.test(beta),
    );
    const thought = await call("daily_append_thought", { text: "Verified the thought tool." });
    check(
      f,
      "daily_append_thought errors without Obsidian (verified-unreachable)",
      thought.isError && thought.text.includes("obsidian-cli"),
      thought.text.slice(0, 120),
    );
    const outsideVault = await call("read", { note: "../../etc/passwd" });
    check(f, "read refuses a path outside the vault", outsideVault.isError);
    const outside = await call("set_property", {
      note: "notes/link.md",
      key: "status",
      value: "pwned",
    });
    check(f, "set_property refuses a note linked outside the vault", outside.isError);
    const remembered = await call("memory_save", {
      name: "tank-heater",
      description: "The tank heater setting",
      body: "Set the tank heater to 26 C.",
      type: "project",
      project: "verify",
    });
    check(
      f,
      "memory_save writes a memory note",
      !remembered.isError &&
        existsSync(join(state.vault, "projects", "verify", "memory", "tank-heater.md")),
      remembered.text.slice(0, 120),
    );
    const forgotten = await call("memory_forget", { name: "tank-heater", project: "verify" });
    check(
      f,
      "memory_forget deletes it",
      !forgotten.isError &&
        !existsSync(join(state.vault, "projects", "verify", "memory", "tank-heater.md")),
    );
    const memoryEscape = await call("memory_save", {
      name: "x",
      description: "d",
      body: "b",
      type: "project",
      project: "..",
    });
    check(f, "memory_save refuses a project outside projects/", memoryEscape.isError);
    const extra = await call("read", { note: "notes/alpha.md", shell: "id" });
    check(f, "an unknown argument is refused", extra.isError);
    const inbox = await call("file_inbox", { note: "notes/alpha.md", destination: "notes/z.md" });
    check(
      f,
      "file_inbox errors without Obsidian (verified-unreachable)",
      inbox.isError,
      inbox.text.slice(0, 120),
    );
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    child.kill();
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    log.push(`server stderr: ${stderr}`);
    mkdirSync(join(state.run, f), { recursive: true });
    writeFileSync(
      join(state.run, f, "01-transcript.txt"),
      log.join("\n").replaceAll(state.scratch, "$SCRATCH"),
    );
  }
};

const memory: Feature = (state) => {
  const f = "memory";
  mkdirSync(join(state.vault, "projects", "verify"), { recursive: true });
  const dir = join(state.vault, "projects", "verify", "memory");
  const scope = record(state, f, "scope", vault("memory", "scope", "--project", "verify"));
  check(
    f,
    "memory scope names the project's index",
    scope.code === 0 && JSON.parse(scope.out).index === "projects/verify/memory/MEMORY.md",
    scope.err,
  );
  const saveArgs = (body: string) =>
    vault("memory", "save", "garden-soil", "Soil for the garden beds", body, "--project", "verify");
  const saved = record(state, f, "save", [...saveArgs("Use loam with compost."), "--type", "project"]);
  const note = () => readFileSync(join(dir, "garden-soil.md"), "utf8");
  const index = () => readFileSync(join(dir, "MEMORY.md"), "utf8");
  check(
    f,
    "save writes the topic note and its index line",
    saved.code === 0 &&
      note().includes("node_type: memory") &&
      index().includes("- [Garden soil](garden-soil.md) — Soil for the garden beds"),
    saved.err,
  );
  const again = record(state, f, "save-again", saveArgs("Use sandy loam."));
  check(
    f,
    "saving again replaces the body and keeps one index line",
    again.code === 0 &&
      note().includes("sandy loam") &&
      index().split("garden-soil.md").length === 2,
    again.err,
  );
  record(state, f, "reindex", vault("reindex", "--no-embed"));
  const search = record(
    state,
    f,
    "search-keyword",
    vault("memory", "search", "loam", "--keyword", "--project", "verify"),
  );
  check(
    f,
    "memory search finds the memory and nothing outside the folder",
    search.code === 0 &&
      JSON.stringify((JSON.parse(search.out) as { path: string }[]).map((h) => h.path)) ===
        JSON.stringify(["projects/verify/memory/garden-soil.md"]),
    search.out.slice(0, 200),
  );
  const escape = record(
    state,
    f,
    "save-escape",
    vault("memory", "save", "x", "d", "b", "--project", ".."),
  );
  check(f, "a project outside projects/ is refused", escape.code === 1, `exit ${escape.code}`);
  const forget = record(
    state,
    f,
    "forget",
    vault("memory", "forget", "garden-soil", "--project", "verify"),
  );
  check(
    f,
    "forget removes the note and its index line",
    forget.code === 0 && !existsSync(join(dir, "garden-soil.md")) && !index().includes("garden-soil"),
    forget.err,
  );
};

const service: Feature = async (state) => {
  const f = "service";
  // A short state folder: a Unix socket path has a length limit.
  const stateDir = join(state.scratch, "st");
  const env = { ...childEnv(state), LLMOS_SERVICE: "on", XDG_STATE_HOME: stateDir };
  const llmos = (...argv: string[]) => record(state, f, argv.join("-"), vault(...argv), { env });
  const status = () => JSON.parse(llmos("service", "status").out) as Record<string, any>;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const waitRunning = async () => {
    for (let i = 0; i < 100; i++) {
      if (status().running) return true;
      await sleep(100);
    }
    return false;
  };
  const stop = () => {
    const found = status();
    if (found.running) process.kill(found.pid, "SIGTERM");
  };
  stop();
  check(f, "service status says no service runs at first", status().running === false);

  const child = Bun.spawn([process.execPath, ...BUN_FLAGS, join(CLI, "bin", "llmos.ts"), "mcp"], {
    cwd: CLI,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const client = new McpClient((line) => {
    child.stdin.write(line);
    child.stdin.flush();
  }, child.stdout);
  const log: string[] = [];
  const timeout = setTimeout(() => child.kill(), 90_000);
  try {
    await client.initialize("claude-code");
    const first = await client.call("search", { query: "gardening" });
    log.push(`first search: ${first.text.slice(0, 200)}`);
    check(f, "the first search works while no service runs", !first.isError && first.text.includes("notes/beta.md"));
    check(f, "that search started the service", await waitRunning());
    const up = status();
    const socket = join(stateDir, "llmos", "service.sock");
    check(
      f,
      "the folder is mode 0700 and the socket mode 0600",
      (statSync(join(stateDir, "llmos")).mode & 0o777) === 0o700 &&
        (statSync(socket).mode & 0o777) === 0o600,
    );
    const second = await client.call("search", { query: "gardening" });
    check(
      f,
      "the next search is answered by the service",
      !second.isError && second.text.includes("notes/beta.md") && status().requests > up.requests,
      `requests ${up.requests} -> ${status().requests}`,
    );
    const viaCli = llmos("search", "gardening");
    check(f, "the search verb uses the running service", viaCli.code === 0 && status().requests > up.requests + 1);

    const again = record(state, f, "serve-again", vault("service", "serve"), { env });
    check(
      f,
      "a second service serve exits 0 and leaves the first running",
      again.code === 0 && again.out.includes("already listens") && status().pid === up.pid,
      again.out + again.err,
    );

    mkdirSync(join(state.vault, "projects", "verify"), { recursive: true });
    const saved = llmos("memory", "save", "pump-notes", "Notes on the pump", "The sump pump hums.", "--project", "verify", "--type", "project");
    const found = llmos("memory", "search", "sump", "--keyword", "--project", "verify");
    check(
      f,
      "a memory saved with the service up is found by keyword search at once",
      saved.code === 0 && found.out.includes("projects/verify/memory/pump-notes.md"),
      `save exit ${saved.code}: ${saved.err.slice(0, 120)} | search: ${found.out.slice(0, 160)}`,
    );
    llmos("memory", "forget", "pump-notes", "--project", "verify");

    stop();
    for (let i = 0; i < 50 && status().running; i++) await sleep(100);
    check(f, "the service stops on SIGTERM and removes its socket", !status().running && !existsSync(socket));
    const down = await client.call("search", { query: "gardening" });
    check(
      f,
      "llmos mcp still searches with the service down",
      !down.isError && down.text.includes("notes/beta.md"),
      down.text.slice(0, 160),
    );
    const bad = await client.call("search", { query: "gardening", collection: "xbrain" });
    check(f, "an unknown argument is still refused", bad.isError);
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    child.kill();
    await child.exited;
    // The search with the service down starts a new service, detached, which
    // binds a moment later: wait for it, so no service outlives the scratch folder.
    for (let i = 0; i < 30; i++) {
      stop();
      await sleep(100);
      if (i >= 20 && !status().running) break;
    }
    check(f, "no service is left running after the feature", !status().running);
    writeFileSync(join(state.run, f, "01-notes.txt"), log.join("\n").replaceAll(state.scratch, "$SCRATCH"));
  }
};

const FEATURES: Record<string, Feature> = {
  "read-search": readSearch,
  writes,
  "claims-lint": claimsLint,
  "source-capture": sourceCapture,
  hooks,
  memory,
  mcp,
  service,
};

async function drive(state: State, names: string[]): Promise<boolean> {
  const chosen = names.length ? names : Object.keys(FEATURES);
  for (const name of chosen) {
    if (!FEATURES[name])
      fail(`unknown feature ${name}; choose from ${Object.keys(FEATURES).join(", ")}`);
  }
  for (const name of chosen) {
    if (!doctor(state)) fail("doctor failed; not driving");
    await (FEATURES[name] as Feature)(state);
  }
  const untouched = realVaultStatus() === state.realVaultStatus;
  check("all", "the real vault is unchanged", untouched);
  writeFileSync(join(state.run, "results.json"), JSON.stringify(checks, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `${checks.length - failed.length}/${checks.length} checks passed; results ${join(state.run, "results.json")}`,
  );
  return failed.length === 0;
}

// ---------------------------------------------------------------- cleanup

function cleanup(state: State): void {
  // Only the scratch folder this run made. Evidence stays in state.run.
  if (!state.scratch.includes("verify-llmos-")) fail(`refusing to remove ${state.scratch}`);
  rmSync(state.scratch, { recursive: true, force: true });
  console.log(`cleaned ${state.scratch}; evidence kept in ${state.run}`);
}

// ---------------------------------------------------------------- main

const [command, ...rest] = process.argv
  .slice(2)
  .filter((a, i, all) => a !== "--run" && all[i - 1] !== "--run");
let ok = true;
switch (command) {
  case "launch":
    launch();
    break;
  case "doctor":
    ok = doctor(loadState());
    break;
  case "drive":
    ok = await drive(loadState(), rest);
    break;
  case "cleanup":
    cleanup(loadState());
    break;
  case "run": {
    const state = launch();
    try {
      ok = doctor(state) && (await drive(state, rest));
    } finally {
      cleanup(state);
    }
    break;
  }
  default:
    console.error(
      "usage: verify.ts launch|doctor|drive [feature..]|cleanup|run [feature..] [--run DIR]",
    );
    process.exit(2);
}
process.exit(ok ? 0 : 1);
