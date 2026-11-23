/**
 * The one place that turns a vault-relative path into a file the code may
 * read or write. `resolveInVault` is the only constructor of `VaultFile`,
 * and `readText` and the note writes (`write.ts`) accept only a `VaultFile`,
 * so a path that was not checked cannot reach them. Biome bans
 * `readFileSync` elsewhere in the vault-handling modules (`biome.json`).
 *
 * A `VaultFile` is the real path of a regular file inside the real vault
 * root. A symbolic link, a `..`, or a dot folder (`.trash/`, `.obsidian/`)
 * never gives one that escapes the vault or reads hidden state.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve, sep } from "node:path";

/** A write or read the caller asked for cannot be done; nothing was done. */
export class WriteRefused extends Error {
  override name = "WriteRefused";
}

declare const vaultFile: unique symbol;

/** The real path of a regular file inside the real vault root; made only by `resolveInVault`. */
export type VaultFile = string & { readonly [vaultFile]: true };

/** Whether `path` is `folder` itself or inside it (both absolute and real). */
export function within(folder: string, path: string): boolean {
  const rest = relativePath(folder, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/**
 * The absolute path of vault-relative `relative`, checked lexically: not
 * absolute, and no `..` that leaves the vault. Symbolic links are not
 * resolved; `realTarget` and `newTarget` do that.
 */
export function insideVault(root: string, relative: string): string {
  const absolute = resolve(root, relative);
  if (
    relative === "" ||
    isAbsolute(relative) ||
    !within(resolve(root), absolute) ||
    absolute === resolve(root)
  ) {
    throw new WriteRefused(`'${relative}' is not a path inside the vault`);
  }
  return absolute;
}

/** The real path of an existing file or folder, refused unless it is inside the real vault root. */
export function realTarget(root: string, relative: string): string {
  const real = realpathSync(insideVault(root, relative));
  if (!within(realpathSync(root), real)) {
    throw new WriteRefused(`'${relative}' resolves to ${real}, which is outside the vault`);
  }
  return real;
}

const inDotFolder = (path: string): boolean => path.split(sep).some((part) => part.startsWith("."));

/**
 * The checked file at vault-relative `relative`: its real path is inside the
 * real vault root, it is a regular file, and neither the path nor its real
 * path passes through a dot folder. Anything else throws `WriteRefused`; a
 * link to a missing file does too, and a missing file throws the OS error
 * (`ENOENT`).
 */
export function resolveInVault(root: string, relative: string): VaultFile {
  const absolute = insideVault(root, relative);
  if (inDotFolder(relativePath(resolve(root), absolute))) {
    throw new WriteRefused(`'${relative}' is in a dot folder, which the vault code does not touch`);
  }
  let real: string;
  try {
    real = realTarget(root, relative);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    try {
      lstatSync(absolute);
    } catch {
      throw error;
    }
    throw new WriteRefused(`'${relative}' is a link to a missing file`);
  }
  if (inDotFolder(relativePath(realpathSync(root), real))) {
    throw new WriteRefused(`'${relative}' resolves into a dot folder`);
  }
  if (!statSync(real).isFile()) throw new WriteRefused(`'${relative}' is not a regular file`);
  return real as VaultFile;
}

/** Whether `error` says `resolveInVault` refused the path or nothing is there. */
export function refusedOrMissing(error: unknown): boolean {
  return error instanceof WriteRefused || (error as { code?: unknown }).code === "ENOENT";
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decode `bytes` the way Python's text mode does: `\r\n` and `\r` become
 * `\n`, a byte-order mark is kept, and invalid UTF-8 throws (a `TypeError`),
 * so a later rewrite can never replace undecodable bytes.
 */
export function decodeText(bytes: Uint8Array): string {
  return UTF8.decode(bytes).replace(/\r\n?/g, "\n");
}

/**
 * The text of the note at vault-relative `relative`, which the vault walk
 * (`walkVault`) listed. It follows a symbolic link wherever it points, as
 * Obsidian shows the note, so it is the one read that may leave the vault:
 * use it only for a path from the walk, and `resolveInVault` for any other.
 * A path with `..` or an absolute path is refused.
 */
export function readWalkedNote(root: string, relative: string): string {
  return decodeText(readFileSync(insideVault(root, relative)));
}

/** The text of a checked vault file (see `decodeText`). */
export function readText(file: VaultFile): string {
  return decodeText(readFileSync(file));
}
