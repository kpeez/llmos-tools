/** `llmos doctor` fails an agent config or service unit that names a command or plugin 2.11.0 removed. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { oldNameChecks } from "../src/doctor.ts";
import { scratch, writeFiles } from "./helpers.ts";

function check(
  files: Record<string, string>,
  extraEnv: (home: string) => Record<string, string> = () => ({}),
): { home: string; lines: string[]; failures: number } {
  const home = scratch("old-names");
  writeFiles(home, files);
  return { home, ...oldNameChecks({ HOME: home, ...extraEnv(home) }) };
}

const repairsOf = (lines: string[]): string[] => lines.filter((line) => line.startsWith("REPAIR"));

describe("old-names check", () => {
  test("a Hermes config that runs the old binary fails and names the line", () => {
    const config =
      "mcp_servers:\n  llmos:\n    command: /x/.local/bin/llmos-vault\n    args: [mcp]\n";
    const { home, lines, failures } = check({ ".hermes/config.yaml": config });
    expect(failures).toBe(1);
    expect(lines).toContain(
      `${join(home, ".hermes/config.yaml")}:3: command: /x/.local/bin/llmos-vault`,
    );
    expect(lines.at(-1)).toStartWith("REPAIR");
    expect(lines.at(-1)).toContain("llmos doctor");
  });

  test("a Hermes profile config is read too", () => {
    const { lines, failures } = check({
      ".hermes/profiles/work/config.yaml": "command: llmos-doctor\n",
    });
    expect(failures).toBe(1);
    expect(lines.join("\n")).toContain("profiles/work/config.yaml:1: command: llmos-doctor");
  });

  test("a Codex config for the old plugin ID fails", () => {
    const { home, lines, failures } = check({
      ".codex/config.toml": '[plugins."llmos@llmos-vault"]\nenabled = true\n',
    });
    expect(failures).toBe(1);
    expect(lines).toContain(`${join(home, ".codex/config.toml")}:1: [plugins."llmos@llmos-vault"]`);
  });

  test("a Codex hook-trust record of the old plugin ID is deleted, not renamed", () => {
    const { lines, failures } = check({
      ".codex/config.toml":
        '[hooks.state."llmos@llmos-vault:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n',
    });
    expect(failures).toBe(1);
    const repairs = lines.filter((line) => line.startsWith("REPAIR"));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("Delete each [hooks.state");
    expect(repairs[0]).toContain("approve the llmOS hooks again");
    expect(repairs[0]).not.toContain("write llmos for llmos-vault");
  });

  test("a trust record and a plugin record give both repairs", () => {
    const { lines } = check({
      ".codex/config.toml":
        '[plugins."llmos@llmos-vault"]\nenabled = true\n[hooks.state."llmos@llmos-vault:hooks/hooks.json:stop:0:0"]\n',
    });
    const repairs = lines.filter((line) => line.startsWith("REPAIR"));
    expect(repairs).toHaveLength(2);
    expect(repairs[0]).toContain("claude plugin uninstall llmos@llmos-vault");
    expect(repairs[1]).toContain("Delete each [hooks.state");
  });

  test.each([
    [
      "a Codex marketplace table",
      { ".codex/config.toml": '[marketplaces.llmos-vault]\nsource = "x"\n' },
    ],
    [
      "a Claude marketplace key",
      { ".claude/settings.json": '{\n  "llmos-vault": {\n    "source": "x"\n  }\n}\n' },
    ],
  ])("%s gets the plugin and marketplace repair, not a rename", (_name, files) => {
    const { lines, failures } = check(files);
    expect(failures).toBe(1);
    const repairs = repairsOf(lines);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("claude plugin marketplace remove llmos-vault");
    expect(repairs[0]).toContain("add kpeez/llmos-tools");
    expect(repairs[0]).toContain("never by editing");
    expect(lines.join("\n")).not.toContain("llmos for llmos-vault");
  });

  test("a Hermes command still gets the rename repair", () => {
    const { lines } = check({ ".hermes/config.yaml": "command: /x/.local/bin/llmos-vault\n" });
    const repairs = repairsOf(lines);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("write llmos for llmos-vault");
    expect(repairs[0]).not.toContain("llmos@llmos-tools");
  });

  test("CODEX_HOME and CLAUDE_CONFIG_DIR move the files that are read", () => {
    const { home, lines, failures } = check(
      {
        "elsewhere/codex/config.toml": '[plugins."llmos@llmos-vault"]\n',
        "elsewhere/claude/settings.json": '{"hooks": "llmos-audit"}\n',
        ".codex/config.toml": '[plugins."llmos@llmos-vault"]\n',
      },
      (h) => ({
        CODEX_HOME: join(h, "elsewhere/codex"),
        CLAUDE_CONFIG_DIR: join(h, "elsewhere/claude"),
      }),
    );
    expect(failures).toBe(1);
    const hits = lines.filter((line) => /:\d+: /.test(line));
    expect(hits).toHaveLength(2);
    expect(hits.join("\n")).toContain(join(home, "elsewhere/codex/config.toml"));
    expect(hits.join("\n")).toContain(join(home, "elsewhere/claude/settings.json"));
    expect(hits.join("\n")).not.toContain(join(home, ".codex"));
  });

  test("a Claude setting, a systemd unit, and a launchd agent that run an old command fail", () => {
    const { lines, failures } = check({
      ".claude/settings.json": '{"hooks": "llmos-audit --root x"}\n',
      ".config/systemd/user/llmos-nightly.service":
        "[Service]\nExecStart=%h/.local/bin/llmos-daily-activity --push\n",
      "Library/LaunchAgents/com.llmos.sync.plist": "<string>llmos-vault reindex</string>\n",
    });
    expect(failures).toBe(1);
    expect(lines.filter((line) => /:\d+: /.test(line))).toHaveLength(3);
  });

  test("the vault repository and the unit that stays are not flagged", () => {
    const { lines, failures } = check({
      ".hermes/config.yaml":
        "vault_remote: https://github.com/kpeez/llmos-vault.git\nroot: /home/me/code/llmos-vault\n",
      ".codex/config.toml": "# vault: kpeez/llmos-vault\n",
      ".config/systemd/user/llmos-daily-activity.service":
        "[Unit]\nDescription=Daily activity\n[Service]\nExecStart=/x/.local/bin/llmos daily activity --push\n",
      ".config/systemd/user/llmos-daily-activity.timer":
        "[Timer]\nUnit=llmos-daily-activity.service\n",
    });
    expect(failures).toBe(0);
    expect(lines).toEqual([
      "PASS old-names: no agent config or service unit names a removed command",
    ]);
  });

  test("a host with none of the files passes", () => {
    expect(check({}).failures).toBe(0);
  });
});
