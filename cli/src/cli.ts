/**
 * The `llmos` command line: a registry of commands and the one entry
 * point that turns their results and errors into output and exit codes.
 *
 * Each command declares its name, a one-line summary, its help text, its
 * arguments, its `node:util` `parseArgs` options, and a handler. `--help`,
 * `skills/vault-cli/references/commands.md`, and the verb table in
 * `skills/vault-cli/SKILL.md` all render from the registry (`docs`), so
 * help text has one source. Handlers take parsed values and a `Context` and
 * return an `Outcome`; they never print or exit, so other front ends (the
 * MCP server) can call them directly. Only `runCli` maps errors to exit
 * codes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  EXIT_OBSIDIAN_NOT_RUNNING,
  ObsidianNotRunning,
  type ObsidianRunner,
  spawnObsidian,
} from "./obsidian.ts";
import { mineruConverter, type PdfConverter } from "./pdf.ts";
import { resolveVaultRoot } from "./root.ts";
import { type Fetcher, httpFetch } from "./sources.ts";
import { VaultModel } from "./vault.ts";

export type Env = Record<string, string | undefined>;

/** What a handler needs from its surroundings; tests and other front ends replace parts. */
export interface Context {
  env: Env;
  /** The root folder of a `--vault` name. Throws `VaultRootError`. */
  root(vault: string): string;
  /** The vault model of a root. */
  model(root: string): VaultModel;
  /** Today as `YYYY-MM-DD`, in local time. */
  today(): string;
  obsidian: ObsidianRunner;
  /** The network, for verbs that capture web pages. */
  fetch: Fetcher;
  /** The PDF converter of `source add`. */
  convertPdf: PdfConverter;
}

/** Today's local date as `YYYY-MM-DD`. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The context of a real run: the process environment, the clock, and obsidian-cli. */
export function defaultContext(env: Env = process.env): Context {
  const home = env.HOME || homedir();
  return {
    env,
    root: (vault) =>
      resolveVaultRoot(vault, {
        env,
        configPath: join(home, ".config", "llmos", "config.json"),
        registryPath: join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
      }),
    model: (root) => VaultModel.load(root),
    today: localDate,
    obsidian: spawnObsidian,
    fetch: httpFetch,
    convertPdf: mineruConverter((env.LLMOS_MINERU || "mineru-kit").replace(/^~(?=\/)/, home)),
  };
}

export interface OptionSpec {
  /** `parseArgs` type; "integer" parses as a string and must be a whole number. */
  type: "string" | "boolean" | "integer";
  help: string;
  default?: string | number | boolean;
  choices?: readonly string[];
  /** The value's placeholder in usage lines (`--depth N`). */
  metavar?: string;
}

export interface ArgumentSpec {
  name: string;
  help: string;
  /** Takes one or more values, as a string list. Only the last argument may be variadic. */
  variadic?: boolean;
}

export type Values = Record<string, string | string[] | number | boolean | undefined>;

/** A handler's result: JSON (printed with two-space indents) or text, and an exit code. */
export interface Outcome {
  json?: unknown;
  text?: string;
  /** Printed on stderr, after the output. */
  stderr?: string;
  exitCode?: number;
}

export interface Command {
  /** One word, or a group and a word (`daily recent`). */
  name: string;
  summary: string;
  /** When to use it and when not, as paragraphs. */
  description: string;
  arguments: ArgumentSpec[];
  options: Record<string, OptionSpec>;
  exampleOutput: string;
  example: string;
  run(values: Values, context: Context): Outcome | Promise<Outcome>;
}

/** The command line is wrong: an unknown command or option, or a missing or invalid value. */
export class UsageError extends Error {
  override name = "UsageError";
}

const PROGRAM = "llmos";

function placeholder(arg: ArgumentSpec): string {
  return arg.variadic ? `<${arg.name}...>` : `<${arg.name}>`;
}

function usage(command: Command): string {
  const parts = [`${PROGRAM} ${command.name}`, ...command.arguments.map(placeholder)];
  for (const [name, option] of Object.entries(command.options)) {
    if (option.type === "boolean") parts.push(`[--${name}]`);
    else parts.push(`[--${name} ${option.choices?.join("|") ?? option.metavar ?? "VALUE"}]`);
  }
  return parts.join(" ");
}

function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

/** A command's full help, as `--help` prints it and the reference shows it. */
export function renderHelp(command: Command): string {
  const lines = [`Usage: ${usage(command)}`, "", command.summary, "", command.description];
  if (command.arguments.length > 0) {
    lines.push("", "Arguments:", ...table(command.arguments.map((arg) => [arg.name, arg.help])));
  }
  const options = Object.entries(command.options);
  if (options.length > 0) {
    lines.push(
      "",
      "Options:",
      ...table(
        options.map(([name, option]) => {
          const shown =
            option.default === undefined || option.type === "boolean"
              ? option.help
              : `${option.help} Default: ${option.default}.`;
          return [`--${name}`, shown];
        }),
      ),
    );
  }
  lines.push(
    "",
    "Example output:",
    indent(command.exampleOutput),
    "",
    "Example:",
    indent(command.example),
  );
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** The list of commands, as `llmos --help` prints it. */
export function renderOverview(commands: readonly Command[], group?: string): string {
  const shown = group ? commands.filter((c) => c.name.startsWith(`${group} `)) : commands;
  return [
    `Usage: ${PROGRAM} ${group ? `${group} ` : ""}<command> [arguments] [options]`,
    "",
    "Headless verbs for the llmOS vault and other Obsidian vaults. Every command takes --help.",
    "",
    "Commands:",
    ...table(shown.map((c) => [c.name, c.summary])),
  ].join("\n");
}

/** Put `--name value` string options in `--name=value` form and every positional after `--`. */
function normalizeTokens(tokens: string[], options: Record<string, OptionSpec>): string[] {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2).split("=", 1)[0] as string;
      const option = options[name];
      if (option && option.type !== "boolean" && !token.includes("=")) {
        const value = tokens[i + 1];
        if (value === undefined) throw new UsageError(`option --${name} needs a value`);
        flags.push(`--${name}=${value}`);
        i++;
      } else flags.push(token);
    } else if (token === "-h") flags.push(token);
    else positionals.push(token);
  }
  return [...flags, "--", ...positionals];
}

/** Parse a command's tokens into values, or throw `UsageError`. */
export function parseValues(command: Command, tokens: string[]): Values | "help" {
  const config: Record<string, { type: "string" | "boolean"; short?: string }> = {
    help: { type: "boolean", short: "h" },
  };
  for (const [name, option] of Object.entries(command.options)) {
    config[name] = { type: option.type === "boolean" ? "boolean" : "string" };
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: normalizeTokens(tokens, command.options),
      options: config,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (parsed.values.help) return "help";
  const given = parsed.positionals.length;
  const variadic = command.arguments.at(-1)?.variadic === true;
  const fixed = command.arguments.length - (variadic ? 1 : 0);
  if (variadic ? given <= fixed : given !== fixed) {
    const expected = command.arguments.map(placeholder).join(" ") || "no arguments";
    throw new UsageError(`expected ${expected}, got ${given} argument(s)`);
  }
  const values: Values = {};
  command.arguments.forEach((arg, i) => {
    values[arg.name] = arg.variadic
      ? (parsed.positionals.slice(i) as string[])
      : parsed.positionals[i];
  });
  for (const [name, option] of Object.entries(command.options)) {
    const raw = parsed.values[name] as string | boolean | undefined;
    if (raw === undefined) {
      values[name] = option.default ?? (option.type === "boolean" ? false : undefined);
      continue;
    }
    if (option.type === "integer") {
      if (!/^-?[0-9]+$/.test(raw as string)) {
        throw new UsageError(`--${name} must be a whole number, got '${raw}'`);
      }
      values[name] = Number.parseInt(raw as string, 10);
      continue;
    }
    if (option.choices && !option.choices.includes(raw as string)) {
      throw new UsageError(`--${name} must be one of ${option.choices.join(", ")}, got '${raw}'`);
    }
    values[name] = raw;
  }
  return values;
}

/** Errors whose message is the whole story; anything else also prints its stack. */
const EXPECTED_ERRORS = new Set([
  "Error",
  "UsageError",
  "VaultRootError",
  "NoteNotFoundError",
  "AmbiguousNoteError",
  "UnsupportedFrontmatter",
  "MissingFrontmatter",
  "ImmutableProperty",
  "MachineOwnedBlock",
  "ObsidianNotRunning",
  "ObsidianCliError",
  "WriteRefused",
  "SourceRefused",
  "QmdCollectionMissing",
  "EmbedLockBusy",
]);

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The exit code for an error: 3 when Obsidian is not running, 2 for usage, else 1. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof ObsidianNotRunning) return EXIT_OBSIDIAN_NOT_RUNNING;
  if (error instanceof UsageError) return 2;
  return 1;
}

/** Run one command line and collect what it prints and its exit code. */
export async function runCli(
  argv: string[],
  commands: readonly Command[],
  context: Context,
): Promise<CliResult> {
  const groups = new Set(
    commands.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]),
  );
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    return { exitCode: 0, stdout: `${renderOverview(commands)}\n`, stderr: "" };
  }
  const second = argv[1];
  const command =
    commands.find((c) => c.name === `${first} ${second}`) ?? commands.find((c) => c.name === first);
  if (command === undefined) {
    if (groups.has(first)) {
      const help = second === undefined || second === "--help" || second === "-h";
      const overview = `${renderOverview(commands, first)}\n`;
      return help
        ? { exitCode: 0, stdout: overview, stderr: "" }
        : { exitCode: 2, stdout: "", stderr: `unknown command: ${first} ${second}\n${overview}` };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unknown command: ${first}\nRun '${PROGRAM} --help' for the list of commands.\n`,
    };
  }
  const tokens = argv.slice(command.name.split(" ").length);
  try {
    const values = parseValues(command, tokens);
    if (values === "help") return { exitCode: 0, stdout: `${renderHelp(command)}\n`, stderr: "" };
    const outcome = await command.run(values, context);
    let stdout = "";
    if (outcome.json !== undefined) stdout = `${JSON.stringify(outcome.json, null, 2)}\n`;
    else if (outcome.text !== undefined) stdout = `${outcome.text}\n`;
    return { exitCode: outcome.exitCode ?? 0, stdout, stderr: outcome.stderr ?? "" };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const detail = EXPECTED_ERRORS.has(error.name) ? error.message : (error.stack ?? String(error));
    const hint = error instanceof UsageError ? `\nRun '${PROGRAM} ${command.name} --help'.` : "";
    return { exitCode: exitCodeFor(error), stdout: "", stderr: `${detail}${hint}\n` };
  }
}

/** The process entry point: run `argv`, print, and exit. */
export async function main(argv: string[], commands: readonly Command[]): Promise<never> {
  const result = await runCli(argv, commands, defaultContext());
  // `Bun.write` resolves once a large output has reached a pipe in full.
  if (result.stdout) await Bun.write(Bun.stdout, result.stdout);
  if (result.stderr) await Bun.write(Bun.stderr, result.stderr);
  process.exit(result.exitCode);
}
