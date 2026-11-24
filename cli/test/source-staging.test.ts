import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PdfConversion, PdfConverter } from "../src/pdf.ts";
import { CLI, cli, executable, isolatedEnv, makeVault, scratch } from "./helpers.ts";

const STRUCTURED = JSON.stringify({
  pages: [{ page_idx: 0, blocks: [{ type: "text", captions: [] }] }],
  metadata: { producer: { version: "4.0.12" }, document: { title: "A study" } },
  extensions: { mineru: { tier: "advanced" } },
});

/**
 * A PATH with a `mineru-kit` and an `unzip` that stand in for MinerU: the
 * first writes nothing, the second lays out the conversion as `unzip -q ZIP -d OUT` would.
 */
function fakeMineruPath(): string {
  const bin = scratch("mineru");
  writeFileSync(join(bin, "structured_content.json"), STRUCTURED);
  executable(join(bin, "mineru-kit"), "#!/bin/sh\n");
  executable(
    join(bin, "unzip"),
    `#!/bin/sh
mkdir -p "$4/images"
for n in 1 2 3 4; do head -c 41943040 /dev/zero > "$4/images/$n.jpg"; done
echo "![](images/1.jpg) ![](images/2.jpg) ![](images/3.jpg) ![](images/4.jpg)" > "$4/markdown.md"
cp "${bin}/structured_content.json" "$4/structured_content.json"
`,
  );
  return `${bin}:/usr/bin:/bin`;
}

const convertPdf: PdfConverter = async () =>
  ({
    markdown: "Text of the study.\n",
    structured: JSON.parse(STRUCTURED),
    images: new Map(),
  }) satisfies PdfConversion;

const rawFolders = (root: string): string[] =>
  readdirSync(join(root, "raw"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();

const stagingOf = (root: string): string[] =>
  rawFolders(root).filter((name) => name.startsWith("."));

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("source add staging", () => {
  test("a capture killed with SIGKILL leaves no staging folder after the next capture", async () => {
    const root = makeVault();
    mkdirSync(join(root, "raw"));
    writeFileSync(join(root, "raw", "big.pdf"), Buffer.alloc(48 * 1024 * 1024, 1));
    writeFileSync(join(root, "raw", "small.pdf"), "%PDF-1.4 small");
    const victim = Bun.spawn(
      [process.execPath, join(CLI, "bin/llmos.ts"), "source", "add", "raw/big.pdf"],
      {
        env: { ...isolatedEnv({ LLMOS_ROOT: root }), PATH: fakeMineruPath() },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    while (victim.exitCode === null && stagingOf(root).length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    victim.kill("SIGKILL");
    await victim.exited;
    expect(victim.signalCode).toBe("SIGKILL");
    expect(stagingOf(root)).toHaveLength(1);

    const next = await cli(root, ["source", "add", "raw/small.pdf"], { convertPdf });
    expect(next.exitCode).toBe(0);
    expect(stagingOf(root)).toEqual([]);
    expect(rawFolders(root)).toHaveLength(1);
  }, 60_000);

  test("a capture removes the marked staging of dead captures only", async () => {
    const root = makeVault({ "raw/small.pdf": "%PDF-1.4 small" });
    const sources = join(root, "raw");
    const live = Bun.spawn(["sleep", "60"]);
    try {
      const dead = await deadPid();
      const outside = scratch("outside");
      writeFileSync(join(outside, "keep.txt"), "keep");
      const staging = (pid: number): string => `.paper-${pid}-abc123`;
      for (const name of [staging(dead), staging(live.pid)]) {
        mkdirSync(join(sources, name, "assets"), { recursive: true });
        writeFileSync(join(sources, name, "source.md"), "partial");
        writeFileSync(join(sources, name, ".llmos-staging"), "");
      }
      mkdirSync(join(sources, `.hand-${dead}-abcdef`));
      writeFileSync(join(sources, `.hand-${dead}-abcdef`, "u.txt"), "mine");
      mkdirSync(join(sources, `.empty-${dead}-abcdef`));
      mkdirSync(join(sources, ".notes"));
      mkdirSync(join(sources, `paper-${dead}-abc123`));
      symlinkSync(outside, join(sources, `.linked-${dead}-abc123`));

      const result = await cli(root, ["source", "add", "raw/small.pdf"], { convertPdf });
      expect(result.exitCode).toBe(0);
      const left = rawFolders(root);
      expect(left).toContain(staging(live.pid));
      expect(left).toContain(".notes");
      expect(left).toContain(`.hand-${dead}-abcdef`);
      expect(readFileSync(join(sources, `.hand-${dead}-abcdef`, "u.txt"), "utf8")).toBe("mine");
      expect(left).toContain(`paper-${dead}-abc123`);
      expect(left).toContain(`.linked-${dead}-abc123`);
      expect(left).not.toContain(staging(dead));
      expect(left).not.toContain(`.empty-${dead}-abcdef`);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    } finally {
      live.kill();
    }
  });
});
