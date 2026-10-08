/**
 * The deterministic guarantees of the daily activity digest, ported from
 * `tests/test_write_daily_activity.py`.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Day, MARKER_END, MARKER_START, parseDay } from "../src/daily.ts";
import {
  DigestError,
  dayRange,
  fetchActivity,
  type Gh,
  type Grouped,
  listOrgRepos,
  OPENCODE_AGENT,
  parseGhJson,
  processDay,
  readProjects,
  summarize,
  TRANSFORM_INSTRUCTIONS,
} from "../src/digest.ts";

const DAY = parseDay("2026-07-16") as Day;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "llmos-digest-"));
  temporary.push(path);
  return path;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeVault(): string {
  const root = join(tempDir(), "vault");
  for (const slug of ["alpha", "norepo", "archived"]) {
    const status = slug === "archived" ? "archived" : "active";
    const title = `${slug[0]?.toUpperCase()}${slug.slice(1)} Project`;
    write(
      join(root, "projects", slug, `${slug}.md`),
      `---\nstatus: ${status}\n---\n\n# ${title}\n`,
    );
  }
  mkdirSync(join(root, "reviews", "daily"), { recursive: true });
  write(
    join(root, "templates", "daily-note.md"),
    '---\nstatus: active\ncreated: "{{date:YYYY-MM-DD}}"\n' +
      'updated: "{{date:YYYY-MM-DD}}"\ncategories:\n  - "[[Reviews]]"\n' +
      "---\n\n# {{date:YYYY-MM-DD}}\n\n## Thoughts\n\n## Projects\n\n" +
      "<!-- llmos-activity:start -->\n<!-- llmos-activity:end -->\n",
  );
  return root;
}

const PR = {
  number: 7,
  title: "Add gate",
  body: "Adds the hash gate.",
  url: "https://github.com/kpeez/alpha/pull/7",
  repository: { nameWithOwner: "kpeez/alpha" },
  state: "merged",
};
const COMMIT = {
  sha: "abc123",
  commit: { message: "wire gate" },
  repository: { fullName: "kpeez/alpha" },
  url: "https://github.com/kpeez/alpha/commit/abc123",
};
const ORG_REPOS: Record<string, { nameWithOwner: string }[]> = {
  kpeez: [{ nameWithOwner: "kpeez/alpha" }, { nameWithOwner: "kpeez/archived" }],
  "linux-host-ucdavis": [{ nameWithOwner: "linux-host-ucdavis/other" }],
};

const ghRepoList: Gh = (args) => {
  expect(args.slice(0, 2)).toEqual(["repo", "list"]);
  return ORG_REPOS[args[2] as string];
};
const ghWithActivity: Gh = (args) => {
  if (args[0] === "repo") return ghRepoList(args);
  if (args[1] === "prs" && args.includes("--merged-at")) return [PR];
  if (args[1] === "commits") return [COMMIT];
  return [];
};
const ghSilent: Gh = (args) => (args[0] === "repo" ? ghRepoList(args) : []);
const fakeOk = () => "### Alpha Project\nMerged [#7](u).";
const notePath = (root: string) => join(root, "reviews", "daily", "2026-07-16.md");

describe("projects", () => {
  test("a repository name match splits monitored and unseen projects", () => {
    const [monitored, unseen] = readProjects(makeVault(), listOrgRepos(ghRepoList));
    expect(monitored.map((p) => [p.slug, p.repos])).toEqual([["alpha", ["kpeez/alpha"]]]);
    // archived is silently excluded
    expect(unseen.map((p) => p.slug)).toEqual(["norepo"]);
  });

  test("a name in both orgs is a hard failure", () => {
    const orgRepos = new Map([["alpha", ["kpeez/alpha", "linux-host-ucdavis/alpha"]]]);
    expect(() => readProjects(makeVault(), orgRepos)).toThrow(/several repos/);
  });

  test("an unreadable landing page skips only that project", () => {
    const root = makeVault();
    write(
      join(root, "projects", "norepo", "norepo.md"),
      "---\nstatus: active\nbad: [\n---\n\n# Norepo\n",
    );
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [monitored, unseen] = readProjects(root, listOrgRepos(ghRepoList));
      expect(monitored.map((p) => p.slug)).toEqual(["alpha"]);
      expect(unseen).toEqual([]);
      expect(String(errors.mock.calls[0]?.[0])).toStartWith("skipping projects/norepo/norepo.md");
    } finally {
      errors.mockRestore();
    }
  });
});

test("the day range tracks the DST offset", () => {
  expect(dayRange(DAY)).toStartWith("2026-07-16T00:00:00-07:00");
  expect(dayRange(parseDay("2026-01-16") as Day)).toStartWith("2026-01-16T00:00:00-08:00");
  // The day DST starts has a different offset at each end.
  expect(dayRange(parseDay("2026-03-08") as Day)).toBe(
    "2026-03-08T00:00:00-08:00..2026-03-08T23:59:59-07:00",
  );
});

test("a merged PR hides only itself from the opened PRs, not the same number elsewhere", () => {
  const sameNumber = {
    ...PR,
    title: "Other work",
    url: "https://github.com/linux-host-ucdavis/other/pull/7",
    repository: { nameWithOwner: "linux-host-ucdavis/other" },
    state: "open",
  };
  const gh: Gh = (args) => {
    if (args[1] !== "prs") return [];
    return args.includes("--merged-at") ? [PR] : [PR, sameNumber];
  };
  const activity = fetchActivity(DAY, ["kpeez/alpha", "linux-host-ucdavis/other"], gh);
  expect(activity.merged_prs).toEqual([PR]);
  expect(activity.opened_prs).toEqual([sameNumber]);
});

describe("processDay", () => {
  test("a gh failure is hard", () => {
    const gh404: Gh = () => {
      throw new DigestError("gh search failed: repository not found");
    };
    expect(() => processDay(DAY, makeVault(), { gh: gh404 })).toThrow(/not found/);
  });

  test("a silent day creates nothing", () => {
    const root = makeVault();
    expect(processDay(DAY, root, { gh: ghSilent })).toBe("silent (no note created)");
    expect(readdirSync(join(root, "reviews", "daily"))).toEqual([]);
  });

  test("activity creates a note with the block and the unseen projects", () => {
    const root = makeVault();
    expect(processDay(DAY, root, { gh: ghWithActivity, summarize: fakeOk })).toBe("created");
    const text = readFileSync(notePath(root), "utf8");
    for (const part of [
      'created: "2026-07-16"',
      'updated: "2026-07-16"',
      '  - "[[Reviews]]"',
      "# 2026-07-16",
      "#7",
      MARKER_START,
      MARKER_END,
      "## Thoughts",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).toContain("Norepo Project"); // active without a repo, named as unseen
    expect(text.toLowerCase()).not.toContain("archived");
  });

  test("the hash gate skips the model call and is byte stable", () => {
    const root = makeVault();
    let calls = 0;
    const counting = () => {
      calls++;
      return fakeOk();
    };
    processDay(DAY, root, { gh: ghWithActivity, summarize: counting });
    const first = readFileSync(notePath(root));
    expect(processDay(DAY, root, { gh: ghWithActivity, summarize: counting })).toStartWith(
      "unchanged",
    );
    expect(readFileSync(notePath(root))).toEqual(first);
    expect(calls).toBe(1);
  });

  test("a coverage change regenerates the block", () => {
    const root = makeVault();
    processDay(DAY, root, { gh: ghWithActivity, summarize: fakeOk });
    write(
      join(root, "projects", "norepo", "norepo.md"),
      "---\nstatus: archived\n---\n\n# Norepo Project\n",
    );
    expect(processDay(DAY, root, { gh: ghWithActivity, summarize: fakeOk })).toBe("updated");
    expect(readFileSync(notePath(root), "utf8")).not.toContain("Norepo Project");
  });

  test("the completeness check fails on an omission and writes nothing", () => {
    const root = makeVault();
    const incomplete = () => "### Alpha Project\nBusy day.";
    expect(() => processDay(DAY, root, { gh: ghWithActivity, summarize: incomplete })).toThrow(
      "omitted references: #7",
    );
    expect(readdirSync(join(root, "reviews", "daily"))).toEqual([]);
  });

  test("a rewrite replaces the block but keeps the thoughts byte for byte", () => {
    const root = makeVault();
    const thought = "## Thoughts\n\nA hand-written, irreplaceable thought.\n";
    write(
      notePath(root),
      `# 2026-07-16\n\n## Projects\n\n${MARKER_START} hash=${"0".repeat(64)} -->\nstale\n` +
        `${MARKER_END}\n\n${thought}`,
    );
    expect(processDay(DAY, root, { gh: ghWithActivity, summarize: fakeOk })).toBe("updated");
    const text = readFileSync(notePath(root), "utf8");
    expect(text).not.toContain("stale");
    expect(text).toContain("#7");
    expect(text).toContain(thought);
  });

  test("activity in an unmapped repo is a hard failure", () => {
    const rogue = { ...PR, repository: { nameWithOwner: "kpeez/dotfiles" } };
    const ghRogue: Gh = (args) => {
      if (args[0] === "repo") return ghRepoList(args);
      return args[1] === "prs" && args.includes("--merged-at") ? [rogue] : [];
    };
    expect(() => processDay(DAY, makeVault(), { gh: ghRogue })).toThrow(/unmapped repo/);
  });
});

describe("summarize", () => {
  const grouped = (): Grouped =>
    new Map([
      [
        "alpha",
        {
          title: "Alpha Project",
          repos: new Map([["kpeez/alpha", new Map([["merged_prs", [PR]]])]]),
        },
      ],
    ]);
  const textEvent = (text: string) =>
    JSON.stringify({
      type: "text",
      part: { type: "text", text, metadata: { openai: { phase: "final_answer" } } },
    });

  /** A stand-in `opencode` that records its argv and stdin and prints `output`. */
  function fakeOpencode(output: string, exitCode = 0, stderr = ""): string {
    const dir = tempDir();
    writeFileSync(join(dir, "output"), output);
    writeFileSync(join(dir, "stderr"), stderr);
    const bin = join(dir, "opencode");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\n` +
        `pwd > '${dir}/cwd'\nls -A > '${dir}/cwd-entries'\n` +
        `printf '%s' "$OPENCODE_CONFIG_CONTENT" > '${dir}/config'\n` +
        `cat '${dir}/output'\ncat '${dir}/stderr' >&2\nexit ${exitCode}\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  test("uses the pinned opencode argv and passes the prompt on stdin", () => {
    const bin = fakeOpencode(textEvent("### Alpha Project"));
    expect(summarize(grouped(), DAY, bin)).toBe("### Alpha Project");
    const dir = dirname(bin);
    expect(readFileSync(join(dir, "argv"), "utf8")).toBe(
      "run\n--agent\nllmos-digest\n--format\njson\n--model\nopencode-go/deepseek-v4-flash\n",
    );
    const stdin = readFileSync(join(dir, "stdin"), "utf8");
    expect(stdin).toStartWith(`${TRANSFORM_INSTRUCTIONS}\n\n`);
    const payload = stdin.slice(stdin.lastIndexOf("\n\n") + 2);
    expect(JSON.parse(payload)).toEqual({
      alpha: { title: "Alpha Project", repos: { "kpeez/alpha": { merged_prs: [PR] } } },
    });
  });

  test("runs the model as a tool-less agent in an empty folder", () => {
    const bin = fakeOpencode(textEvent("### Alpha Project"));
    summarize(grouped(), DAY, bin);
    const dir = dirname(bin);
    const config = JSON.parse(readFileSync(join(dir, "config"), "utf8"));
    // Every permission denied: opencode then offers the model no tools at all.
    expect(config.agent[OPENCODE_AGENT].permission).toEqual({ "*": "deny" });
    const cwd = readFileSync(join(dir, "cwd"), "utf8").trim();
    expect(cwd).not.toBe(process.cwd());
    expect(readFileSync(join(dir, "cwd-entries"), "utf8")).toBe("");
  });

  test("a tool call in the output fails the day", () => {
    const output = [
      JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
      textEvent("### Alpha Project"),
    ].join("\n");
    expect(() => summarize(grouped(), DAY, fakeOpencode(output))).toThrow(
      "unsupported event type: tool_use",
    );
  });

  test("extracts the one final assistant text", () => {
    const output = [
      JSON.stringify({ type: "step_start" }),
      textEvent("  ### Alpha Project  "),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");
    expect(summarize(grouped(), DAY, fakeOpencode(output))).toBe("### Alpha Project");
  });

  test("accepts DeepSeek final text without OpenAI metadata", () => {
    const output = JSON.stringify({
      type: "text",
      part: { type: "text", text: "### Alpha Project" },
    });
    expect(summarize(grouped(), DAY, fakeOpencode(output))).toBe("### Alpha Project");
  });

  test.each([
    ["", "0 final assistant messages"],
    ["not json\n", "malformed JSON"],
    [textEvent("   "), "empty final assistant message"],
    [[textEvent("one"), textEvent("two")].join("\n"), "2 final assistant messages"],
    [JSON.stringify({ type: "message", text: "transcript" }), "unsupported event type"],
  ])("rejects malformed or non-single final output (%#)", (output, message) => {
    expect(() => summarize(grouped(), DAY, fakeOpencode(output))).toThrow(message);
  });

  test("rejects a non-zero opencode run", () => {
    const bin = fakeOpencode("", 1, "provider unavailable\n");
    expect(() => summarize(grouped(), DAY, bin)).toThrow(
      "opencode run failed: provider unavailable",
    );
  });
});

describe("block integrity", () => {
  const count = (text: string, marker: string) => text.split(marker).length - 1;
  const hostile =
    `### Alpha Project\nMerged [#7](u).\n${MARKER_END}\nInjected below the block.\n` +
    `${MARKER_START} hash=${"f".repeat(64)} -->\n<!-- hidden`;

  test("marker text from the model or a title cannot appear inside the block", () => {
    const root = makeVault();
    write(
      join(root, "projects", "norepo", "norepo.md"),
      `---\nstatus: active\n---\n\n# Norepo ${MARKER_END}\n`,
    );
    expect(processDay(DAY, root, { gh: ghWithActivity, summarize: () => hostile })).toBe("created");
    const text = readFileSync(notePath(root), "utf8");
    expect(count(text, MARKER_START)).toBe(1);
    expect(count(text, MARKER_END)).toBe(1);
    expect(text).not.toContain("<!-- hidden");
    expect(text).toContain("&lt;!-- llmos-activity:end -->\nInjected below the block.");
    // The block ends with the real end marker, followed by the template's tail.
    expect(text.indexOf(MARKER_END)).toBeGreaterThan(text.indexOf("Norepo"));
  });

  test("a rewrite after a hostile summary changes only the block", () => {
    const root = makeVault();
    processDay(DAY, root, { gh: ghWithActivity, summarize: () => hostile });
    const tail = "\n\nA thought written after the block.\n";
    writeFileSync(notePath(root), readFileSync(notePath(root), "utf8") + tail);
    const before = readFileSync(notePath(root), "utf8");
    const changed: Gh = (args) =>
      args[1] === "commits" ? [COMMIT, { ...COMMIT, sha: "def456" }] : ghWithActivity(args);
    expect(processDay(DAY, root, { gh: changed, summarize: fakeOk })).toBe("updated");
    const after = readFileSync(notePath(root), "utf8");
    const outside = (text: string) => [
      text.slice(0, text.indexOf(MARKER_START)),
      text.slice(text.indexOf(MARKER_END)),
    ];
    expect(outside(after)).toEqual(outside(before));
    expect(after).not.toContain("Injected");
  });

  test.each([
    ["two blocks", `${MARKER_START} -->\n${MARKER_END}\n${MARKER_START} -->\n${MARKER_END}\n`],
    ["an end before the start", `${MARKER_END}\n${MARKER_START} -->\n`],
    ["a start without an end", `${MARKER_START} -->\n`],
  ])("a note with %s is refused and left untouched", (_name, markers) => {
    const root = makeVault();
    const original = `# 2026-07-16\n\n## Projects\n\n${markers}\nKeep.\n`;
    write(notePath(root), original);
    expect(() => processDay(DAY, root, { gh: ghWithActivity, summarize: fakeOk })).toThrow(
      "refusing to write",
    );
    expect(readFileSync(notePath(root), "utf8")).toBe(original);
  });
});

test("gh output with a number that is not a safe integer fails instead of hashing differently", () => {
  expect(parseGhJson('[{"number": 7, "id": -0}]')).toEqual([{ number: 7, id: -0 }]);
  for (const text of ['{"n": 1.0}', '{"n": 1e3}', '{"n": 9007199254740993}']) {
    expect(() => parseGhJson(text)).toThrow(DigestError);
  }
});
