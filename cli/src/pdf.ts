/**
 * PDF conversion for source capture. MinerU turns a PDF into Markdown, a
 * structured block list, and the images it cut out. The converter is the
 * injected `PdfConverter`, so tests pass converted documents in memory; the
 * real one runs MinerU on this machine, never its remote service.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { run, start } from "./run.ts";
import { pointImagesAtAssets, SourceRefused, uniqueName } from "./sources.ts";

/** MinerU parses a long scanned PDF on this machine in minutes; half an hour ends a hang. */
const MINERU_TIMEOUT_MS = 30 * 60_000;
const UNZIP_TIMEOUT_MS = 60_000;

const Structured = z.object({
  pages: z.array(
    z.object({
      page_idx: z.number(),
      blocks: z.array(
        z.object({
          type: z.string(),
          captions: z.array(z.object({ content: z.string() })).default([]),
          image_source: z.string().optional(),
        }),
      ),
    }),
  ),
  metadata: z.object({
    producer: z.object({ version: z.string() }),
    document: z.object({ title: z.string().optional() }).default({}),
  }),
  extensions: z.object({ mineru: z.object({ tier: z.string() }) }),
});

/** The parts of MinerU's `structured_content.json` that a capture reads. */
export type StructuredContent = z.output<typeof Structured>;

export interface PdfConversion {
  markdown: string;
  structured: StructuredContent;
  /** The images MinerU cut out, keyed by their path in the Markdown (`images/<name>`). */
  images: Map<string, Uint8Array>;
}

/** Convert one PDF. A real run uses `mineruConverter`; tests return fixed conversions. */
export type PdfConverter = (pdf: Uint8Array) => Promise<PdfConversion>;

/** The MinerU arguments after the input and output paths; the manifest records them. */
const MINERU_FLAGS = ["-f", "zip", "--tier", "advanced", "--disable-image-analysis"];

/**
 * A converter that runs `command` (MinerU's `mineru-kit`) on this machine.
 * `--disable-image-analysis` keeps MinerU from writing data tables it
 * guessed from charts, which are not text of the source.
 */
export function mineruConverter(command: string): PdfConverter {
  return async (pdf) => {
    const mineru = Bun.which(command);
    if (mineru === null) {
      throw new SourceRefused(
        `MinerU ('${command}') is not installed, so the PDF cannot be converted. Install it with \`uv venv ~/.mineru\` and \`uv pip install --python ~/.mineru "mineru>=4.0,<5"\`, then set LLMOS_MINERU to ~/.mineru/bin/mineru-kit.`,
      );
    }
    const unzip = Bun.which("unzip");
    if (unzip === null)
      throw new SourceRefused("unzip is not installed; it reads MinerU's output.");
    const work = mkdtempSync(join(tmpdir(), "llmos-mineru-"));
    try {
      const input = join(work, "source.pdf");
      const zip = join(work, "out.zip");
      const out = join(work, "out");
      writeFileSync(input, pdf);
      const parse = start([mineru, "parse", input, "-o", zip, ...MINERU_FLAGS], {
        stdin: "ignore",
        stdout: 2,
        stderr: "inherit",
        timeoutMs: MINERU_TIMEOUT_MS,
      });
      const code = await parse.exited;
      if (code !== 0)
        throw new SourceRefused(`MinerU exited with code ${code}; nothing was written.`);
      const unpacked = run([unzip, "-q", zip, "-d", out], {
        stdout: 2,
        stderr: "inherit",
        timeoutMs: UNZIP_TIMEOUT_MS,
      });
      if (unpacked.exitCode !== 0) {
        throw new SourceRefused(
          `unzip could not read MinerU's output (exit ${unpacked.exitCode}).`,
        );
      }
      const parsed = Structured.safeParse(
        JSON.parse(readFileSync(join(out, "structured_content.json"), "utf8")),
      );
      if (!parsed.success) {
        throw new SourceRefused(
          `MinerU wrote a structured_content.json this version cannot read: ${parsed.error.message}`,
        );
      }
      const folder = join(out, "images");
      const names = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile());
      return {
        markdown: readFileSync(join(out, "markdown.md"), "utf8"),
        structured: parsed.data,
        images: new Map(
          names.map((entry) => [
            `images/${entry.name}`,
            new Uint8Array(readFileSync(join(folder, entry.name))),
          ]),
        ),
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}

/** The converter as the manifest records it: what reproduces the text. */
export function mineruName(structured: StructuredContent): string {
  return `mineru@${structured.metadata.producer.version} --tier ${structured.extensions.mineru.tier} --disable-image-analysis`;
}

export interface PdfFigure {
  caption: string;
  /** Image paths as the conversion names them (`images/<name>`), panels first. */
  images: string[];
}

const FIGURE_LABEL = /^(?:Fig\.?|Figure)\s*S?\d+/i;
const PANEL_LABEL = /^\(?[a-z]\)?$/i;

/**
 * The figures of a converted PDF: an image or chart block whose caption
 * starts with a figure label (`Fig. 3`, `Figure S2`). MinerU cuts a
 * multi-panel figure into one block per panel and gives the caption to the
 * last, so a figure also takes the blocks before it on its page that have no
 * caption or only a panel letter, back to the previous figure there.
 */
export function pdfFigures(structured: StructuredContent): PdfFigure[] {
  const figures: PdfFigure[] = [];
  for (const page of structured.pages) {
    let panels: string[] = [];
    for (const block of page.blocks) {
      if (block.type !== "image" && block.type !== "chart") continue;
      const caption = (block.captions[0]?.content ?? "").replace(/\s+/g, " ").trim();
      const image = block.image_source === undefined ? [] : [block.image_source];
      if (FIGURE_LABEL.test(caption)) {
        figures.push({ caption, images: [...panels, ...image] });
        panels = [];
      } else if (caption === "" || PANEL_LABEL.test(caption)) {
        panels.push(...image);
      }
    }
  }
  return figures;
}

export interface PdfText {
  text: string;
  figures: number;
  /** The images the text shows, under the file names they get in `assets/`. */
  assets: { name: string; bytes: Uint8Array }[];
  /** Figure images the conversion did not write, each with the reason. */
  skipped: string[];
}

/**
 * The text of a PDF capture: MinerU's Markdown with its images pointed at
 * `assets/`, a title when the Markdown has none, and a Figures section with
 * each figure's caption and images. Only images the text shows are kept.
 */
export function pdfText(conversion: PdfConversion, sourceId: string): PdfText {
  const taken = new Set<string>();
  const named = new Map(
    [...conversion.images.keys()].map((path) => [
      path,
      { name: uniqueName(path.split("/").pop() || "figure", taken) },
    ]),
  );
  const used = new Set<string>();
  let markdown = pointImagesAtAssets(conversion.markdown.trim(), named, used);
  if (!markdown.startsWith("# ")) {
    markdown = `# ${conversion.structured.metadata.document.title || sourceId}\n\n${markdown}`;
  }
  const sections = [markdown];
  const figures = pdfFigures(conversion.structured);
  const skipped: string[] = [];
  if (figures.length > 0) {
    const entries = figures.map((figure) => {
      const images = figure.images.flatMap((path) => {
        const asset = named.get(path);
        if (asset === undefined) {
          skipped.push(`${path}: MinerU wrote no such image`);
          return [];
        }
        used.add(path);
        return [`![](assets/${asset.name})`];
      });
      return [figure.caption, ...images].join("\n\n");
    });
    sections.push(`## Figures\n\n${entries.join("\n\n")}`);
  }
  const assets = [...used].map((path) => ({
    name: (named.get(path) as { name: string }).name,
    bytes: conversion.images.get(path) as Uint8Array,
  }));
  return { text: sections.join("\n\n"), figures: figures.length, assets, skipped };
}
