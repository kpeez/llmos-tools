# Recorded web fixtures

`test/sources.test.ts` replays these files as the network. A request for
`https://host/path` reads `host/path`, or `host/path.html`; a missing file is
an HTTP 404.

- `arxiv.org/html/1811.00743.html` and `arxiv.org/abs/1811.00743v2.html` are
  the pages of arXiv 1811.00743, recorded on 2026-10-08, unchanged.
- The figure images under `arxiv.org/html/1811.00743v2/plots/` are the
  recorded images shrunk to 48 pixels (`sips -Z 48`) to keep the repository
  small. They are stand-ins; the capture treats them as opaque bytes.
- `example.org/` holds a small hand-written page for the plain-URL path.
