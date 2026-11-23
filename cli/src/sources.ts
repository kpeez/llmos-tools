/**
 * Source capture: freeze one web page, arXiv paper, or PDF into
 * `raw/<slug>/` with its raw bytes (`raw.html` or `raw.pdf`), the images of
 * its figures (`assets/`), and the converted text with a manifest in its
 * frontmatter (`source.md`). Nothing edits the folder afterwards.
 *
 * The network is the injected `Fetcher`, so tests replay recorded pages, and
 * the PDF converter is the injected `PdfConverter`. A capture builds the
 * folder beside its final place and renames it in, so a failure leaves
 * nothing behind.
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { markDirty } from "./dirty.ts";
import { parse, serialize } from "./frontmatter.ts";
import { destinationProperties } from "./inbox.ts";
import { RAW_DIR } from "./layout.ts";
import { mineruName, type PdfConverter, pdfText } from "./pdf.ts";
import { newTarget, realTarget } from "./write.ts";

/** One fetched resource: the status, the final URL after redirects, and the bytes. */
export interface Fetched {
  status: number;
  url: string;
  contentType: string;
  body: Uint8Array;
}

/** Fetch one URL. A real run uses `httpFetch`; tests replay recorded files. */
export type Fetcher = (url: string) => Promise<Fetched>;

/** The capture cannot be done; nothing was written and an inbox item stays where it is. */
export class SourceRefused extends Error {
  override name = "SourceRefused";
}

/** A URL the capture will not request: not http(s), or aimed at a local or private address. */
export class BlockedUrl extends SourceRefused {}

/** The IP addresses a host name resolves to. */
export type Lookup = (host: string) => Promise<string[]>;

const resolveHost: Lookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address);

const MAX_REDIRECTS = 5;

/** The IPv4 address as a number, or null when `address` is not dotted IPv4. */
function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  return parts.reduce((total, part) => total * 256 + part, 0);
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.split("%")[0] as string;
  if (isIP(bare) !== 6) return null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  const tail = dotted ? ipv4Number(dotted[2] as string) : null;
  const text = dotted
    ? tail === null
      ? null
      : `${dotted[1]}${Math.floor(tail / 65536).toString(16)}:${(tail % 65536).toString(16)}`
    : bare;
  if (text === null) return null;
  const [head = "", rest, extra] = text.split("::");
  if (extra !== undefined) return null;
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(fill, 0)).fill("0"), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * Whether `address` may not be requested. IPv4: unspecified, private,
 * CGNAT, loopback, link-local, benchmarking (198.18/15), multicast, and
 * reserved (everything from 224.0.0.0 up). IPv6 is an allowlist: only global
 * unicast 2000::/3 counts as public, minus 6to4 (2002::/16) and Teredo
 * (2001::/32), which embed IPv4 addresses, and documentation (2001:db8::/32).
 * So IPv4-mapped, IPv4-compatible, NAT64, loopback, ULA, and link-local
 * forms are all local, however they are written.
 */
export function isLocalAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    const inside = (base: string, bits: number): boolean => {
      const start = ipv4Number(base) as number;
      return Math.floor(v4 / 2 ** (32 - bits)) === Math.floor(start / 2 ** (32 - bits));
    };
    return (
      inside("0.0.0.0", 8) ||
      inside("10.0.0.0", 8) ||
      inside("100.64.0.0", 10) ||
      inside("127.0.0.0", 8) ||
      inside("169.254.0.0", 16) ||
      inside("172.16.0.0", 12) ||
      inside("192.168.0.0", 16) ||
      inside("198.18.0.0", 15) ||
      inside("224.0.0.0", 3)
    );
  }
  const groups = ipv6Groups(address);
  if (groups === null) return true; // not an address we can judge: refuse
  const [first = 0, second = 0] = groups;
  if ((first & 0xe000) !== 0x2000) return true;
  return first === 0x2002 || (first === 0x2001 && (second === 0 || second === 0x0db8));
}

/** Throw `BlockedUrl` unless `url` is http(s) on a named host that resolves only to public addresses. */
export async function assertPublicUrl(url: string, lookup: Lookup): Promise<void> {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new BlockedUrl(`${url} is not an http or https URL.`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) throw new BlockedUrl(`${url} names an IP address, not a host.`);
  const addresses = await lookup(host);
  if (addresses.length === 0 || addresses.some(isLocalAddress)) {
    throw new BlockedUrl(`${url} resolves to a local or private address.`);
  }
}

/** The largest response body a capture accepts. */
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

/** Read a response body, refusing one over `max` bytes by its header or while streaming. */
async function readCapped(response: Response, url: string, max: number): Promise<Uint8Array> {
  const tooLarge = (): SourceRefused => new SourceRefused(`${url} is larger than ${max} bytes.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * A fetcher for the real network. It checks every URL it requests, redirect
 * hops included, with `assertPublicUrl`, follows at most five redirects,
 * gives each request 60 seconds, and refuses a body over `maxBytes`. Every
 * failure (DNS, timeout, a bad `Location`) is a `SourceRefused` that names
 * the URL. `lookup` and `request` default to the system resolver and
 * `fetch`. The check resolves a host before `fetch` resolves it again, so a
 * host that changes its answer between the two is not caught.
 */
export function networkFetcher(
  lookup: Lookup = resolveHost,
  request: typeof fetch = fetch,
  maxBytes: number = MAX_BODY_BYTES,
): Fetcher {
  const follow = async (start: string): Promise<Fetched> => {
    let url = start;
    for (let hops = 0; ; hops++) {
      await assertPublicUrl(url, lookup);
      const response = await request(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
        headers: { "user-agent": "llmos source add" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (hops >= MAX_REDIRECTS) {
          throw new SourceRefused(`${start} redirects more than ${MAX_REDIRECTS} times.`);
        }
        url = new URL(location, url).href;
        continue;
      }
      return {
        status: response.status,
        url,
        contentType: response.headers.get("content-type") ?? "",
        body: await readCapped(response, url, maxBytes),
      };
    }
  };
  return async (start) => {
    try {
      return await follow(start);
    } catch (error) {
      if (error instanceof SourceRefused) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new SourceRefused(`could not fetch ${start}: ${reason}`);
    }
  };
}

/** The real network fetch. */
export const httpFetch: Fetcher = networkFetcher();

export interface CaptureResult {
  /** `captured` wrote a new folder; `unchanged` found the source already there. */
  status: "captured" | "unchanged";
  /** Vault-relative folder. */
  folder: string;
  sourceId: string;
  figures: number;
  /** Figure images that were not saved, each with the reason. */
  skipped: string[];
  /** Problems after the capture was in place, such as a failed disk flush. */
  warnings: string[];
}

export interface CaptureContext {
  fetch: Fetcher;
  convertPdf: PdfConverter;
  today: () => string;
}

/** `--origin` and `--licence`: what a PDF file or a web PDF cannot state itself. */
export interface CaptureOptions {
  origin?: string;
  licence?: string;
}

type Target =
  | { kind: "arxiv"; id: string; version: string | undefined }
  | { kind: "web"; url: string }
  | { kind: "file"; path: string };

/** Each kind of capture, and the options it takes instead of reading the value from the source. */
const TAKES = {
  "web page": { origin: false, licence: false },
  "arXiv HTML": { origin: false, licence: false },
  "arXiv PDF": { origin: false, licence: false },
  "web PDF": { origin: false, licence: true },
  "PDF file": { origin: true, licence: true },
} as const;

type Kind = keyof typeof TAKES;

/** A source found and fetched, not yet converted. */
type Located = {
  kind: Kind;
  sourceId: string;
  origin: string;
  licence: string;
  raw: Uint8Array;
} & ({ format: "html"; html: string } | { format: "pdf" });

/** The converted text of a source and the files that go beside it. */
interface Converted {
  text: string;
  converter: string;
  figures: number;
  assets: { name: string; bytes: Uint8Array }[];
  skipped: string[];
  /** Doubts about the text that do not stop the capture. */
  warnings: string[];
}

const ARXIV_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_PATH = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?\/?$/i;
const OLD_ID = /^(?:[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?$/i;
const OLD_ARXIV_PATH =
  /^\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Za-z]{2})?\/\d{7}(?:v\d+)?)(?:\.pdf)?\/?$/i;
const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)/i;
const NOT_STATED = "not stated";

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `url` without fragment or user name and password, or null when it is not a URL. */
function cleanUrl(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

function refuseOldId(id: string): never {
  throw new SourceRefused(
    `'${id}' is an old-style arXiv ID; only IDs like 1811.00743 are supported. Left in place.`,
  );
}

/**
 * What an argument names: an arXiv ID or URL, a web URL, a PDF file (in the
 * vault or elsewhere), or an inbox note (a vault-relative path) that holds
 * only a URL.
 */
function resolveTarget(root: string, argument: string, fromNote = false): Target {
  const text = argument.trim();
  const bare = ARXIV_ID.exec(text.replace(/^arxiv:/i, ""));
  if (bare) return { kind: "arxiv", id: bare[1] as string, version: bare[2] };
  if (OLD_ID.test(text.replace(/^arxiv:/i, ""))) refuseOldId(text);
  if (/^https?:\/\//i.test(text)) {
    const cleaned = cleanUrl(text);
    const url = cleaned === null ? null : new URL(cleaned);
    if (url === null) throw new SourceRefused(`'${text}' is not a valid URL.`);
    if (/^(?:www\.)?arxiv\.org$/i.test(url.hostname)) {
      const arxiv = ARXIV_PATH.exec(url.pathname);
      if (arxiv) return { kind: "arxiv", id: arxiv[1] as string, version: arxiv[2] };
      const old = OLD_ARXIV_PATH.exec(url.pathname);
      if (old) refuseOldId(old[1] as string);
    }
    return { kind: "web", url: url.href };
  }
  if (/\.pdf$/i.test(text)) return { kind: "file", path: pdfFile(root, text) };
  const note = text.endsWith(".md") ? text : `${text}.md`;
  if (fromNote || !existsSync(join(root, note))) {
    throw new SourceRefused(
      `'${text}' is not an arXiv ID, a URL, or an existing note that holds only a URL.`,
    );
  }
  const body = parse(readFileSync(realTarget(root, note), "utf8")).body.trim();
  const link = /^<?(https?:\/\/\S+?)>?$/.exec(body);
  if (link === null) {
    throw new SourceRefused(
      `'${text}' holds more than a bare URL, so it is not captured; run 'source add <url>' on the URL itself.`,
    );
  }
  return resolveTarget(root, link[1] as string, true);
}

/** The real path of a PDF named by a vault-relative path, else by a file system path. */
function pdfFile(root: string, path: string): string {
  const inVault = join(root, path);
  const file =
    !isAbsolute(path) && !relative(root, inVault).startsWith("..") && existsSync(inVault)
      ? realTarget(root, path)
      : resolve(path);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new SourceRefused(`no PDF file at '${path}'.`);
  }
  if (statSync(file).size > MAX_BODY_BYTES) {
    throw new SourceRefused(`'${path}' is larger than ${MAX_BODY_BYTES} bytes.`);
  }
  return file;
}

/** `text` as the recorded origin of a PDF file: a clean http or https URL. */
function originOption(text: string): string {
  const cleaned = cleanUrl(text);
  if (cleaned === null || !/^https?:/.test(cleaned)) {
    throw new SourceRefused(`--origin must be an http or https URL, not '${text}'.`);
  }
  return cleaned;
}

/** The slug words come from the URL of a web source or a PDF's `--origin`, else from the file name. */
function slugOf(target: Target, sourceId: string, origin: string): string {
  if (target.kind === "arxiv") return `arxiv-${sourceId.slice("arxiv:".length)}`;
  const named = target.kind === "web" ? target.url : origin;
  const url = URL.parse(named);
  const text =
    url !== null && /^https?:$/.test(url.protocol)
      ? `${url.hostname.replace(/^www\./, "")}${url.pathname}`
      : basename(named.replace(/^file:/, "")).replace(/\.pdf$/i, "");
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${words}-${sha256(sourceId).slice(0, 8)}`;
}

/** A folder's manifest; a missing or unreadable `source.md` gives no properties. */
function manifestOf(folder: string): Record<string, unknown> {
  try {
    return parse(readFileSync(join(folder, "source.md"), "utf8")).properties;
  } catch {
    return {};
  }
}

/**
 * The captured folder that already holds this source. An unversioned arXiv
 * ID names no version before the network is asked, so any captured version
 * of the paper counts; a newer version needs its `vN`. A folder whose
 * `source.md` cannot be read holds no source here and is skipped.
 */
function existingFolder(
  sources: string,
  target: Target,
  sourceId: string | undefined,
): string | undefined {
  if (!existsSync(sources)) return undefined;
  const names = readdirSync(sources).filter((name) => !name.startsWith("."));
  if (sourceId === undefined && target.kind === "arxiv") {
    return names.find((name) => name.startsWith(`arxiv-${target.id}v`));
  }
  return names.find((name) => manifestOf(join(sources, name)).source_id === sourceId);
}

function body(label: string, response: Fetched): Uint8Array {
  if (response.status !== 200)
    throw new SourceRefused(`${label} answered HTTP ${response.status}.`);
  return response.body;
}

/** The page text, in the charset the headers or a `<meta>` tag name, else UTF-8. */
function decodePage(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const label =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label as "utf-8").decode(bytes); // an unknown label throws
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

interface Figure {
  caption: string;
  images: string[];
}

/**
 * The figures of a page: a top-level `<figure>` (none above it) with a
 * `<figcaption>` of its own, as a direct child. Panels inside it do not
 * count, and their captions are not its caption. On arXiv's LaTeXML pages a
 * figure counts only when it has class `ltx_figure` and not `ltx_lstlisting`;
 * tables, algorithms, and listings carry other `ltx_` classes.
 */
function captionedFigures(html: string, base: string): Figure[] {
  const { document } = parseHTML(html);
  const figures: Figure[] = [];
  for (const element of document.querySelectorAll("figure")) {
    if (element.parentElement?.closest("figure")) continue;
    const classes = element.getAttribute("class") ?? "";
    if (
      /\bltx_/.test(classes) &&
      (!/\bltx_figure\b/.test(classes) || /\bltx_lstlisting\b/.test(classes))
    ) {
      continue;
    }
    const caption = [...element.children].find(
      (child) => child.tagName.toLowerCase() === "figcaption",
    );
    if (caption === undefined) continue;
    const images: string[] = [];
    for (const image of element.querySelectorAll("img")) {
      const source = image.getAttribute("src");
      if (!source) continue;
      const resolved = URL.parse(source, base);
      const web = resolved?.protocol === "http:" || resolved?.protocol === "https:";
      if (resolved && web && !images.includes(resolved.href)) images.push(resolved.href);
    }
    figures.push({ caption: (caption.textContent ?? "").replace(/\s+/g, " ").trim(), images });
  }
  return figures;
}

/** `href` resolved against `base`, or `href` when that fails. */
function absolute(href: string, base: string): string {
  return URL.parse(href, base)?.href ?? href;
}

/** The licence as a web page states it: a licence link, or a rights meta tag. */
function webLicence(html: string, base: string): string {
  const { document } = parseHTML(html);
  const href = document
    .querySelector('a[rel~="license"], link[rel~="license"]')
    ?.getAttribute("href");
  if (href) return absolute(href, base);
  for (const meta of document.querySelectorAll("meta")) {
    const name = (meta.getAttribute("name") ?? "").toLowerCase();
    const content = meta.getAttribute("content");
    if ((name === "dc.rights" || name === "citation_license") && content) return content;
  }
  return "not stated";
}

/** The licence link of an arXiv abstract page. */
function arxivLicence(page: string, base: string): string {
  const { document } = parseHTML(page);
  const href = document.querySelector(".abs-license a")?.getAttribute("href");
  return href ? absolute(href, base) : "not stated";
}

function converterName(): string {
  const manifest = new URL("../package.json", import.meta.resolve("defuddle/node"));
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  return `defuddle@${version}`;
}

/** `name` made safe as a file name and unique among `taken` ignoring case (macOS folds case). */
export function uniqueName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, "_");
  let unique = base;
  for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${n}-${base}`;
  taken.add(unique.toLowerCase());
  return unique;
}

/** A file name for the image at `url`. */
function assetName(url: string, taken: Set<string>): string {
  return uniqueName(new URL(url).pathname.split("/").pop() || "figure", taken);
}

/** Write `data` to a new file and flush it to disk. */
function writeSynced(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o644);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncFolder(folder: string): void {
  const fd = openSync(folder, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const WHITESPACE = /\s/;
const isSpace = (char: string | undefined): boolean => char !== undefined && WHITESPACE.test(char);
const isTargetEnd = (char: string): boolean =>
  isSpace(char) || char === "<" || char === ">" || char === ")";

/**
 * Drop the brackets around an image's alt text when the whole alt is one
 * bracketed phrase with no inner brackets, such as arXiv's
 * `[Uncaptioned image]`. Defuddle writes it as `![[Uncaptioned image]](url)`,
 * which Obsidian and `health` read as an embed of a missing note, and which
 * `pointImagesAtAssets` would not recognize as an image.
 */
export function unwrapBracketedAlts(text: string): string {
  return text.replace(/!\[\[([^[\]\n]*)\]\]\(/g, "![$1](");
}

/**
 * Point Markdown images at their local copies: in `![alt](url)`,
 * `![alt](<url>)`, and `![alt](url "title")`, a `url` that equals a
 * downloaded image URL exactly becomes `assets/<name>`. Links and longer
 * URLs stay as they are. This is one forward scan with no backtracking, so
 * it takes time proportional to the text length times the longest asset URL;
 * an earlier regex took quadratic time on text such as `![a](` repeated.
 * Unlike that regex, an image written inside the target of a non-asset image
 * is also rewritten. Each rewritten URL is added to `used`.
 */
export function pointImagesAtAssets(
  text: string,
  assets: ReadonlyMap<string, { name: string }>,
  used?: Set<string>,
): string {
  const longest = [...assets.keys()].reduce((most, url) => Math.max(most, url.length), 0);
  const pieces: string[] = [];
  let copied = 0; // text before this index is already in `pieces`
  let from = 0; // an image may not start before the end of the last rewrite
  let label = -1; // the start of an open `![` label with no `]` after it, or -1
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "[") {
      if (text[i - 1] === "!" && i - 1 >= from) label = i - 1;
      continue;
    }
    if (char !== "]") continue;
    const open = label;
    label = -1;
    if (open === -1 || text[i + 1] !== "(") continue;

    let at = i + 2;
    while (isSpace(text[at])) at++;
    if (text[at] === "<") at++;
    const start = at;
    while (at < text.length && at - start <= longest && !isTargetEnd(text[at] as string)) at++;
    const url = text.slice(start, at);
    const asset = assets.get(url);
    if (asset === undefined) continue;
    if (text[at] === ">") at++;

    // An optional title, then the closing parenthesis.
    let close = at;
    while (isSpace(text[close])) close++;
    if (close > at && text[close] === '"') {
      const quote = text.indexOf('"', close + 1);
      if (quote !== -1) {
        close = quote + 1;
        while (isSpace(text[close])) close++;
      }
    }
    if (text[close] !== ")") continue;

    pieces.push(text.slice(copied, start), `assets/${asset.name}`);
    used?.add(url);
    copied = start + url.length;
    from = close + 1;
    i = close;
  }
  pieces.push(text.slice(copied));
  return pieces.join("");
}

/** Whether a response is a PDF: its type says so, or a non-HTML type at a `.pdf` path. */
function isPdf(response: Fetched): boolean {
  if (/pdf/i.test(response.contentType)) return true;
  return (
    !HTML_TYPE.test(response.contentType) && /\.pdf$/i.test(URL.parse(response.url)?.pathname ?? "")
  );
}

/** The text of an HTML page; any other type is refused. */
function htmlOf(url: string, response: Fetched): string {
  if (!HTML_TYPE.test(response.contentType)) {
    throw new SourceRefused(
      `${url} is ${response.contentType || "of unknown type"}, not an HTML page.`,
    );
  }
  return decodePage(response.body, response.contentType);
}

/**
 * Find and fetch the source `target` names, or return the name of the folder
 * that already holds it.
 */
async function locate(
  target: Target,
  context: CaptureContext,
  sources: string,
  options: CaptureOptions,
): Promise<Located | string> {
  if (target.kind === "file") {
    const raw = new Uint8Array(readFileSync(target.path));
    const sourceId = `sha256:${sha256(raw)}`;
    const known = existingFolder(sources, target, sourceId);
    if (known !== undefined) return known;
    const origin =
      options.origin === undefined ? `file:${basename(target.path)}` : originOption(options.origin);
    const licence = options.licence ?? NOT_STATED;
    return { kind: "PDF file", format: "pdf", sourceId, origin, licence, raw };
  }
  if (target.kind === "arxiv") return locateArxiv(target, context, sources);

  const sourceId = `web:${target.url}`;
  const known = existingFolder(sources, target, sourceId);
  if (known !== undefined) return known;
  const page = await context.fetch(target.url);
  const raw = body(target.url, page);
  const origin = cleanUrl(page.url) ?? target.url;
  if (isPdf(page)) {
    const licence = options.licence ?? NOT_STATED;
    return { kind: "web PDF", format: "pdf", sourceId, origin, licence, raw };
  }
  const html = htmlOf(target.url, page);
  const licence = webLicence(html, origin);
  return { kind: "web page", format: "html", sourceId, origin, licence, raw, html };
}

/** The version an arXiv abstract page shows: the one entry of its submission history that is not a link. */
function shownVersion(page: string): string | undefined {
  const { document } = parseHTML(page);
  const shown = [...document.querySelectorAll(".submission-history strong")].filter(
    (entry) => entry.querySelector("a") === null,
  );
  const versions = shown.map((entry) => /^\[(v\d+)\]$/.exec((entry.textContent ?? "").trim())?.[1]);
  return versions.length === 1 ? versions[0] : undefined;
}

/** An arXiv paper without an HTML version, from its PDF, pinned to the version its abstract page shows. */
async function locateArxivPdf(
  target: Extract<Target, { kind: "arxiv" }>,
  context: CaptureContext,
  sources: string,
): Promise<Located | string> {
  const asked = `${target.id}${target.version ?? ""}`;
  const abstractUrl = `https://arxiv.org/abs/${asked}`;
  const abstract = decodePage(body(abstractUrl, await context.fetch(abstractUrl)), "text/html");
  const version = shownVersion(abstract);
  if (version === undefined) {
    throw new SourceRefused(`cannot tell which version of ${target.id} ${abstractUrl} shows.`);
  }
  if (target.version !== undefined && target.version !== version) {
    throw new SourceRefused(`${abstractUrl} shows ${version}, not ${target.version}.`);
  }
  const sourceId = `arxiv:${target.id}${version}`;
  const known = existingFolder(sources, target, sourceId);
  if (known !== undefined) return known;
  const pdfUrl = `https://arxiv.org/pdf/${target.id}${version}`;
  const pdf = await context.fetch(pdfUrl);
  const raw = body(pdfUrl, pdf);
  if (!/pdf/i.test(pdf.contentType)) {
    throw new SourceRefused(`${pdfUrl} is ${pdf.contentType || "of unknown type"}, not a PDF.`);
  }
  return {
    kind: "arXiv PDF",
    format: "pdf",
    sourceId,
    origin: pdfUrl,
    licence: arxivLicence(abstract, abstractUrl),
    raw,
  };
}

/** An arXiv paper from its HTML version, pinned to the version arXiv served. */
async function locateArxiv(
  target: Extract<Target, { kind: "arxiv" }>,
  context: CaptureContext,
  sources: string,
): Promise<Located | string> {
  const asked = target.version === undefined ? undefined : `arxiv:${target.id}${target.version}`;
  const known = existingFolder(sources, target, asked);
  if (known !== undefined) return known;

  const pageUrl = `https://arxiv.org/html/${target.id}${target.version ?? ""}`;
  const page = await context.fetch(pageUrl);
  if (page.status === 404) return locateArxivPdf(target, context, sources);
  const raw = body(pageUrl, page);
  const html = htmlOf(pageUrl, page);
  const link = new RegExp(`href="/abs/${target.id.replace(".", "\\.")}(v\\d+)"`, "g");
  const versions = new Set([...html.matchAll(link)].map((match) => match[1]));
  const version = [...versions][0];
  if (versions.size !== 1 || version === undefined) {
    throw new SourceRefused(`cannot tell which version of ${target.id} ${pageUrl} served.`);
  }
  if (target.version !== undefined && target.version !== version) {
    throw new SourceRefused(`${pageUrl} served ${version}, not ${target.version}.`);
  }
  const sourceId = `arxiv:${target.id}${version}`;
  const again = existingFolder(sources, target, sourceId);
  if (again !== undefined) return again;
  const abstractUrl = `https://arxiv.org/abs/${target.id}${version}`;
  const abstract = body(abstractUrl, await context.fetch(abstractUrl));
  return {
    kind: "arXiv HTML",
    format: "html",
    sourceId,
    origin: `https://arxiv.org/html/${target.id}${version}`,
    licence: arxivLicence(decodePage(abstract, "text/html"), abstractUrl),
    raw,
    html,
  };
}

/**
 * Article containers to point defuddle at when its own choice of content
 * misses the article. `.article.fulltext-view` is the HighWire layout of
 * bioRxiv, medRxiv, and many journals, where defuddle can take the reference
 * list for the whole page.
 */
const ARTICLE_SELECTORS = [".article.fulltext-view", "[role=main]", "main", "article"];

/** Defuddle text with less than this share of the page's visible words missed the article. */
const MIN_TEXT_SHARE = 0.1;

/** A page with fewer visible words has no article to miss, so its text is not checked. */
const MIN_PAGE_WORDS = 500;

/** Words of three letters or more, not counting link targets and bare URLs. */
function wordCount(text: string): number {
  const shown = text.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
  return (shown.match(/[A-Za-z]{3,}/g) ?? []).length;
}

function visibleWords(html: string): number {
  const { document } = parseHTML(html);
  for (const hidden of document.querySelectorAll("script, style, noscript, nav, header, footer"))
    hidden.remove();
  return wordCount(document.body?.textContent ?? "");
}

/**
 * The defuddle text of a page and the converter that made it. When defuddle's
 * own choice holds too little of the page, it runs again on each article
 * container the page has, and the first that holds enough wins; the converter
 * then names that selector. When none does, the first text stays with a
 * warning: a page whose side text dwarfs its article looks the same.
 */
async function pageText(
  html: string,
  origin: string,
): Promise<{ title: string; content: string; converter: string; warnings: string[] }> {
  // `useAsync: false` keeps defuddle's site extractors (YouTube, Reddit, ...)
  // from calling the global fetch, outside the fetcher and its address checks.
  const run = (contentSelector?: string) =>
    Defuddle(parseHTML(html).document, origin, {
      markdown: true,
      useAsync: false,
      ...(contentSelector === undefined ? {} : { contentSelector }),
    });
  const page = visibleWords(html);
  const enough = (content: string): boolean =>
    page < MIN_PAGE_WORDS || wordCount(content) >= MIN_TEXT_SHARE * page;
  const first = await run();
  if (enough(first.content)) return { ...first, converter: converterName(), warnings: [] };
  const { document } = parseHTML(html);
  for (const selector of ARTICLE_SELECTORS) {
    if (document.querySelector(selector) === null) continue;
    const retry = await run(selector);
    if (enough(retry.content)) {
      return {
        ...retry,
        converter: `${converterName()} contentSelector=${selector}`,
        warnings: [],
      };
    }
  }
  const kept = wordCount(first.content);
  const warning = `defuddle kept ${kept} of the page's ${page} visible words and no article container held more; check that source.md holds the text.`;
  return { ...first, converter: converterName(), warnings: [warning] };
}

/** The defuddle text of a page, with the images of its captioned figures fetched. */
async function convertPage(
  html: string,
  origin: string,
  sourceId: string,
  context: CaptureContext,
): Promise<Converted> {
  const figures = captionedFigures(html, origin);
  const taken = new Set<string>();
  const assets = new Map<string, { name: string; bytes: Uint8Array }>();
  const skipped: string[] = [];
  const skip = (url: string, why: string): void => {
    skipped.push(`${url}: ${why}`);
  };
  for (const url of figures.flatMap((figure) => figure.images)) {
    if (assets.has(url) || skipped.some((line) => line.startsWith(`${url}:`))) continue;
    let response: Fetched;
    try {
      response = await context.fetch(url);
    } catch (error) {
      if (!(error instanceof BlockedUrl)) throw error;
      skip(url, error.message);
      continue;
    }
    if (response.status !== 200) {
      skip(url, `HTTP ${response.status}`);
    } else if (!/^image\//i.test(response.contentType)) {
      skip(url, `content type ${response.contentType || "unknown"} is not an image`);
    } else {
      assets.set(url, { name: assetName(url, taken), bytes: response.body });
    }
  }

  const converted = await pageText(html, origin);
  let content = converted.content.trim();
  content = pointImagesAtAssets(unwrapBracketedAlts(content), assets);
  const sections = [`# ${converted.title || sourceId}`, content];
  if (figures.length > 0) {
    const entries = figures.map((figure) =>
      [
        figure.caption,
        ...figure.images.flatMap((url) => {
          const asset = assets.get(url);
          return asset ? [`![](assets/${asset.name})`] : [];
        }),
      ].join("\n\n"),
    );
    sections.push(`## Figures\n\n${entries.join("\n\n")}`);
  }
  return {
    text: sections.join("\n\n"),
    converter: converted.converter,
    figures: figures.length,
    assets: [...assets.values()],
    skipped,
    warnings: converted.warnings,
  };
}

/**
 * Capture `argument` (an arXiv ID or URL, a web URL, a PDF file, or an inbox
 * note that holds only a URL) into `raw/<slug>/`. When the source is already
 * there, nothing is fetched, converted, or written. An arXiv paper without
 * HTML is captured from its PDF. An old-style arXiv ID, or an option the
 * kind of capture does not take, is refused with `SourceRefused`.
 */
export async function captureSource(
  root: string,
  argument: string,
  context: CaptureContext,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const target = resolveTarget(root, argument);
  const sources = dirname(dirname(newTarget(root, `${RAW_DIR}/x/source.md`)));
  const located = await locate(target, context, sources, options);
  if (typeof located === "string") {
    const manifest = manifestOf(join(sources, located));
    return {
      status: "unchanged",
      folder: `${RAW_DIR}/${located}`,
      sourceId: String(manifest.source_id),
      figures: Number(manifest.figures),
      skipped: [],
      warnings: [],
    };
  }
  const { sourceId, origin } = located;
  for (const name of ["origin", "licence"] as const) {
    if (options[name] !== undefined && !TAKES[located.kind][name]) {
      throw new SourceRefused(
        `--${name} is only for a PDF; a ${located.kind} capture reads its ${name} from the source. Nothing was written.`,
      );
    }
  }

  let converted: Converted;
  if (located.format === "pdf") {
    const conversion = await context.convertPdf(located.raw);
    converted = {
      ...pdfText(conversion, sourceId),
      converter: mineruName(conversion.structured),
      warnings: [],
    };
  } else {
    converted = await convertPage(located.html, origin, sourceId, context);
  }
  // The hash covers the text exactly as the canonical writer stores it.
  const text = parse(serialize({}, converted.text)).body;
  const slug = slugOf(target, sourceId, origin);
  const note = serialize(
    {
      ...destinationProperties(root, `${RAW_DIR}/${slug}/source.md`),
      created: context.today(),
      origin,
      source_id: sourceId,
      retrieved: context.today(),
      licence: located.licence,
      converter: converted.converter,
      sha256_raw: sha256(located.raw),
      sha256_text: sha256(text),
      figures: String(converted.figures),
    },
    text,
  );
  if (parse(note).body !== text) throw new Error("source.md would not read back as written");

  const folder = join(sources, slug);
  if (existsSync(folder)) {
    throw new SourceRefused(`${RAW_DIR}/${slug} holds another source; nothing was written.`);
  }
  const madeSources = !existsSync(sources);
  mkdirSync(sources, { recursive: true });
  const staging = mkdtempSync(join(sources, `.${slug}-`));
  try {
    chmodSync(staging, 0o755); // mkdtemp makes it private; the folder is shared vault content
    mkdirSync(join(staging, "assets"));
    writeSynced(join(staging, `raw.${located.format}`), located.raw);
    for (const asset of converted.assets)
      writeSynced(join(staging, "assets", asset.name), asset.bytes);
    writeSynced(join(staging, "source.md"), note);
    syncFolder(join(staging, "assets"));
    syncFolder(staging);
    renameSync(staging, folder);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (madeSources) {
      try {
        rmdirSync(sources); // only while empty
      } catch {}
    }
    throw error;
  }
  markDirty(root);
  // The folder is in place: a failed flush of its parent is a warning, not a failed capture.
  const warnings = [...converted.warnings];
  try {
    syncFolder(sources);
  } catch (error) {
    warnings.push(
      `could not flush ${RAW_DIR}/ to disk: ${error instanceof Error ? error.message : error}`,
    );
  }
  return {
    status: "captured",
    folder: `${RAW_DIR}/${slug}`,
    sourceId,
    figures: converted.figures,
    skipped: converted.skipped,
    warnings,
  };
}
