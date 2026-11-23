/**
 * `scripts/install.ts` on a scratch HOME and a small fake plugin root (the real
 * script, stub entry points, no dependencies), so no test touches the network
 * or a real install.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLI, scratch } from "./helpers.ts";

const LOCKFILE = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fake",
      "dependencies": {
        "dep": "file:./dep",
      },
    },
  },
  "packages": {
    "dep": ["dep@file:dep", {}],
  }
}
`;
const STUB = '#!/usr/bin/env bun\nconsole.log("ok");\n';

/** A plugin root of the given version whose `cli/scripts/install.ts` is the real script. */
function pluginRoot(version: string): string {
  const root = scratch("install-plugin");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
  for (const dir of ["bin", "scripts", "src"])
    mkdirSync(join(root, "cli", dir), { recursive: true });
  mkdirSync(join(root, "cli", "dep"));
  writeFileSync(join(root, "cli", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}\n');
  writeFileSync(
    join(root, "cli", "package.json"),
    '{"name":"fake","private":true,"dependencies":{"dep":"file:./dep"}}\n',
  );
  writeFileSync(join(root, "cli", "bun.lock"), LOCKFILE);
  for (const entry of ["bin/llmos.ts", "bin/qmd.ts"]) {
    writeFileSync(join(root, "cli", entry), STUB);
    chmodSync(join(root, "cli", entry), 0o755);
  }
  copyFileSync(join(CLI, "scripts", "install.ts"), join(root, "cli", "scripts", "install.ts"));
  copyFileSync(join(CLI, "src", "run.ts"), join(root, "cli", "src", "run.ts"));
  mkdirSync(join(root, "hermes"));
  return root;
}

function install(root: string, home: string): { code: number; stderr: string } {
  const result = Bun.spawnSync([process.execPath, join(root, "cli", "scripts", "install.ts")], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

describe("install.ts current link", () => {
  test("two installs in a row move current to the second version", () => {
    const home = scratch("install-home");
    const data = join(home, ".local", "share", "llmos");

    expect(install(pluginRoot("1.0.0"), home)).toEqual({ code: 0, stderr: "" });
    expect(readlinkSync(join(data, "current"))).toBe(join(data, "1.0.0"));

    expect(install(pluginRoot("1.1.0"), home)).toEqual({ code: 0, stderr: "" });
    expect(readlinkSync(join(data, "current"))).toBe(join(data, "1.1.0"));
    expect(existsSync(join(data, "current", "hermes"))).toBe(true);
  });

  test("a current that is a real folder stops the install before anything changes", () => {
    const home = scratch("install-home");
    const data = join(home, ".local", "share", "llmos");
    mkdirSync(join(data, "current"), { recursive: true });

    const result = install(pluginRoot("1.0.0"), home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(join(data, "current"));
    expect(existsSync(join(data, "1.0.0"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin"))).toBe(false);
  });

  test("a current that links outside the data root stops the install", () => {
    const home = scratch("install-home");
    const data = join(home, ".local", "share", "llmos");
    const elsewhere = join(home, "elsewhere");
    mkdirSync(data, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(data, "current"));

    expect(install(pluginRoot("1.0.0"), home).code).toBe(1);
    expect(readlinkSync(join(data, "current"))).toBe(elsewhere);
    expect(existsSync(join(data, "1.0.0"))).toBe(false);
  });
});
