/** Where the `qmd` command keeps its index and config, and the memory collection. No qmd import, so hooks can use it. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/**
 * The qmd collection of the memory notes: the vault root with the pattern
 * `MEMORY_PATTERN`, which takes only the top-level notes of each project's
 * memory folder. It sits beside `llmos` in one index, and qmd stores a
 * vector by content hash, so a note in both collections has one vector.
 */
export const MEMORY_COLLECTION = "memory";

/** The pattern of `MEMORY_COLLECTION`. */
export const MEMORY_PATTERN = "projects/*/memory/*.md";

export interface QmdLocation {
  dbPath: string;
  /** qmd's YAML config, when it exists. */
  configPath?: string;
}

function home(env: Env): string {
  return env.HOME || homedir();
}

/** Where the `qmd` command keeps its index and config, for this environment. */
export function qmdLocation(env: Env): QmdLocation {
  const dbPath =
    env.INDEX_PATH || join(env.XDG_CACHE_HOME || join(home(env), ".cache"), "qmd", "index.sqlite");
  const configDir =
    env.QMD_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "qmd") : join(home(env), ".config", "qmd"));
  const configPath = join(configDir, "index.yml");
  return existsSync(configPath) ? { dbPath, configPath } : { dbPath };
}
