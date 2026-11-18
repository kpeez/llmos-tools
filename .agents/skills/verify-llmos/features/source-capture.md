# Capture a source

`source add` freezes an arXiv paper, web page, or PDF into `raw/<slug>/`: raw bytes, figures, converted text, and a manifest in `source.md`.

## Sub-features

- `capture-arxiv` captures an arXiv paper from its HTML version.
- `capture-repeat` leaves a captured source unchanged and exits 0.
- `refuse-local` refuses a URL aimed at an IP address or a local host.
- `capture-pdf` converts a PDF with MinerU. Not driven.

## How to get to it (user POV)

- CLI: `llmos-vault source add <arXiv id|URL|PDF|inbox note>`.
- Skill `llmos:ingest-source` calls it.
- No MCP tool.

## Driving it with scripts/source-offline.ts

Preconditions: launch and doctor passed. No network is used.

- **Capture.** `bun scripts/source-offline.ts <scratch vault> 1811.00743`. Exit 0. Stdout is `Captured: arxiv:1811.00743v2 -> raw/arxiv-1811.00743v2 (4 figures)`. The folder holds `raw.html`, `assets/`, and `source.md` with `source_id: arxiv:1811.00743v2` and `sha256_raw`.
- **Repeat.** Same command. Exit 0. Stdout says the source is already captured. No file changes.
- **Refuse.** `llmos-vault source add http://127.0.0.1:9/x`. Exit not 0: "names an IP address, not a host". The command makes no request.
- Run: `bun scripts/verify.ts drive source-capture`. Evidence goes to `source-capture/`.

## Gotchas

- A real run is `llmos-vault source add 1811.00743`. It requests `arxiv.org` and the figure hosts, and writes `raw/arxiv-1811.00743v2/` in the vault. Do it only on request and only on a scratch vault.
- `source-offline.ts` replaces only `Context.fetch`. A page missing from `cli/test/fixtures/web/` is a 404.
- The recorded figures are 48-pixel stand-ins.
- A web page needs defuddle (installed). A PDF needs MinerU (`LLMOS_MINERU` or `mineru-kit`). `capture-pdf` is not driven: no MinerU here.
- `source add` accepts only the vault `llmos`.
