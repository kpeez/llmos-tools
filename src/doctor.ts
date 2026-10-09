/**
 * `llmos-doctor`: check the external prerequisites of the llmOS tools on
 * this host and print `PASS`/`FAIL` per check, with a `REPAIR` command after
 * each failure. Read-only. Exit 0 only when every check passes.
 *
 * The qmd checks read the index through the qmd SDK, the same way `search`
 * does. The `qmd` command on `PATH` must be exactly one, and it must be this
 * install's: two qmd versions would write the same `~/.cache/qmd` index.
 *
 * The hook checks read the heartbeat the session-start hook records
 * (`heartbeat.ts`), because a hook that cannot start fails silently. The
 * MCP check starts the server the plugin's launcher would start and lists
 * its tools (`mcp-check.ts`), because the launcher falls back to a setup
 * tool instead of failing.
 */

import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileSha256, heartbeatPath, readHeartbeats } from "./heartbeat.ts";
import { mcpCheck } from "./mcp-check.ts";
import { indexedPaths, openQmd, qmdLocation } from "./qmd.ts";

export type Env = Record<string, string | undefined>;

const TOOLS = resolve(import.meta.dir, "..");
/** The `qmd` command this install provides (`bin/qmd.ts`, linked as `~/.local/bin/qmd`). */
export const OWN_QMD = join(TOOLS, "bin", "qmd.ts");

const ROOT_REPAIR =
  'Run /setup-llmos, or set it manually: export LLMOS_ROOT="/absolute/path/to/llmos/llmOS"';
const INSTALL_REPAIR = "Run /setup-llmos to install the llmOS CLI, which provides qmd";

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Every executable named `name` on `PATH`, in `PATH` order. */
export function whichAll(name: string, path: string | undefined): string[] {
  const found: string[] = [];
  for (const folder of (path ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) found.push(candidate);
    } catch {
      // Not here.
    }
  }
  return found;
}

/** The llmOS root from `$LLMOS_ROOT` (an empty value counts as unset), then the config file. */
function configuredRoot(env: Env): string | null {
  let given = env.LLMOS_ROOT || "";
  if (!given) {
    const config = join(env.HOME || homedir(), ".config", "llmos", "config.json");
    try {
      const data: unknown = JSON.parse(readFileSync(config, "utf8"));
      const value = (data as { vault_root?: unknown } | null)?.vault_root;
      if (typeof value === "string") given = value;
    } catch {
      // No usable config.
    }
  }
  if (!given) return null;
  const home = env.HOME || homedir();
  const expanded = given === "~" || given.startsWith("~/") ? join(home, given.slice(1)) : given;
  return realOrSelf(resolve(expanded));
}

function run(argv: string[], env: Env): { code: number; output: string } {
  const seconds = Number(env.LLMOS_DOCTOR_TIMEOUT ?? "30");
  const result = Bun.spawnSync(argv, {
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    timeout: seconds * 1000,
  });
  if (result.exitedDueToTimeout) {
    return { code: 124, output: `${basename(argv[0] as string)} timed out after ${seconds}s` };
  }
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.replace(/\n+$/, "");
  return { code: result.exitCode ?? 1, output };
}

/** Run every check; returns the printed lines and the exit code. */
export async function doctor(env: Env): Promise<{ lines: string[]; exitCode: number }> {
  const lines: string[] = [];
  let failures = 0;
  const pass = (check: string, detail: string): void => {
    lines.push(`PASS ${check}: ${detail}`);
  };
  const fail = (check: string, detail: string, repair: string): void => {
    lines.push(`FAIL ${check}: ${detail}`, `REPAIR ${repair}`);
    failures++;
  };

  const system =
    env.LLMOS_DOCTOR_OS ??
    (process.platform === "darwin"
      ? "Darwin"
      : process.platform === "linux"
        ? "Linux"
        : process.platform);
  if (system !== "Darwin" && system !== "Linux") {
    return { lines: ["FAIL platform: setup-llmos supports macOS and Linux only"], exitCode: 1 };
  }
  const macos = system === "Darwin";
  const obsidianRepair = macos
    ? 'brew install --cask obsidian && ln -sfh "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli" "$(brew --prefix)/bin/obsidian-cli"'
    : 'sudo snap install obsidian --classic && mkdir -p "$HOME/.local/bin" && ln -sf /snap/obsidian/current/app/obsidian-cli "$HOME/.local/bin/obsidian-cli"';

  // vault-root
  const root = configuredRoot(env);
  let rootValid = false;
  if (root === null) {
    fail("vault-root", "llmOS root is not configured", ROOT_REPAIR);
  } else if (isDirectory(join(root, ".obsidian")) && isFile(join(root, "AGENTS.md"))) {
    rootValid = true;
    pass("vault-root", root);
  } else {
    fail("vault-root", `${root} is not an llmOS vault with .obsidian/ and AGENTS.md`, ROOT_REPAIR);
  }
  const sentinel =
    root !== null && isFile(join(root, "llmOS.md"))
      ? readFileSync(join(root, "llmOS.md"), "utf8")
      : null;

  // obsidian-cli and obsidian-vault
  const obsidianCli = whichAll("obsidian-cli", env.PATH)[0];
  if (obsidianCli) pass("obsidian-cli", obsidianCli);
  else fail("obsidian-cli", "command not found", obsidianRepair);
  if (obsidianCli && rootValid && root !== null) {
    const vaultName = basename(root);
    const { code, output } = run([obsidianCli, `vault=${vaultName}`, "read", "path=llmOS.md"], env);
    if (code === 0 && sentinel !== null && `${output}\n` === sentinel) {
      pass("obsidian-vault", "read canonical llmOS.md");
    } else {
      const detail =
        code === 0
          ? `llmOS.md content does not match ${root}/llmOS.md`
          : `Obsidian app or vault ${vaultName} is unavailable: ${output}`;
      fail("obsidian-vault", detail, macos ? `open -a Obsidian "${root}"` : `obsidian "${root}"`);
      if (!macos) lines.push("NOTE enable Settings > General > Advanced > Command line interface");
    }
  } else {
    fail(
      "obsidian-vault",
      "blocked by vault-root or obsidian-cli failure",
      rootValid ? obsidianRepair : ROOT_REPAIR,
    );
  }

  // qmd: exactly one on PATH, and it is this install's.
  const own = realOrSelf(OWN_QMD);
  const found = whichAll("qmd", env.PATH);
  const distinct = [...new Map(found.map((path) => [realOrSelf(path), path])).values()];
  if (distinct.length === 0) {
    fail("qmd", "command not found", INSTALL_REPAIR);
  } else if (distinct.length > 1) {
    fail(
      "qmd",
      `${distinct.length} different qmd commands on PATH (${distinct.join(", ")}); they would share one index`,
      `Remove every qmd except ${own}; for a global mise install, after the user approves: mise uninstall npm:@tobilu/qmd`,
    );
  } else if (realOrSelf(distinct[0] as string) !== own) {
    fail("qmd", `${distinct[0]} is not this install's qmd (${own})`, INSTALL_REPAIR);
  } else {
    const { code, output } = run([distinct[0] as string, "--version"], env);
    if (code === 0) pass("qmd", `${distinct[0]} (${output})`);
    else fail("qmd", `${distinct[0]} --version failed: ${output}`, INSTALL_REPAIR);
  }

  // qmd-collection, qmd-index, qmd-retrieval, through the SDK.
  const location = qmdLocation(env);
  let collectionRepair = rootValid ? `qmd collection add "${root}" --name llmos` : ROOT_REPAIR;
  let indexed = false;
  let retrieved = false;
  let collectionOk = false;
  if (!rootValid || root === null) {
    fail("qmd-collection", "blocked by vault-root failure", ROOT_REPAIR);
  } else if (!existsSync(location.dbPath)) {
    fail("qmd-collection", `no qmd index at ${location.dbPath}`, collectionRepair);
  } else {
    try {
      const store = await openQmd(location, false);
      try {
        const collection = (await store.listCollections()).find((entry) => entry.name === "llmos");
        const path = collection ? realOrSelf(collection.pwd) : "";
        if (collection === undefined) {
          fail("qmd-collection", "llmos collection is missing", collectionRepair);
        } else if (path !== root) {
          collectionRepair = `qmd collection remove llmos && qmd collection add "${root}" --name llmos`;
          fail(
            "qmd-collection",
            `llmos points to ${path || "an unreadable path"}, expected ${root}`,
            collectionRepair,
          );
        } else {
          collectionOk = true;
          pass("qmd-collection", `llmos -> ${path}`);
          indexed = (await indexedPaths(store, "llmos"))?.has("llmOS.md") ?? false;
          const document = await store.get("qmd://llmos/llmOS.md", { includeBody: true });
          const body = "body" in document ? document.body : undefined;
          retrieved =
            body !== undefined &&
            sentinel !== null &&
            body.replace(/\n+$/, "") === sentinel.replace(/\n+$/, "");
        }
      } finally {
        await store.close();
      }
    } catch (error) {
      fail(
        "qmd-collection",
        `cannot read the qmd index: ${(error as Error).message}`,
        collectionRepair,
      );
    }
  }
  if (collectionOk) {
    if (indexed) pass("qmd-index", "llmOS.md is indexed");
    else fail("qmd-index", "llmOS.md is stale or unindexed", "llmos-vault reindex");
    if (retrieved) pass("qmd-retrieval", "full llmOS.md matches the vault");
    else
      fail(
        "qmd-retrieval",
        "retrieved llmOS.md does not match the vault sentinel",
        "llmos-vault reindex",
      );
  } else {
    fail("qmd-index", "blocked by qmd-collection failure", collectionRepair);
    fail("qmd-retrieval", "blocked by qmd-collection failure", collectionRepair);
  }

  // mcp-server: what the plugin's MCP launcher starts on this host.
  const mcp = await mcpCheck(env, Number(env.LLMOS_DOCTOR_TIMEOUT ?? "30") * 1000);
  if (mcp.ok) pass("mcp-server", mcp.detail);
  else fail("mcp-server", mcp.detail, INSTALL_REPAIR);

  const hooks = hookChecks(env);
  lines.push(...hooks.lines);
  failures += hooks.failures;

  return { lines, exitCode: failures > 0 ? 1 : 0 };
}

const PLUGIN_ID = "llmos@llmos-vault";
const WARN_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

interface Agent {
  key: "claude" | "codex";
  name: string;
  /** The installed plugin folder; `undefined` when the plugin is not installed. */
  installPath: string | null | undefined;
  repair: string;
  update: string;
}

/** Claude Code's install record: `installed_plugins.json` names the plugin's folder. */
function claudeInstall(env: Env): string | null | undefined {
  const config = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return undefined;
  }
  const entries = (data as { plugins?: Record<string, unknown> } | null)?.plugins?.[PLUGIN_ID];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const path = (entries[0] as { installPath?: unknown }).installPath;
  return typeof path === "string" ? path : null;
}

/** Major, minor, patch of a version folder name, for ordering. */
function versionKey(name: string): number[] {
  return name.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * Codex's install record: the plugin's `[plugins."llmos@llmos-vault"]` table
 * in `config.toml` (not `enabled = false`), and its newest cached version.
 */
function codexInstall(env: Env): string | null | undefined {
  const codex = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  let config: string;
  try {
    config = readFileSync(join(codex, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  const lines = config.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[plugins."${PLUGIN_ID}"]`);
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) break;
    if (/^\s*enabled\s*=\s*false\s*$/.test(line)) return undefined;
  }
  const cache = join(codex, "plugins", "cache", "llmos-vault", "llmos");
  let versions: string[];
  try {
    versions = readdirSync(cache).filter((name) => isDirectory(join(cache, name)));
  } catch {
    return null;
  }
  versions.sort((a, b) => {
    const [x, y] = [versionKey(a), versionKey(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    }
    return 0;
  });
  return versions[0] ? join(cache, versions[0]) : null;
}

/**
 * The hook heartbeat checks, one per agent: the hooks must have run (the
 * session-start hook records each run, `src/heartbeat.ts`) with the bundle
 * that is installed now. A missing or older heartbeat means the hooks cannot
 * start (no `bun` on the harness PATH) or Codex has not trusted them.
 */
export function hookChecks(env: Env, now = Date.now()): { lines: string[]; failures: number } {
  const lines: string[] = [];
  let failures = 0;
  const fail = (check: string, detail: string, repair: string): void => {
    lines.push(`FAIL ${check}: ${detail}`, `REPAIR ${repair}`);
    failures++;
  };
  const record = heartbeatPath(env);
  const beats = readHeartbeats(env);
  const agents: Agent[] = [
    {
      key: "claude",
      name: "Claude Code",
      installPath: claudeInstall(env),
      repair:
        "Start a fresh Claude Code session, then rerun llmos-doctor. If it still fails, the " +
        "hooks cannot find bun: put bun on the PATH Claude Code gives hooks (setup-llmos, " +
        '"Hooks need bun on the hook PATH").',
      update: `claude plugin marketplace update llmos-vault && claude plugin update ${PLUGIN_ID}`,
    },
    {
      key: "codex",
      name: "Codex",
      installPath: codexInstall(env),
      repair:
        "Start a fresh Codex session, then rerun llmos-doctor. If it still fails, Codex " +
        "skipped the hooks: open codex interactively and approve the llmOS hooks (an untrusted " +
        "hook is skipped silently), and put bun on Codex's login-shell PATH (setup-llmos).",
      update: `codex plugin marketplace upgrade llmos-vault && codex plugin add ${PLUGIN_ID}`,
    },
  ];

  const installed = agents.filter((agent) => agent.installPath !== undefined);
  if (installed.length === 0) {
    fail(
      "hooks",
      `the ${PLUGIN_ID} plugin is installed for neither Claude Code nor Codex`,
      `Install it (setup-llmos): claude plugin install ${PLUGIN_ID}, or codex plugin add ${PLUGIN_ID}`,
    );
  }
  for (const agent of agents) {
    const check = `hooks-${agent.key}`;
    if (agent.installPath === undefined) {
      lines.push(`NOTE ${check}: the ${PLUGIN_ID} plugin is not installed for ${agent.name}`);
      continue;
    }
    if (agent.installPath === null) {
      fail(check, `${agent.name} lists the plugin but has no installed copy`, agent.update);
      continue;
    }
    const bundle = join(agent.installPath, "dist", "hooks.js");
    if (!isFile(bundle)) {
      fail(
        check,
        `the installed plugin (${agent.installPath}) has no dist/hooks.js; it predates the Bun hooks`,
        agent.update,
      );
      continue;
    }
    const beat = beats[agent.key];
    if (beat === undefined) {
      fail(check, `no heartbeat in ${record}: the ${agent.name} hooks have not run`, agent.repair);
      continue;
    }
    if (beat.bundleSha256 !== fileSha256(bundle)) {
      fail(
        check,
        `the last heartbeat (${beat.time}) ran other hooks than the installed ${bundle}`,
        agent.repair,
      );
      continue;
    }
    const days = Math.floor((now - Date.parse(beat.time)) / DAY_MS);
    const detail = `hooks ran ${beat.time} with bun ${beat.bun}`;
    if (Number.isNaN(days)) {
      lines.push(
        `WARN ${check}: the heartbeat has an unreadable time (${JSON.stringify(beat.time)}); start a session to refresh it`,
      );
    } else if (days >= WARN_AFTER_DAYS) {
      lines.push(`WARN ${check}: ${detail}, ${days} days ago; start a session to refresh it`);
    } else {
      lines.push(`PASS ${check}: ${detail}`);
    }
  }
  if (beats.unknown) {
    lines.push(`NOTE hooks: a heartbeat at ${beats.unknown.time} came from an unidentified agent`);
  }
  return { lines, failures };
}
