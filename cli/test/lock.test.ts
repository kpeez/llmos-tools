import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockRefused, tryLock, waitLock } from "../src/lock.ts";

const LOCK_MODULE = join(import.meta.dir, "../src/lock.ts");

function folder(): string {
  return mkdtempSync(join(tmpdir(), "llmos-lock-"));
}

test("a lock is held by one caller at a time", () => {
  const dir = folder();
  const path = join(dir, "x.lock.db");
  const first = tryLock(path);
  expect(first).not.toBeNull();
  expect(tryLock(path)).toBeNull();
  first?.release();
  const second = tryLock(path);
  expect(second).not.toBeNull();
  second?.release();
  expect(existsSync(path)).toBe(true);
  rmSync(dir, { recursive: true });
});

test("a lock path that is a symbolic link or not a regular file is refused", () => {
  const dir = folder();
  const outside = join(dir, "outside.db");
  symlinkSync(outside, join(dir, "link.db"));
  symlinkSync(join(dir, "nowhere"), join(dir, "dangling.db"));
  mkdirSync(join(dir, "folder.db"));
  for (const name of ["link.db", "dangling.db", "folder.db"]) {
    expect(() => tryLock(join(dir, name))).toThrow(LockRefused);
  }
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(join(dir, "nowhere"))).toBe(false);
  rmSync(dir, { recursive: true });
});

test("many processes over a lock file left by a killed holder never overlap", async () => {
  const dir = folder();
  const path = join(dir, "x.lock.db");
  const inside = join(dir, "inside");
  const worker = `
    import { closeSync, openSync, rmSync } from "node:fs";
    import { waitLock } from ${JSON.stringify(LOCK_MODULE)};
    for (let i = 0; i < 25; i++) {
      const held = waitLock(${JSON.stringify(path)}, 30000);
      if (held === null) { console.error("timeout"); process.exit(1); }
      try { closeSync(openSync(${JSON.stringify(inside)}, "wx")); }
      catch { console.error("two holders"); process.exit(1); }
      Bun.sleepSync(2);
      rmSync(${JSON.stringify(inside)});
      held.release();
    }`;
  const crashed = Bun.spawn(
    [
      "bun",
      "-e",
      `import { tryLock } from ${JSON.stringify(LOCK_MODULE)};
       const held = tryLock(${JSON.stringify(path)}); console.log("held"); setInterval(() => held?.release, 1000);`,
    ],
    { stdout: "pipe" },
  );
  await crashed.stdout.getReader().read();
  expect(waitLock(path, 100)).toBeNull();
  const workers = Array.from({ length: 12 }, () =>
    Bun.spawn(["bun", "-e", worker], { stderr: "pipe" }),
  );
  crashed.kill("SIGKILL");
  const results = await Promise.all(
    workers.map(async (w) => ({
      code: await w.exited,
      err: await new Response(w.stderr).text(),
    })),
  );
  rmSync(dir, { recursive: true });
  expect(results.filter((r) => r.code !== 0)).toEqual([]);
}, 60_000);
