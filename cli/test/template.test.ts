import { describe, expect, test } from "bun:test";
import { expandTemplate } from "../src/template.ts";

// 2026-03-05 07:09 local time.
const now = new Date(2026, 2, 5, 7, 9);
const context = { title: "My note", now, dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" };

describe("expandTemplate follows the Obsidian Templates plugin", () => {
  test.each([
    ["{{title}}", "My note"],
    ["{{date}} {{time}}", "2026-03-05 07:09"],
    ["{{date:dddd, MMM D}}", "Thursday, Mar 5"],
    ["{{time:h:mm a}}", "7:09 am"],
    ["{{date:[Year] YYYY}}", "Year 2026"],
    ["{{date:}}", "2026-03-05"],
    ["{{Title}} {{foo}} {{date:YYYY", "{{Title}} {{foo}} {{date:YYYY"],
    ["{{title}} and {{title}}", "My note and My note"],
  ])("%s", (template, expected) => {
    expect(expandTemplate(template, context)).toBe(expected);
  });

  test("a bare date and time use the configured formats", () => {
    const custom = { ...context, dateFormat: "DD/MM/YY", timeFormat: "HH:mm:ss" };
    expect(expandTemplate("{{date}} {{time}}", custom)).toBe("05/03/26 07:09:00");
  });
});
