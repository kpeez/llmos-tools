/**
 * Source capture: freeze one web page or arXiv paper into
 * `sources/<slug>/` with its raw HTML (`raw.html`), the images of its
 * captioned figures (`assets/`), and the defuddle text with a manifest in
 * its frontmatter (`source.md`). Nothing edits the folder afterwards.
 *
 * The network is the injected `Fetcher`, so tests replay recorded pages.
 * A capture builds the folder beside its final place and renames it in, so
 * a failure leaves nothing behind.
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
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { parse, serialize } from "./frontmatter.ts";
import { destinationProperties } from "./inbox.ts";
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
        headers: { "user-agent": "llmos-vault source add" },
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
  today: () => string;
}

type Target =
  | { kind: "arxiv"; id: string; version: string | undefined }
  | { kind: "web"; url: string };

const ARXIV_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_PATH = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?\/?$/i;
const OLD_ID = /^(?:[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?$/i;
const OLD_ARXIV_PATH =
  /^\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Za-z]{2})?\/\d{7}(?:v\d+)?)(?:\.pdf)?\/?$/i;
const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)/i;
const NO_PDF = "PDF capture is not supported yet because no converter exists";

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
 * What an argument names: an arXiv ID or URL, a web URL, or an inbox note
 * (a vault-relative path) that holds only a URL. A PDF is refused.
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
    if (/\.pdf$/i.test(url.pathname)) throw new SourceRefused(`${NO_PDF}; left ${text} in place.`);
    return { kind: "web", url: url.href };
  }
  if (/\.pdf$/i.test(text)) throw new SourceRefused(`${NO_PDF}; left ${text} in place.`);
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

function slugOf(target: Target, sourceId: string): string {
  if (target.kind === "arxiv") return `arxiv-${sourceId.slice("arxiv:".length)}`;
  const url = new URL(target.url);
  const words = `${url.hostname.replace(/^www\./, "")}${url.pathname}`
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

/** A file name for the image at `url`, unique among `taken` ignoring case (macOS folds case). */
function assetName(url: string, taken: Set<string>): string {
  const last = new URL(url).pathname.split("/").pop() || "figure";
  const base = last.replace(/[^A-Za-z0-9._-]/g, "_");
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${n}-${base}`;
  taken.add(name.toLowerCase());
  return name;
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
 * Point Markdown images at their local copies: in `![alt](url)`,
 * `![alt](<url>)`, and `![alt](url "title")`, a `url` that equals a
 * downloaded image URL exactly becomes `assets/<name>`. Links and longer
 * URLs stay as they are. This is one forward scan with no backtracking, so
 * it takes time proportional to the text length times the longest asset URL;
 * an earlier regex took quadratic time on text such as `![a](` repeated.
 * Unlike that regex, an image written inside the target of a non-asset image
 * is also rewritten.
 */
export function pointImagesAtAssets(
  text: string,
  assets: ReadonlyMap<string, { name: string }>,
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
    copied = start + url.length;
    from = close + 1;
    i = close;
  }
  pieces.push(text.slice(copied));
  return pieces.join("");
}

/**
 * Capture `argument` (an arXiv ID or URL, a web URL, or an inbox note that
 * holds only a URL) into `sources/<slug>/`. When the source is already
 * there, nothing is fetched or written. A PDF, an old-style arXiv ID, or an
 * arXiv paper without HTML is refused with `SourceRefused`.
 */
export async function captureSource(
  root: string,
  argument: string,
  context: CaptureContext,
): Promise<CaptureResult> {
  const target = resolveTarget(root, argument);
  const sources = dirname(dirname(newTarget(root, "sources/x/source.md")));
  const unchanged = (name: string): CaptureResult => {
    const manifest = manifestOf(join(sources, name));
    return {
      status: "unchanged",
      folder: `sources/${name}`,
      sourceId: String(manifest.source_id),
      figures: Number(manifest.figures),
      skipped: [],
      warnings: [],
    };
  };

  let sourceId: string | undefined;
  if (target.kind === "web") sourceId = `web:${target.url}`;
  else if (target.version) sourceId = `arxiv:${target.id}${target.version}`;
  const known = existingFolder(sources, target, sourceId);
  if (known !== undefined) return unchanged(known);

  const pageUrl =
    target.kind === "arxiv"
      ? `https://arxiv.org/html/${target.id}${target.version ?? ""}`
      : target.url;
  const page = await context.fetch(pageUrl);
  if (target.kind === "arxiv" && page.status === 404) {
    throw new SourceRefused(
      `arXiv has no HTML version of ${target.id}${target.version ?? ""}; ${NO_PDF}, so the item stays where it is.`,
    );
  }
  const raw = body(pageUrl, page);
  if (/pdf/i.test(page.contentType)) throw new SourceRefused(`${pageUrl} is a PDF; ${NO_PDF}.`);
  if (!HTML_TYPE.test(page.contentType)) {
    throw new SourceRefused(
      `${pageUrl} is ${page.contentType || "of unknown type"}, not an HTML page.`,
    );
  }
  const html = decodePage(raw, page.contentType);

  let origin = cleanUrl(page.url) ?? pageUrl;
  let licence: string;
  if (target.kind === "arxiv") {
    const link = new RegExp(`href="/abs/${target.id.replace(".", "\\.")}(v\\d+)"`, "g");
    const versions = new Set([...html.matchAll(link)].map((match) => match[1]));
    const version = [...versions][0];
    if (versions.size !== 1 || version === undefined) {
      throw new SourceRefused(`cannot tell which version of ${target.id} ${pageUrl} served.`);
    }
    if (target.version !== undefined && target.version !== version) {
      throw new SourceRefused(`${pageUrl} served ${version}, not ${target.version}.`);
    }
    sourceId = `arxiv:${target.id}${version}`;
    origin = `https://arxiv.org/html/${target.id}${version}`;
    const again = existingFolder(sources, target, sourceId);
    if (again !== undefined) return unchanged(again);
    const abstractUrl = `https://arxiv.org/abs/${target.id}${version}`;
    const abstract = body(abstractUrl, await context.fetch(abstractUrl));
    licence = arxivLicence(decodePage(abstract, "text/html"), abstractUrl);
  } else {
    licence = webLicence(html, origin);
  }
  if (sourceId === undefined) throw new Error("no source ID was set");

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

  // `useAsync: false` keeps defuddle's site extractors (YouTube, Reddit, ...)
  // from calling the global fetch, outside the fetcher and its address checks.
  const converted = await Defuddle(parseHTML(html).document, origin, {
    markdown: true,
    useAsync: false,
  });
  let content = converted.content.trim();
  content = pointImagesAtAssets(content, assets);
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
  // The hash covers the text exactly as the canonical writer stores it.
  const text = parse(serialize({}, sections.join("\n\n"))).body;
  const slug = slugOf(target, sourceId);
  const note = serialize(
    {
      ...destinationProperties(root, `sources/${slug}/source.md`),
      created: context.today(),
      origin,
      source_id: sourceId,
      retrieved: context.today(),
      licence,
      converter: converterName(),
      sha256_raw: sha256(raw),
      sha256_text: sha256(text),
      figures: String(figures.length),
    },
    text,
  );
  if (parse(note).body !== text) throw new Error("source.md would not read back as written");

  const folder = join(sources, slug);
  if (existsSync(folder)) {
    throw new SourceRefused(`sources/${slug} holds another source; nothing was written.`);
  }
  const madeSources = !existsSync(sources);
  mkdirSync(sources, { recursive: true });
  const staging = mkdtempSync(join(sources, `.${slug}-`));
  try {
    chmodSync(staging, 0o755); // mkdtemp makes it private; the folder is shared vault content
    mkdirSync(join(staging, "assets"));
    writeSynced(join(staging, "raw.html"), raw);
    for (const asset of assets.values())
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
  // The folder is in place: a failed flush of its parent is a warning, not a failed capture.
  const warnings: string[] = [];
  try {
    syncFolder(sources);
  } catch (error) {
    warnings.push(
      `could not flush sources/ to disk: ${error instanceof Error ? error.message : error}`,
    );
  }
  return {
    status: "captured",
    folder: `sources/${slug}`,
    sourceId,
    figures: figures.length,
    skipped,
    warnings,
  };
}
