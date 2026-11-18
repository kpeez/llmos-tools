/**
 * The deterministic guarantees of the daily activity digest, ported from the
 * retired Python test `test_write_daily_activity.py`.
 */

import { afterEach, describe, expect, test } from "bun:test";
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
  type Gh,
  type Grouped,
  githubOwners,
  OPENCODE_AGENT,
  parseGhJson,
  processDay,
  pushNotes,
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
  mkdirSync(join(root, "daily"), { recursive: true });
  write(
    join(root, "categories", "templates", "daily-note.md"),
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
const OWNERS = ["kpeez", "example-org"];
const ORG_REPOS: Record<string, { nameWithOwner: string }[]> = {
  kpeez: [{ nameWithOwner: "kpeez/alpha" }, { nameWithOwner: "kpeez/archived" }],
  "example-org": [{ nameWithOwner: "example-org/other" }],
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
const fakeOk = () => `### Alpha Project\nMerged [#7](${PR.url}).`;
const notePath = (root: string) => join(root, "daily", "2026-07-16.md");

describe("githubOwners", () => {
  test("reads github_owners from the config file and fails loudly without it", () => {
    const config = join(tempDir(), "config.json");
    expect(() => githubOwners(config)).toThrow(/"github_owners"/);
    write(config, `${JSON.stringify({ vault_root: "/v", github_owners: [] })}\n`);
    expect(() => githubOwners(config)).toThrow(/"github_owners"/);
    write(config, `${JSON.stringify({ vault_root: "/v", github_owners: ["octocat", "org"] })}\n`);
    expect(githubOwners(config)).toEqual(["octocat", "org"]);
  });
});

describe("projects", () => {
  test("a name in both orgs is a hard failure", () => {
    const orgRepos = new Map([["alpha", ["kpeez/alpha", "example-org/alpha"]]]);
    expect(() => readProjects(makeVault(), orgRepos)).toThrow(/several repos/);
  });
});

describe("processDay", () => {
  test("the hash gate skips the model call and is byte stable", () => {
    const root = makeVault();
    let calls = 0;
    const counting = () => {
      calls++;
      return fakeOk();
    };
    processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: counting });
    const first = readFileSync(notePath(root));
    expect(
      processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: counting }),
    ).toStartWith("unchanged");
    expect(readFileSync(notePath(root))).toEqual(first);
    expect(calls).toBe(1);
  });

  test("a coverage change regenerates the block", () => {
    const root = makeVault();
    processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: fakeOk });
    write(
      join(root, "projects", "norepo", "norepo.md"),
      "---\nstatus: archived\n---\n\n# Norepo Project\n",
    );
    expect(processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: fakeOk })).toBe(
      "updated",
    );
    expect(readFileSync(notePath(root), "utf8")).not.toContain("Norepo Project");
  });

  test("a thought written during the model call stays in the note", () => {
    const root = makeVault();
    processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: fakeOk });
    write(join(root, "projects", "norepo", "norepo.md"), "---\nstatus: archived\n---\n\n# N\n");
    const addsThought = () => {
      const note = readFileSync(notePath(root), "utf8");
      writeFileSync(notePath(root), note.replace("## Thoughts\n", "## Thoughts\n\nA thought.\n"));
      return fakeOk();
    };
    expect(
      processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: addsThought }),
    ).toBe("updated");
    const note = readFileSync(notePath(root), "utf8");
    expect(note).toContain("A thought.");
    expect(note).not.toContain("Norepo Project");
  });

  test("a note created during the model call keeps its text", () => {
    const root = makeVault();
    const createsNote = () => {
      write(notePath(root), "# 2026-07-16\n\n## Thoughts\n\nA thought.\n");
      return fakeOk();
    };
    expect(
      processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: createsNote }),
    ).toBe("updated");
    const note = readFileSync(notePath(root), "utf8");
    expect(note).toContain("A thought.");
    expect(note).toContain(PR.url);
  });

  test("an omission gets a new model call", () => {
    const root = makeVault();
    const answers = ["### Alpha Project\nBusy day.", fakeOk()];
    const flaky = () => answers.shift() as string;
    expect(processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: flaky })).toBe(
      "created",
    );
    expect(answers).toEqual([]);
  });

  test("the completeness check fails after repeated omissions and writes nothing", () => {
    const root = makeVault();
    let calls = 0;
    const incomplete = () => {
      calls++;
      return "### Alpha Project\nBusy day.";
    };
    expect(() =>
      processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: incomplete }),
    ).toThrow("omitted references: kpeez/alpha#7");
    expect(calls).toBe(3);
    expect(readdirSync(join(root, "daily"))).toEqual([]);
  });

  test("the completeness check needs each repository's link when two share a number", () => {
    const root = makeVault();
    write(join(root, "projects", "other", "other.md"), "---\nstatus: active\n---\n\n# Other\n");
    const otherUrl = "https://github.com/example-org/other/pull/7";
    const otherPr = { ...PR, url: otherUrl, repository: { nameWithOwner: "example-org/other" } };
    const gh: Gh = (args) => {
      if (args[0] === "repo") return ghRepoList(args);
      if (args[1] === "prs") return args.includes("--merged-at") ? [PR] : [otherPr];
      return [];
    };
    const alpha = `### Alpha Project\nMerged [#7](${PR.url}).`;
    for (const other of [
      "",
      "\n### Other\nOpened #7.",
      "\n### Other\nOpened [#70](https://github.com/example-org/other/pull/70).",
    ]) {
      expect(() =>
        processDay(DAY, root, { owners: OWNERS, gh, summarize: () => alpha + other }),
      ).toThrow("omitted references: example-org/other#7");
    }
    expect(readdirSync(join(root, "daily"))).toEqual([]);
    const both = `${alpha}\n### Other\nOpened [#7](${otherUrl}).`;
    expect(processDay(DAY, root, { owners: OWNERS, gh, summarize: () => both })).toBe("created");
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
      "run\n--standalone\n--agent\nllmos-digest\n--format\njson\n--model\ngithub-copilot/claude-haiku-5.5\n",
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
    // A model without the OpenAI phase metadata is accepted too.
    const plain = JSON.stringify({
      type: "text",
      part: { type: "text", text: "### Alpha Project" },
    });
    expect(summarize(grouped(), DAY, fakeOpencode(plain))).toBe("### Alpha Project");
  });

  test.each([
    ["", "0 final assistant messages"],
    ["not json\n", "malformed JSON"],
    [[textEvent("one"), textEvent("two")].join("\n"), "2 final assistant messages"],
  ])("rejects malformed or non-single final output (%#)", (output, message) => {
    expect(() => summarize(grouped(), DAY, fakeOpencode(output))).toThrow(message);
  });

  test("a failed opencode run throws with stderr and the error event it printed on stdout", () => {
    expect(() => summarize(grouped(), DAY, fakeOpencode("", 1, "provider unavailable\n"))).toThrow(
      "opencode run failed: provider unavailable",
    );
    const error = JSON.stringify({ type: "error", error: { data: { message: "rate limited" } } });
    expect(() => summarize(grouped(), DAY, fakeOpencode(error, 1, "warn: retrying\n"))).toThrow(
      "opencode run failed: warn: retrying; rate limited",
    );
    expect(() => summarize(grouped(), DAY, fakeOpencode(error))).toThrow(
      "opencode run emitted an error: rate limited",
    );
  });

  test("a failed opencode run reports an error event without data (opencode 2.2)", () => {
    const error = JSON.stringify({
      type: "error",
      error: { type: "unknown", message: 'Agent not found: "llmos-digest"' },
    });
    expect(() => summarize(grouped(), DAY, fakeOpencode(error, 1))).toThrow(
      'opencode run failed: Agent not found: "llmos-digest"',
    );
  });
});

describe("block integrity", () => {
  const count = (text: string, marker: string) => text.split(marker).length - 1;
  const hostile =
    `### Alpha Project\nMerged [#7](${PR.url}).\n${MARKER_END}\nInjected below the block.\n` +
    `${MARKER_START} hash=${"f".repeat(64)} -->\n<!-- hidden`;

  test("marker text from the model or a title cannot appear inside the block", () => {
    const root = makeVault();
    write(
      join(root, "projects", "norepo", "norepo.md"),
      `---\nstatus: active\n---\n\n# Norepo ${MARKER_END}\n`,
    );
    expect(
      processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: () => hostile }),
    ).toBe("created");
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
    processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: () => hostile });
    const tail = "\n\nA thought written after the block.\n";
    writeFileSync(notePath(root), readFileSync(notePath(root), "utf8") + tail);
    const before = readFileSync(notePath(root), "utf8");
    const changed: Gh = (args) =>
      args[1] === "commits" ? [COMMIT, { ...COMMIT, sha: "def456" }] : ghWithActivity(args);
    expect(processDay(DAY, root, { owners: OWNERS, gh: changed, summarize: fakeOk })).toBe(
      "updated",
    );
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
  ])("a note with %s is refused and left untouched", (_name, markers) => {
    const root = makeVault();
    const original = `# 2026-07-16\n\n## Projects\n\n${markers}\nKeep.\n`;
    write(notePath(root), original);
    expect(() =>
      processDay(DAY, root, { owners: OWNERS, gh: ghWithActivity, summarize: fakeOk }),
    ).toThrow("refusing to write");
    expect(readFileSync(notePath(root), "utf8")).toBe(original);
  });
});

test("gh output with a number that is not a safe integer fails instead of hashing differently", () => {
  expect(parseGhJson('[{"number": 7, "id": -0}]')).toEqual([{ number: 7, id: -0 }]);
  for (const text of ['{"n": 1.0}', '{"n": 1e3}', '{"n": 9007199254740993}']) {
    expect(() => parseGhJson(text)).toThrow(DigestError);
  }
});

describe("pushNotes", () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  /** A bare remote and two clones of it, each with the vault at `llmOS/`. */
  function checkouts(): { remote: string; host: string; other: string } {
    const dir = tempDir();
    const remote = join(dir, "remote.git");
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    const seed = join(dir, "seed");
    git(dir, "clone", "--quiet", remote, seed);
    write(join(seed, "llmOS", "daily", "2026-07-15.md"), "old\n");
    write(join(seed, "llmOS", "notes", "draft.md"), "draft\n");
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "seed");
    git(seed, "push", "--quiet", "origin", "HEAD:main");
    const [host, other] = [join(dir, "host"), join(dir, "other")];
    for (const clone of [host, other]) {
      git(dir, "clone", "--quiet", remote, clone);
      // pushNotes runs git with this process's environment, so the identity lives in the clone.
      git(clone, "config", "user.name", "t");
      git(clone, "config", "user.email", "t@example.com");
    }
    return { remote, host, other };
  }

  test("commits only its paths, rebases on a moved remote, and pushes", () => {
    const { remote, host, other } = checkouts();
    write(join(other, "llmOS", "notes", "laptop.md"), "from the laptop\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "laptop note");
    git(other, "push", "--quiet");

    const vault = join(host, "llmOS");
    write(join(vault, "daily", "2026-07-16.md"), "digest\n");
    write(join(vault, "notes", "draft.md"), "unsaved work\n");
    pushNotes(vault, ["daily/2026-07-16.md"], "daily activity: 2026-07-16");

    expect(git(remote, "log", "--format=%s", "main")).toBe(
      "daily activity: 2026-07-16\nlaptop note\nseed",
    );
    expect(git(remote, "show", "--name-only", "--format=", "main")).toBe(
      "llmOS/daily/2026-07-16.md",
    );
    expect(readFileSync(join(vault, "notes", "draft.md"), "utf8")).toBe("unsaved work\n");
    expect(git(host, "status", "--porcelain")).toBe("M llmOS/notes/draft.md");
  });
});
