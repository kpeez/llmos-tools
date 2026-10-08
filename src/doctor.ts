/**
 * `llmos-doctor`: check the external prerequisites of the llmOS tools on
 * this host and print `PASS`/`FAIL` per check, with a `REPAIR` command after
 * each failure. Read-only. Exit 0 only when every check passes.
 *
 * The qmd checks read the index through the qmd SDK, the same way `search`
 * does. The `qmd` command on `PATH` must be exactly one, and it must be this
 * install's: two qmd versions would write the same `~/.cache/qmd` index.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
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

  return { lines, exitCode: failures > 0 ? 1 : 0 };
}
