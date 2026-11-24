const CONTROLS = `${Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("")}\x7f`;

/** A regex for one character of `chars`, written as `\u` escapes so no control character is in the source. */
export function anyOf(chars: string): RegExp {
  const escapes = Array.from(
    chars,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return new RegExp(`[${escapes.join("")}]`);
}

/** A regex for one C0 control character or DEL, except those in `allow`, plus those in `add`. */
export function controlCharacters(allow = "", add = ""): RegExp {
  return anyOf(
    Array.from(CONTROLS)
      .filter((char) => !allow.includes(char))
      .join("") + add,
  );
}
