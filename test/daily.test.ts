import { describe, expect, test } from "bun:test";
import { bodyWithThought, MachineOwnedBlock } from "../src/daily.ts";

const block =
  "<!-- llmos-activity:start hash=abc -->\n\n- did things  \n\n<!-- llmos-activity:end -->\n";

describe("bodyWithThought", () => {
  test("appends a paragraph under ## Thoughts and keeps the activity block byte for byte", () => {
    const body = `# 2026-10-07\n\n## Thoughts\n\nFirst.\n\n\n## Projects\n\n${block}`;
    expect(bodyWithThought(body, "  Second.  ")).toBe(
      `# 2026-10-07\n\n## Thoughts\n\nFirst.\n\nSecond.\n\n## Projects\n\n${block}`,
    );
  });

  test("refuses marker syntax in the thought and a body without markers", () => {
    const body = `## Thoughts\n\n## Projects\n\n${block}`;
    expect(() => bodyWithThought(body, "<!-- llmos-activity:end -->")).toThrow(MachineOwnedBlock);
    expect(() => bodyWithThought("## Thoughts\n", "x")).toThrow(MachineOwnedBlock);
  });
});
