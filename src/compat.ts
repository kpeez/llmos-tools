/**
 * String, path, and date semantics that vault outputs must keep stable.
 *
 * The vault's canonical frontmatter, sort orders, and finding messages were
 * defined by the Python implementation. JavaScript differs on whitespace,
 * line boundaries, string ordering, and quoting, so these helpers reproduce
 * the established behavior exactly.
 */

/** Characters Python's `str.isspace` accepts (bidi WS, B, S, or category Zs). */
export const WHITESPACE =
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

const WHITESPACE_SET = new Set(WHITESPACE);

/** Regex source for one whitespace character, for use inside a character class. */
export const WHITESPACE_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** Regex source for one word character (letters, numbers, underscore), Unicode-aware. */
export const WORD_CLASS = "\\p{L}\\p{N}_";

export function isSpace(char: string): boolean {
  return WHITESPACE_SET.has(char);
}

/** Strip whitespace (or the given characters) from both ends. */
export function strip(value: string, chars?: string): string {
  return rstrip(lstrip(value, chars), chars);
}

export function lstrip(value: string, chars?: string): string {
  const drop = chars === undefined ? WHITESPACE_SET : new Set(chars);
  let start = 0;
  while (start < value.length && drop.has(value[start] as string)) start++;
  return value.slice(start);
}

export function rstrip(value: string, chars?: string): string {
  const drop = chars === undefined ? WHITESPACE_SET : new Set(chars);
  let end = value.length;
  while (end > 0 && drop.has(value[end - 1] as string)) end--;
  return value.slice(0, end);
}

const LINE_BREAKS = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  "\u2028",
  "\u2029",
]);

/** Split on every line boundary Python's `str.splitlines` recognizes. */
export function splitLines(value: string, keepEnds = false): string[] {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < value.length) {
    const char = value[i] as string;
    if (!LINE_BREAKS.has(char)) {
      i++;
      continue;
    }
    const breakEnd = char === "\r" && value[i + 1] === "\n" ? i + 2 : i + 1;
    lines.push(value.slice(start, keepEnds ? breakEnd : i));
    start = breakEnd;
    i = breakEnd;
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

/** Order strings by Unicode code point, not UTF-16 code unit. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = (x.value as string).codePointAt(0) as number;
    const cy = (y.value as string).codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

/** Lexicographic order of string tuples, element by element. */
export function compareTuples(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const order = compareStrings(a[i] as string, b[i] as string);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** Length in code points. */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** Path components the way `pathlib` splits them: empty and `.` parts dropped. */
export function pathParts(path: string): string[] {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return path.startsWith("/") ? ["/", ...parts] : parts;
}

/** Order vault-relative paths by their components, as `sorted()` orders `Path`s. */
export function comparePaths(a: string, b: string): number {
  return compareTuples(pathParts(a), pathParts(b));
}

/** The final path component without its last `.suffix`, as `Path.stem`. */
export function stem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
}

/** The parent directory of a vault-relative path ("" for a root-level file). */
export function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Expand tabs to the next multiple of `size`, restarting at each line break. */
export function expandTabs(value: string, size = 8): string {
  let out = "";
  let column = 0;
  for (const char of value) {
    if (char === "\t") {
      const spaces = size - (column % size);
      out += " ".repeat(spaces);
      column += spaces;
    } else if (char === "\n" || char === "\r") {
      out += char;
      column = 0;
    } else {
      out += char;
      column++;
    }
  }
  return out;
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, "0");
}

/** Quote a string the way Python's `repr` does, for finding messages. */
export function repr(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const items = Object.entries(value).map(([key, item]) => `${repr(key)}: ${repr(item)}`);
    return `{${items.join(", ")}}`;
  }
  if (typeof value !== "string") return String(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === "\\" || char === quote) out += `\\${char}`;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char !== " " && NON_PRINTABLE.test(char)) {
      if (code < 0x100) out += `\\x${hex(code, 2)}`;
      else if (code < 0x10000) out += `\\u${hex(code, 4)}`;
      else out += `\\U${hex(code, 8)}`;
    } else out += char;
  }
  return out + quote;
}

/** A calendar date as a count of days since 1970-01-01. */
export type DayNumber = number;

function dayNumber(year: number, month: number, day: number): DayNumber | null {
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.round(date.getTime() / 86_400_000);
}

/** ISO weekday, Monday 1 to Sunday 7. Day number 0 (1970-01-01) was a Thursday. */
function isoWeekday(day: DayNumber): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/**
 * Parse a date the way CPython's `date.fromisoformat` does (3.11 and
 * later). Like CPython it accepts only strings of 7, 8, or 10 characters,
 * parses `YYYY[-]MM[-]DD` or `YYYY[-]Www[[-]D]` from the start, and ignores
 * any characters after that (so `20261005xx` reads as 2026-10-05). Returns
 * null where Python raises.
 */
export function parseIsoDate(value: string): DayNumber | null {
  if (![7, 8, 10].includes(value.length)) return null;
  let p = 0;
  const digits = (count: number): number | null => {
    const text = value.slice(p, p + count);
    if (!new RegExp(`^[0-9]{${count}}$`).test(text)) return null;
    p += count;
    return Number(text);
  };
  const year = digits(4);
  if (year === null) return null;
  const separator = value[p] === "-";
  if (separator) p++;
  if (value[p] === "W") {
    p++;
    const week = digits(2);
    if (week === null) return null;
    let weekday = 1;
    if (p < value.length) {
      if (separator && value[p++] !== "-") return null;
      const parsed = digits(1);
      if (parsed === null) return null;
      weekday = parsed;
    }
    return isoWeekDate(year, week, weekday);
  }
  const month = digits(2);
  if (month === null) return null;
  if (separator && value[p++] !== "-") return null;
  const day = digits(2);
  if (day === null) return null;
  return dayNumber(year, month, day);
}

function isoWeekDate(year: number, week: number, weekday: number): DayNumber | null {
  const jan4 = dayNumber(year, 1, 4);
  if (jan4 === null) return null;
  if (week < 1 || week > 53) return null;
  if (week === 53) {
    // A year has 53 ISO weeks when Jan 1 is a Thursday, or a Wednesday in a leap year.
    const jan1Weekday = isoWeekday(dayNumber(year, 1, 1) as number);
    const leap = dayNumber(year, 2, 29) !== null;
    if (!(jan1Weekday === 4 || (jan1Weekday === 3 && leap))) return null;
  }
  if (weekday < 1 || weekday > 7) return null;
  const week1Monday = jan4 - (isoWeekday(jan4) - 1);
  return week1Monday + (week - 1) * 7 + (weekday - 1);
}

/** Today's local date as a day number. */
export function today(): DayNumber {
  const now = new Date();
  return dayNumber(now.getFullYear(), now.getMonth() + 1, now.getDate()) as number;
}

/** Format a day number as `YYYY-MM-DD`. */
export function isoDate(day: DayNumber): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
