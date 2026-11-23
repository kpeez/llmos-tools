/**
 * A port of Python's `shlex` lexer in POSIX mode with `whitespace_split`.
 * It is not a shell parser.
 *
 * Two changes from Python, with operators on, to match the shell: an unquoted
 * newline is an operator token, because the shell runs the text after it as a
 * new command; and a backslash-newline outside single quotes is dropped,
 * because the shell joins the two lines.
 */

const WHITESPACE = " \t\r\n";
const QUOTES = "'\"";
const ESCAPE = "\\";
const ESCAPED_QUOTES = '"';
const PUNCTUATION = "();<>|&\n";

/** An unterminated quote or a trailing escape, as Python's `ValueError`. */
export class ShlexError extends Error {
  override name = "ShlexError";
}

interface Options {
  /** Split shell operators into their own tokens (`punctuation_chars=True`). */
  punctuation: boolean;
  /** Characters that start a comment to the end of the line. */
  commenters: string;
}

function tokens(input: string, options: Options): string[] {
  const chars = Array.from(input);
  const punctuation = options.punctuation ? PUNCTUATION : "";
  const whitespace = options.punctuation ? WHITESPACE.replace("\n", "") : WHITESPACE;
  const { commenters } = options;
  const pushback: string[] = [];
  let position = 0;
  const read = (): string => {
    if (punctuation && pushback.length > 0) return pushback.pop() as string;
    return position < chars.length ? (chars[position++] as string) : "";
  };
  const skipLine = (): void => {
    while (position < chars.length && chars[position] !== "\n") position++;
  };
  const has = (set: string, char: string): boolean => char !== "" && set.includes(char);

  const found: string[] = [];
  let state: string | null = " ";
  for (;;) {
    let quoted = false;
    let escapedState = " ";
    let token = "";
    for (;;) {
      const char = read();
      if (state === null) {
        token = "";
        break;
      }
      if (state === " ") {
        if (!char) {
          state = null;
          break;
        } else if (has(whitespace, char)) {
          if (token || quoted) break;
        } else if (has(commenters, char)) {
          skipLine();
        } else if (has(ESCAPE, char)) {
          escapedState = "a";
          state = char;
        } else if (has(punctuation, char)) {
          token = char;
          state = "c";
        } else if (has(QUOTES, char)) {
          state = char;
        } else {
          token = char;
          state = "a";
        }
      } else if (has(QUOTES, state)) {
        quoted = true;
        if (!char) throw new ShlexError("No closing quotation");
        if (char === state) {
          state = "a";
        } else if (has(ESCAPE, char) && has(ESCAPED_QUOTES, state)) {
          escapedState = state;
          state = char;
        } else {
          token += char;
        }
      } else if (has(ESCAPE, state)) {
        if (!char) throw new ShlexError("No escaped character");
        if (punctuation && char === "\n") {
          state = has(QUOTES, escapedState) ? escapedState : token || quoted ? "a" : " ";
          continue;
        }
        // Inside quotes only the quote itself or the escape can be escaped.
        if (has(QUOTES, escapedState) && char !== state && char !== escapedState) {
          token += state;
        }
        token += char;
        state = escapedState;
      } else {
        // state is "a" (a word) or "c" (a run of punctuation)
        if (!char) {
          state = null;
          break;
        } else if (has(whitespace, char)) {
          state = " ";
          if (token || quoted) break;
        } else if (has(commenters, char)) {
          skipLine();
          state = " ";
          if (token || quoted) break;
        } else if (state === "c") {
          if (has(punctuation, char)) {
            token += char;
          } else {
            if (!has(whitespace, char)) pushback.push(char);
            state = " ";
            break;
          }
        } else if (has(QUOTES, char)) {
          state = char;
        } else if (has(ESCAPE, char)) {
          escapedState = "a";
          state = char;
        } else if (!has(punctuation, char)) {
          token += char;
        } else {
          pushback.push(char);
          state = " ";
          break;
        }
      }
    }
    // An empty unquoted result is the end of input (`None` in POSIX mode).
    if (token === "" && !quoted) return found;
    found.push(token);
  }
}

/** Python's `shlex.split(command)`. Throws `ShlexError`. */
export function split(command: string): string[] {
  return tokens(command, { punctuation: false, commenters: "" });
}

/**
 * Python's `list(shlex.shlex(command, posix=True, punctuation_chars=True))`
 * with `whitespace_split = True`: operators such as `&&` or `>` become their
 * own tokens even without spaces around them, and `#` starts a comment.
 * Throws `ShlexError`.
 */
export function splitWithOperators(command: string): string[] {
  return tokens(command, { punctuation: true, commenters: "#" });
}
