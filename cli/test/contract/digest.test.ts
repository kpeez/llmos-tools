/**
 * The activity digest's external contract on the digest edge days: run in
 * order on one generated vault, with the stand-in `gh` and model, each day's
 * outcome, `gh` calls, required references, block hash, markers, note, and
 * vault files must equal the committed snapshot (see `snapshot.ts`), and a
 * second run must change nothing.
 */

import { expect, test } from "bun:test";
import { EDGE_DAYS } from "./digest_edge.ts";
import { runEdgeDays } from "./digest_run.ts";
import { DIGEST_SNAPSHOT_PATH, type DigestSnapshot, NO_OP, readSnapshot } from "./snapshot.ts";

const snapshot = readSnapshot<DigestSnapshot>(DIGEST_SNAPSHOT_PATH);

test("the snapshot covers the edge days in order, with the outcomes they exist for", () => {
  expect(snapshot.days.map((day) => day.day)).toEqual(EDGE_DAYS.map(([day]) => day));
  for (const [day, outcome] of EDGE_DAYS) {
    const recorded = snapshot.days.find((entry) => entry.day === day);
    const stdout = recorded?.exit === 0 ? recorded.stdout.trim().replace(`${day}: `, "") : "failed";
    expect(`${day}: ${stdout}`).toBe(`${day}: ${outcome}`);
  }
  for (const day of snapshot.days) {
    if (day.exit === 0) expect(day.again).toMatch(NO_OP);
  }
});

test(
  "every edge day matches the snapshot, and a second run is a no-op",
  () => {
    const observed = runEdgeDays(snapshot.days.map((day) => day.day));
    for (const [index, recorded] of snapshot.days.entries()) {
      const { againChangedFiles, ...day } = observed[index] as (typeof observed)[number];
      expect(day).toEqual(recorded);
      expect(againChangedFiles).toBe(false);
    }
  },
  { timeout: 120_000 },
);
