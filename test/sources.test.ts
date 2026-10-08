import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "../src/frontmatter.ts";
import {
  assertPublicUrl,
  BlockedUrl,
  type Fetched,
  type Fetcher,
  networkFetcher,
} from "../src/sources.ts";
import { cli, makeVault, offline, TODAY } from "./helpers.ts";

const RECORDED = join(import.meta.dir, "fixtures", "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

/** The network as recorded under fixtures/web: a missing file is a 404. */
function replay(): { fetch: Fetcher; requests: string[] } {
  const requests: string[] = [];
  const fetch: Fetcher = async (url) => {
    requests.push(url);
    const { host, pathname } = new URL(url);
    const file = [join(RECORDED, host, pathname), join(RECORDED, host, `${pathname}.html`)].find(
      (path) => existsSync(path) && extname(path) !== "",
    );
    if (file === undefined)
      return { status: 404, url, contentType: "text/html", body: new Uint8Array() };
    const contentType = TYPES[extname(file)] ?? "application/octet-stream";
    return { status: 200, url, contentType, body: new Uint8Array(readFileSync(file)) };
  };
  return { fetch, requests };
}

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/** Every file under `folder` with its hash, to compare two states of a source folder. */
function snapshot(folder: string): Record<string, string> {
  const entries = readdirSync(folder, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(folder.length), sha256(readFileSync(path))];
      }),
  );
}

describe("source add", () => {
  test("captures a recorded arXiv paper, and capturing it again changes nothing", async () => {
    const root = makeVault();
    const network = replay();
    const first = await cli(root, ["source", "add", "1811.00743"], { fetch: network.fetch });
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(
      "Captured: arxiv:1811.00743v2 -> sources/arxiv-1811.00743v2 (4 figures)\n",
    );

    const folder = join(root, "sources", "arxiv-1811.00743v2");
    const note = parse(readFileSync(join(folder, "source.md"), "utf8"));
    expect(note.properties).toMatchObject({
      origin: "https://arxiv.org/html/1811.00743v2",
      source_id: "arxiv:1811.00743v2",
      retrieved: TODAY,
      licence: "http://arxiv.org/licenses/nonexclusive-distrib/1.0/",
      // The paper has four numbered figures; its other `<figure>` and
      // `<figcaption>` elements are tables and subfigure panels.
      figures: "4",
    });
    expect(note.properties.sha256_raw).toBe(sha256(readFileSync(join(folder, "raw.html"))));
    expect(note.properties.sha256_text).toBe(sha256(note.body));
    expect(readdirSync(join(folder, "assets"))).toHaveLength(28);
    // Each figure takes its own caption, not the caption of its first panel.
    const figures = note.body.slice(note.body.indexOf("## Figures"));
    const captions = figures.split("\n\n").filter((line) => /^(Figure \d+:|\(a\))/.test(line));
    expect(captions.map((line) => line.slice(0, 29))).toEqual([
      "Figure 1: Histogram of the nu",
      "Figure 2: Example Images of R",
      "Figure 3: Pose variations for",
      "Figure 4: CMC and TAR vs FAR ",
    ]);

    const before = snapshot(folder);
    const requestsBefore = network.requests.length;
    const second = await cli(root, ["source", "add", "arxiv:1811.00743v2"], {
      fetch: network.fetch,
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("nothing changed");
    expect(network.requests.length).toBe(requestsBefore);
    expect(snapshot(folder)).toEqual(before);

    // An ID without a version, and a URL with a query, find the captured version offline.
    for (const again of ["1811.00743", "https://arxiv.org/abs/1811.00743?context=cs#top"]) {
      const result = await cli(root, ["source", "add", again], { fetch: offline });
      expect(result.stdout).toContain("Already captured: arxiv:1811.00743v2");
    }
  });

  test("refuses a PDF, and an arXiv paper without HTML, and writes nothing", async () => {
    const root = makeVault({ "inbox/paper.pdf": "%PDF-1.4" });
    const network = replay();
    const pdf = await cli(root, ["source", "add", "inbox/paper.pdf"], { fetch: network.fetch });
    expect(pdf.exitCode).toBe(1);
    expect(pdf.stderr).toContain("PDF capture is not supported");
    expect(existsSync(join(root, "inbox", "paper.pdf"))).toBe(true);

    const bare = await cli(root, ["source", "add", "1703.07737"], { fetch: network.fetch });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("no HTML version");
    expect(existsSync(join(root, "sources"))).toBe(false);
  });

  test("captures the URL held by an inbox note, keeping only captioned figures", async () => {
    const root = makeVault({
      "inbox/link.md":
        "---\ncreated: 2026-10-01\n---\n\nhttps://example.org/papers/open-study.html#top\n",
    });
    const result = await cli(root, ["source", "add", "inbox/link"], { fetch: replay().fetch });
    expect(result.stderr).toBe("");
    const [name] = readdirSync(join(root, "sources"));
    const folder = join(root, "sources", name as string);
    const note = parse(readFileSync(join(folder, "source.md"), "utf8"));
    expect(note.properties).toMatchObject({
      source_id: "web:https://example.org/papers/open-study.html",
      licence: "https://creativecommons.org/licenses/by/4.0/",
      figures: "1",
    });
    expect(readdirSync(join(folder, "assets"))).toEqual(["pool.jpg"]);
    expect(existsSync(join(root, "inbox", "link.md"))).toBe(true);
  });

  test("saves only image responses from public hosts and names what it skips", async () => {
    const argv = ["source", "add", "https://example.org/papers/open-study.html"];
    const network = replay();
    const notImage: Fetcher = async (url) =>
      url.endsWith("pool.jpg")
        ? { status: 200, url, contentType: "text/html", body: new TextEncoder().encode("<html>") }
        : network.fetch(url);
    const wrongType = await cli(makeVault(), argv, { fetch: notImage });
    expect(wrongType.exitCode).toBe(0);
    expect(wrongType.stdout).toContain("Skipped image: https://example.org/papers/img/pool.jpg");
    expect(network.requests.some((url) => url.startsWith("file:"))).toBe(false);

    const blocked: Fetcher = async (url) => {
      if (url.endsWith("pool.jpg"))
        throw new BlockedUrl(`${url} resolves to a local or private address.`);
      return network.fetch(url);
    };
    const root = makeVault();
    const result = await cli(root, argv, { fetch: blocked });
    expect(result.stdout).toContain("resolves to a local or private address");
    const [name] = readdirSync(join(root, "sources"));
    expect(readdirSync(join(root, "sources", name as string, "assets"))).toEqual([]);
  });
});

describe("network fetcher", () => {
  const lookupOf = (table: Record<string, string[]>) => async (host: string) => table[host] ?? [];

  test("refuses non-http schemes, IP literals, and hosts that resolve to local addresses", async () => {
    const local = [
      "127.0.0.1",
      "127.8.8.8",
      "0.1.2.3",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b::127.0.0.1",
      "2002:7f00:1::",
      "2001:db8::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "198.19.255.255",
    ];
    const lookup = lookupOf({
      "public.example": ["93.184.216.34"],
      "mixed.example": ["93.184.216.34", "10.0.0.5"],
    });
    for (const address of local) {
      await expect(assertPublicUrl(`https://host.example/`, async () => [address])).rejects.toThrow(
        BlockedUrl,
      );
    }
    for (const url of [
      "file:///etc/passwd",
      "ftp://public.example/x",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://2130706433/",
      "http://mixed.example/",
      "http://nowhere.example/",
    ]) {
      await expect(assertPublicUrl(url, lookup)).rejects.toThrow(BlockedUrl);
    }
    for (const address of [
      "172.15.0.1",
      "172.32.0.1",
      "100.128.0.1",
      "198.17.255.255",
      "198.20.0.1",
      "223.255.255.255",
      "2606:4700::1",
    ]) {
      await expect(
        assertPublicUrl("https://host.example/", async () => [address]),
      ).resolves.toBeUndefined();
    }
  });

  test("checks every redirect hop and stops after five", async () => {
    const lookup = lookupOf({
      "public.example": ["93.184.216.34"],
      "cdn.example": ["93.184.216.35"],
    });
    const seen: string[] = [];
    const redirectTo = (location: string): Response =>
      new Response(null, { status: 302, headers: { location } });
    const modes: unknown[] = [];
    const request = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      modes.push(init?.redirect);
      if (url === "https://public.example/to-cdn")
        return redirectTo("https://cdn.example/image.png");
      if (url === "https://public.example/to-metadata")
        return redirectTo("http://169.254.169.254/latest");
      if (url === "https://public.example/to-loopback-name") return redirectTo("http://localhost/");
      if (url.startsWith("https://public.example/loop")) return redirectTo("/loop");
      return new Response("ok", { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const fetcher = networkFetcher(
      async (host) => (host === "localhost" ? ["127.0.0.1"] : lookup(host)),
      request,
    );

    const followed = await fetcher("https://public.example/to-cdn");
    expect([followed.status, followed.url]).toEqual([200, "https://cdn.example/image.png"]);
    await expect(fetcher("https://public.example/to-metadata")).rejects.toThrow(BlockedUrl);
    await expect(fetcher("https://public.example/to-loopback-name")).rejects.toThrow(BlockedUrl);
    expect(seen).not.toContain("http://169.254.169.254/latest");
    expect(seen).not.toContain("http://localhost/");
    seen.length = 0;
    await expect(fetcher("https://public.example/loop")).rejects.toThrow("redirects more than 5");
    expect(seen).toHaveLength(6);
    // The runtime must not follow redirects itself, or hops would go unchecked.
    expect(new Set(modes)).toEqual(new Set(["manual"]));
  });
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A network of in-memory pages: a string is an HTML page, a missing URL is a 404. */
function memory(pages: Record<string, string | Partial<Fetched>>): {
  fetch: Fetcher;
  requests: string[];
} {
  const requests: string[] = [];
  const fetch: Fetcher = async (url) => {
    requests.push(url);
    const page = pages[url];
    if (page === undefined) {
      return { status: 404, url, contentType: "text/html", body: new Uint8Array() };
    }
    const found = typeof page === "string" ? { body: encode(page) } : page;
    return { status: 200, url, contentType: "text/html", body: new Uint8Array(), ...found };
  };
  return { fetch, requests };
}

const PNG = { contentType: "image/png", body: encode("png") };

/** The capture folders of a vault, and any staging folder left beside them. */
const sourceFolders = (root: string): string[] =>
  existsSync(join(root, "sources")) ? readdirSync(join(root, "sources")) : [];

describe("source add edge cases", () => {
  const PAGE = "https://example.org/a";
  const figure = (caption: string, ...images: string[]): string =>
    `<figure>${images.map((src) => `<img src="${src}">`).join("")}<figcaption>${caption}</figcaption></figure>`;

  test("a figure takes its own caption; listings, tables, and uncaptioned figures do not count", async () => {
    const html = `<html><body><article><p>Text of the page.</p>
      <figure class="ltx_figure"><figure class="ltx_figure ltx_figure_panel"><img src="p.png"><figcaption>(a) panel</figcaption></figure><figcaption>Figure 1: whole</figcaption></figure>
      <figure class="ltx_figure"><figure class="ltx_figure_panel"><figcaption>(a) only a panel</figcaption></figure></figure>
      <figure class="ltx_figure ltx_lstlisting"><figcaption>Figure 2: code</figcaption></figure>
      <figure class="ltx_table"><figcaption>Table 1: numbers</figcaption></figure>
      </article></body></html>`;
    const root = makeVault();
    const network = memory({ [PAGE]: html, "https://example.org/p.png": PNG });
    const result = await cli(root, ["source", "add", PAGE], { fetch: network.fetch });
    expect(result.stdout).toStartWith("Captured:");
    const [name] = sourceFolders(root);
    const note = parse(readFileSync(join(root, "sources", name as string, "source.md"), "utf8"));
    expect(note.properties.figures).toBe("1");
    const figures = note.body.slice(note.body.indexOf("## Figures"));
    expect(figures).toContain("Figure 1: whole");
    expect(figures).not.toContain("(a) panel");
    expect(figures).not.toContain("Figure 2");
    expect(figures).not.toContain("Table 1");
  });

  test("a YouTube page is captured without defuddle calling the global fetch", async () => {
    const real = globalThis.fetch;
    const calls: string[] = [];
    // defuddle catches errors from its own fetches, so count the calls instead.
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const url = "https://www.youtube.com/watch?v=abc123";
      const html = `<html><head><title>A talk</title><link rel="canonical" href="${url}"></head><body><p>Words about the talk.</p></body></html>`;
      const result = await cli(makeVault(), ["source", "add", url], {
        fetch: memory({ [url]: html }).fetch,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("only Markdown images of downloaded URLs point at the local copy; links stay", async () => {
    const root = makeVault();
    const html = `<html><body><article><p>Intro text of the page.</p>
      <p><a href="https://example.org/a.png">the file</a> and <a href="https://example.org/a.png?download=1">the download</a></p>
      ${figure("Figure 1: x", "a.png")}</article></body></html>`;
    const network = memory({ [PAGE]: html, "https://example.org/a.png": PNG });
    await cli(root, ["source", "add", PAGE], { fetch: network.fetch });
    const [name] = sourceFolders(root);
    const note = parse(readFileSync(join(root, "sources", name as string, "source.md"), "utf8"));
    expect(note.body).toContain("[the file](https://example.org/a.png)");
    expect(note.body).toContain("(https://example.org/a.png?download=1)");
    expect(note.body).toContain("![](assets/a.png)");
  });

  test("a failure while fetching figures leaves no folder and no staging behind", async () => {
    const root = makeVault();
    const network = memory({
      [PAGE]: `<html><body>${figure("Figure 1: x", "a.png", "b.png", "c.png")}</body></html>`,
      "https://example.org/a.png": PNG,
      "https://example.org/b.png": PNG,
    });
    const flaky: Fetcher = async (url) => {
      if (url.endsWith("c.png")) throw new Error("connection reset");
      return network.fetch(url);
    };
    const result = await cli(root, ["source", "add", PAGE], { fetch: flaky });
    expect(result.exitCode).toBe(1);
    expect(sourceFolders(root)).toEqual([]);
  });

  test("an arXiv page of another version than asked for is refused", async () => {
    const network = memory({
      "https://arxiv.org/html/1811.00743v2":
        '<html><body><a href="/abs/1811.00743v3">abs</a></body></html>',
    });
    const root = makeVault();
    const result = await cli(root, ["source", "add", "1811.00743v2"], { fetch: network.fetch });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("served v3, not v2");
    expect(sourceFolders(root)).toEqual([]);
  });

  test("an old-style arXiv ID is refused, not fetched as a web page", async () => {
    for (const argument of ["hep-th/9901001", "https://arxiv.org/abs/hep-th/9901001v1"]) {
      const result = await cli(makeVault(), ["source", "add", argument], { fetch: offline });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("old-style arXiv ID");
    }
  });

  test("a web page that is a 404 or a PDF is refused and writes nothing", async () => {
    const root = makeVault();
    const network = memory({
      "https://example.org/paper": { contentType: "application/pdf", body: encode("%PDF") },
    });
    const missing = await cli(root, ["source", "add", "https://example.org/gone"], {
      fetch: network.fetch,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("HTTP 404");
    const pdf = await cli(root, ["source", "add", "https://example.org/paper"], {
      fetch: network.fetch,
    });
    expect(pdf.exitCode).toBe(1);
    expect(pdf.stderr).toContain("is a PDF");
    expect(sourceFolders(root)).toEqual([]);
  });

  test("the same web source gets one stable slug whatever the fragment or credentials", async () => {
    const root = makeVault();
    const network = memory({ [PAGE]: "<html><body><p>Hello there.</p></body></html>" });
    const first = await cli(root, ["source", "add", "https://reader:secret@example.org/a#one"], {
      fetch: network.fetch,
    });
    expect(first.stdout).toStartWith(
      "Captured: web:https://example.org/a -> sources/example-org-a-",
    );
    expect(sourceFolders(root)).toEqual(["example-org-a-3b3bbbea"]);
    const note = readFileSync(join(root, "sources", "example-org-a-3b3bbbea", "source.md"), "utf8");
    expect(note).not.toContain("secret");
    const again = await cli(root, ["source", "add", "https://example.org/a#two"], {
      fetch: offline,
    });
    expect(again.stdout).toContain("Already captured");
  });

  test("image names that differ only in case stay distinct, and a failing image is skipped", async () => {
    const root = makeVault();
    const network = memory({
      [PAGE]: `<html><body>${figure("Figure 1: x", "a/Fig.png", "b/fig.png", "c/gone.png")}</body></html>`,
      "https://example.org/a/Fig.png": PNG,
      "https://example.org/b/fig.png": PNG,
    });
    const result = await cli(root, ["source", "add", PAGE], { fetch: network.fetch });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skipped image: https://example.org/c/gone.png: HTTP 404");
    const [name] = sourceFolders(root);
    const assets = readdirSync(join(root, "sources", name as string, "assets"));
    expect(new Set(assets.map((asset) => asset.toLowerCase())).size).toBe(2);
  });

  test("a page decodes in its declared charset, and a relative licence link resolves", async () => {
    const latin1 = new Uint8Array([
      ...encode(
        '<html><head><meta charset="iso-8859-1"><title>T</title><link rel="license" href="/licenses/by"></head><body><p>caf',
      ),
      0xe9,
      ...encode(" au lait.</p></body></html>"),
    ]);
    const root = makeVault();
    const result = await cli(root, ["source", "add", PAGE], {
      fetch: memory({ [PAGE]: { body: latin1 } }).fetch,
    });
    expect(result.exitCode).toBe(0);
    const [name] = sourceFolders(root);
    const note = parse(readFileSync(join(root, "sources", name as string, "source.md"), "utf8"));
    expect(note.body).toContain("café au lait");
    expect(note.properties.licence).toBe("https://example.org/licenses/by");
  });

  test("a note with prose around a URL is not captured", async () => {
    const root = makeVault({
      "inbox/mixed.md": "---\ncreated: 2026-10-01\n---\n\nRead https://example.org/a later.\n",
    });
    const result = await cli(root, ["source", "add", "inbox/mixed"], { fetch: offline });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("more than a bare URL");
  });

  test("another source folder with an unreadable source.md does not block a capture", async () => {
    const root = makeVault({ "sources/broken/source.md": "---\n: : bad\n---\n" });
    const network = memory({ [PAGE]: "<html><body><p>Hello there.</p></body></html>" });
    const result = await cli(root, ["source", "add", PAGE], { fetch: network.fetch });
    expect(result.exitCode).toBe(0);
  });
});

describe("network fetcher limits", () => {
  const publicLookup = async () => ["93.184.216.34"];

  test("refuses a body over the cap by its header or while streaming, and cancels redirect bodies", async () => {
    let canceled = 0;
    const redirect = new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
      { status: 302, headers: { location: "https://public.example/big" } },
    );
    const request = (async (url: string) => {
      if (url.endsWith("/start")) return redirect;
      if (url.endsWith("/declared"))
        return new Response("x", { headers: { "content-length": "999" } });
      return new Response("0123456789abcdef"); // no content-length: streamed
    }) as unknown as typeof fetch;
    const fetcher = networkFetcher(publicLookup, request, 10);
    await expect(fetcher("https://public.example/declared")).rejects.toThrow(
      "larger than 10 bytes",
    );
    await expect(fetcher("https://public.example/streamed")).rejects.toThrow(
      "larger than 10 bytes",
    );
    await expect(fetcher("https://public.example/start")).rejects.toThrow("larger than 10 bytes");
    expect(canceled).toBe(1);
  });

  test("turns DNS, network, and bad-redirect errors into a SourceRefused that names the URL", async () => {
    const failing = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(networkFetcher(publicLookup, failing)("https://public.example/x")).rejects.toThrow(
      "could not fetch https://public.example/x: socket hang up",
    );
    const dnsDown = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(networkFetcher(dnsDown, failing)("https://public.example/x")).rejects.toThrow(
      "could not fetch https://public.example/x: ENOTFOUND",
    );
    const badLocation = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://[bad" },
      })) as unknown as typeof fetch;
    await expect(
      networkFetcher(publicLookup, badLocation)("https://public.example/x"),
    ).rejects.toThrow("could not fetch");
  });
});
