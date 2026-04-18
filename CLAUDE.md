# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground rules (must follow)

- **Never delete** any file or folder without explicit confirmation from the user in the current conversation. This includes `rm`, `git rm`, `git clean`, `git checkout --` on tracked files, overwriting files with `>`/`Write` that would discard uncommitted work, and removing directories. Prior approval for one deletion does **not** carry over to another.
- **Never modify** files outside the scope the user just asked for. State what you're about to change and wait for confirmation before touching:
  - any file the user hasn't mentioned or that isn't clearly implied by the task,
  - `.mcp.json`, `.github/workflows/*`, `CLAUDE.md`, `README.md`, or any config/CI file,
  - anything under `.git/`.
- **No destructive git operations** without explicit confirmation: `reset --hard`, `push --force`, `branch -D`, amending pushed commits, rebase, stash drops.
- When in doubt, **ask first**. A one-line confirmation is cheap; lost work is not.

## Running locally

No build step. Serve the directory over HTTP (PDF.js requires a real origin for its worker — `file://` will not work):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. There are no tests, no linter, and no package manager — edits to `app.js` / `styles.css` / `index.html` are live on reload.

## Deployment

`.github/workflows/deploy.yml` publishes the repo root to GitHub Pages on push to `main` or `claude/pdf-editor-web-app-4SINW`. Any file at the repo root is shipped as-is, so do not commit scratch files here.

## Architecture

Single-page app, all logic in `app.js` inside one IIFE. Two external CDN libraries:
- **PDF.js** (`pdfjsLib`) — renders the source PDF into `<canvas id="pdfCanvas">`.
- **pdf-lib** (`PDFLib`) — on save, loads the original bytes, removes deleted pages, and bakes overlays into a new PDF.

The original `state.pdfBytes` ArrayBuffer is kept untouched; every save re-derives output from it, so edits are non-destructive.

### Two-layer rendering model

`#canvasContainer` stacks two elements at the same size:
1. `<canvas id="pdfCanvas">` — the rendered PDF page (read-only pixels).
2. `<div id="textLayer">` — absolutely-positioned DOM overlays (`.text-overlay`, `.rect-overlay`) the user interacts with.

Overlays live as JS objects in `state.textOverlays[pageNum]` / `state.rectOverlays[pageNum]`, keyed by **virtual** page number. On every page switch the textLayer is wiped and rebuilt from state via `renderAllOverlays()`.

### Coordinate system — the critical invariant

The canvas is rendered at `state.scale = 1.5` × the PDF's native size. Overlay `x/y/w/h` are stored in **canvas pixels** (top-left origin). At save time (`saveBtn` handler) each overlay is converted to PDF coordinates:
- scale by `pageWidth / canvasWidth` (and height analogue),
- flip Y because PDF uses bottom-left origin: `pdfY = pageHeight - (canvasY / canvasHeight) * pageHeight - height`,
- divide font sizes and border widths by `state.scale`.

If you change `state.scale` or the canvas sizing, the save-time math must stay in sync or saved output will drift from the editor preview.

### Page deletion via `pageMap`

`state.pageMap` is a virtual→original page index map. Deleting a page splices `pageMap` and shifts overlay keys (`deletePages()`); it does **not** touch the original bytes. On save, pages absent from `pageMap` are removed from the pdf-lib document in reverse order. Always navigate/render via `state.pageMap[virtual - 1]`, never the raw virtual number.

### Shared drag pipeline

Both text and rect overlays are draggable using one document-level `mousemove` / `mouseup` pair. Whichever of `state.draggingRect` / `state.draggingText` is non-null identifies the in-flight drag; both structs share the same `{el, idx, offsetX, offsetY, startX, startY, moved}` shape. Document-level (not textLayer-level) binding is intentional so a mouse release outside the canvas still terminates the drag cleanly — same reasoning applies to the rectangle-drawing `mouseup`.

### Rect selection gotcha

`.rect-overlay.selected` is the implicit target of every toolbar slider (`updateSelectedRect()`). A stale selection will silently rewrite the wrong rect as the user drags sliders for a new one. `clearRectSelection()` must be called before starting a new draw, switching tools, or clicking empty canvas in text mode. If you add a new interaction that could leave a rect selected, call it there too.

## Code conventions

- Plain ES2017+, no modules, no transpile. Everything runs directly in the browser.
- DOM refs are cached once at the top of `app.js` via the `$()` helper. Reuse them rather than re-querying.
- Colors flow through `normalizeHexColor()` / `parseHexColor()` / `hexToRgba()`; opacity/width through `clampPercent()` / `percentToUnit()` / `normalizeBorderWidth()`. Use these at both creation and save sites so preview and saved PDF match — defaults must stay aligned between the two call sites (e.g. fill opacity defaults to 20, border opacity to 100 in both places).
- Existing inline bugfix comments document non-obvious invariants (text drag hit area, rect cross-contamination, border-only opacity, Ctrl+Z guard). Preserve them when refactoring nearby code.
