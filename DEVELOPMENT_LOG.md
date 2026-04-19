# PDF Editor — Development Log

A running case study documenting the evolution of this browser-based PDF editor, built collaboratively with **Claude Code**. Each entry captures the user request (verbatim where useful), the diagnostic reasoning, the decisions made (including alternatives discussed), and the resulting implementation — offering a transparent look at AI-assisted ("vibe coding") development in practice.

---

## Project overview

Single-page app for lightweight PDF editing in the browser. No build step, no server component — every edit is applied client-side and exported via `pdf-lib`. Deployed via GitHub Pages on push to the working branch.

**Capabilities**
- Text overlays (add / edit / move / style)
- Rectangle overlays (fill, border, opacity)
- Checkmark & crossmark overlays
- Page navigation, single-page and range deletion
- Non-destructive save: original bytes kept untouched, every export re-derived from them

**Stack**
- Vanilla ES2017+ in a single IIFE (`app.js`) — no framework, no transpile
- [PDF.js](https://mozilla.github.io/pdf.js/) for on-screen rendering
- [pdf-lib](https://pdf-lib.js.org/) for export-time mutation

**Two-layer rendering model**
`#canvasContainer` stacks two elements at identical dimensions:
1. `<canvas id="pdfCanvas">` — PDF.js renders the page into this.
2. `<div id="textLayer">` — absolutely-positioned DOM overlays (text / rect / mark) that the user actually interacts with.

Overlays live in `state.{text,rect,mark}Overlays[pageNum]` keyed by virtual page number. On page switch, the textLayer is wiped and rebuilt from state via `renderAllOverlays()`.

**The critical invariant**
Canvas is rendered at `state.scale = 1.5` × the PDF's native size. Overlay `x/y/w/h` are stored in *canvas pixels* (top-left origin). At save time, each overlay is converted to PDF coordinates by scaling against `pageWidth/canvasWidth` and Y-flipping (PDF uses bottom-left origin). If `state.scale` or canvas sizing ever changes, the save-time math must stay in sync — otherwise the exported file drifts from the editor preview.

---

## Session log

### Session 1 — Initial bug fixes (2026-04-17 → 2026-04-18)

Four bugs reported from prior use:

1. **Re-uploading the same file silently no-op'd.** Selecting the identical filename twice didn't refire the `change` event because the input's `.value` was unchanged. *Fix:* reset `input.value = ''` after change. → commit `48dfd3f`.
2. **Rect drawing got "stuck" if mouse released off-canvas.** `mouseup` was bound to `textLayer`, so a release outside the canvas never fired the finalize logic. The `#rectPreview` ghost stayed; the next mousedown saw stale state. *Fix:* move `mouseup` to `document` (textLayer lost the event, document never does). → commit `48dfd3f`.
3. **Ctrl+Z inside form fields popped overlays.** Guard gated on `tagName !== 'DIV'`, ignoring `<input>/<textarea>/<select>`. *Fix:* explicit `isEditingField()` helper checking `isContentEditable` and form tags. → commit `48dfd3f`.
4. **Save-time opacity drifted from editor.** Fallbacks at save time defaulted to `0`, while creation-time defaulted to `20` (fill) / `100` (border). *Fix:* align fallbacks on both sides. → commit `48dfd3f`.

A second pass (commit `75765aa`) refined four more issues:
- **Rect cross-contamination**: `.selected` and `:hover` shared the exact same outline, so users unknowingly edited old rects while tuning toolbar values for new ones. *Fix:* loud solid orange outline for `.selected`; added Escape key, click-outside, and drag-commit deselect paths.
- **Border-only opacity at save**: an else-branch was emitting a phantom `fill: white, opacity: 0` that some viewers rendered as a faint box. *Fix:* skip the fill op entirely when `fillOpacity === 0`.
- **Text drag hit area**: the outer `.text-overlay` wrapper had only a 1px dashed border — essentially no click target. *Fix:* 4px padding on the wrapper, inner content keeps the `text` cursor, outer reads as a drag handle.
- **Text color inheritance**: some browsers don't cleanly cascade `color` into contentEditable regions. *Fix:* set color on both the wrapper and the inner content element.

### Session 2 — Mark tool + z-order (2026-04-18)

**Feature: checkmark / crossmark overlays.** User wanted a clean way to mark PDF checkboxes — rects or text were awkward approximations.

**Design iteration (v1 → v2)**

- **v1 (click-drag-to-size)** mirrored rect UX. User rejected:
  > "Click and drag create uneven mark, so we do not want that."

  A Firefox-only bug also snapped drag-placed marks to the left edge on release. Both issues dissolved with v2.

- **v2 (click-to-place)** — final design. A fixed 40×40 square centered on the click, auto-selected for immediate tweaking. Selection persists through drag ("select → edit" is the explicit workflow). A single bottom-right corner handle resizes, preserving the square aspect ratio.

**Implementation notes**
- SVG with `viewBox="0 0 100 100"` + `vector-effect: non-scaling-stroke` so the path stays valid at any box size while the stroke weight stays constant.
- Save path emits `pdf-lib`'s `drawLine()` calls directly (not `drawSvgPath()`) to sidestep Y-axis flip quirks. A `null` entry in the path array means "pen up" — used by the cross, which is two disjoint segments.
- Shipped as commit `646279a`.

**Related fix — z-order.** Rects were always drawn before text, so a 100%-opaque rect drawn *after* text still had text bleeding through (both in editor and in the exported PDF). *Fix:* add a monotonic `z` counter to every overlay at creation; merge all overlays and sort by z at both render time and save time. Array.sort is stable, so missing/duplicate z values fall back to insertion order. → commits `c611e31` / `9da0b56`.

### Session 3 — Handle visibility + rect resize (2026-04-18)

**User report (verbatim):**
> 1. The X on Rectangle turns gray when mouse hover so it's hard to see; it's almost like it's a bug. That X is still there but it is gray almost like the white background so hard to see.
> 2. Need ability to resize the rectangle
> 3. X on check or cross mark disappear on mouse hover so cannot delete the mark.

Reproduces on both Chrome and Firefox. Two screenshots attached (selected rect, selected mark).

#### Issue 1 & 3 — × handle washes out on hover

**Diagnosis.** Reading the cascade:
```css
.text-overlay-handle { background: var(--danger); color: white; }  /* specificity 0,1,0 */
button:hover         { background: var(--bg);     border-color: #cbd5e1; } /* specificity 0,1,1 */
```
`button:hover` wins on specificity. On hover the red (#dc2626) is replaced by near-white (#f5f5f5); white × text on near-white = visually gone (but still clickable). The same handle class is reused on both rect and mark overlays, so one CSS fix resolves both reports.

**Fix.** Add a higher-specificity rule `.text-overlay-handle:hover` (0,2,0, beats `button:hover`) keeping white text on a slightly darker red (#b91c1c) for legible hover feedback.

#### Issue 2 — Rectangle resize

**User design preference (via dialogue):**
> "4 way to resize at each wall (not corner), and also ability to resize using 4 corner (mark style) but this corner resize allow flexible resize, not square resize like the mark."

**Resolved design — 8 handles per selected rect, visible only when `.selected`:**
| Handle | Behavior | Cursor |
| --- | --- | --- |
| N (top)    | adjusts `y` and `h` | `ns-resize` |
| S (bottom) | adjusts `h` only    | `ns-resize` |
| W (left)   | adjusts `x` and `w` | `ew-resize` |
| E (right)  | adjusts `w` only    | `ew-resize` |
| NW         | adjusts `x`, `y`, `w`, `h` | `nwse-resize` |
| NE         | adjusts `y`, `w`, `h` | `nesw-resize` |
| SW         | adjusts `x`, `w`, `h` | `nesw-resize` |
| SE         | adjusts `w`, `h` | `nwse-resize` |

**Rule of thumb in the math:** any letter `'w'` in the handle name means *west edge moves, east edge stays fixed* (so `x` and `w` both change); `'e'` means *east edge moves, west stays fixed* (only `w` changes). Same for `'n'`/`'s'` on the vertical axis. This keeps the eight cases as one compact branch.

**Why this differs from the mark resize.** Marks use a single bottom-right corner handle with a square constraint because marks are fixed-shape ("a checkmark should always look the same"). Rects are the free-shape tool — eight handles with no aspect lock fit their role.

**Implementation summary**
- New `state.resizingRect = { el, idx, handle, startX, startY, origX, origY, origW, origH }`.
- `createRectElement()` appends 8 `.rect-resize-handle` divs (4 corners as circles, 4 edges as rounded squares). Each handle's `mousedown` calls `stopPropagation()` so the outer rect drag never kicks in.
- `document mousemove` gains a `resizingRect` branch that runs *before* the existing move-drag logic; computes new `x/y/w/h` with 8px min and canvas-edge clamping.
- `document mouseup` commits the new dimensions to state. Selection persists through resize (matches the "select, then edit" flow).
- Existing drag-commit code already has `div.classList.remove('selected')` on *move-drag* end — resize exits early before that line, so the selected state (and thus handle visibility) survives resize.

**Verification status**

Static verification: `node --check app.js` clean; CSS specificity math independently confirmed (`button:hover` = 0,1,1; `.text-overlay-handle:hover` = 0,2,0 → the latter wins). Interactive verification in Playwright was blocked by a stale MCP browser profile — rather than kill an unrelated process, this session deferred live-browser checks and left that to a manual reload. The code paths exercised are narrow (one CSS rule, one new state slot, two new document-listener branches, one loop appending child elements), and each was reviewed against its neighbors. Worst-case regressions would surface as JS errors on first rect draw or first resize attempt — easy to spot on reload.

**User verification and residual issue**

User confirmed resize works on all 8 handles and the × visibility is mostly resolved:
> "the resizing 4 walls, 4 corners of rectangle are good! X issue on rectangle is fixed for the most part, except the X is too close to the resize corner that it can be hard to point to X. For the X on the check/cross mark, it seems the same."

**Residual bug (open).** The × delete button sits at `top:-18px; right:-2px` (16×16). The NE corner resize handle sits at `top:-7px; right:-7px` (14×14). Those boxes overlap by ~11px horizontally and ~5px vertically — when both are visible on a selected rect, the × is hard to target because the cursor flips to `nwse-resize` before reaching it. Same effective problem on marks (× overlaps the bottom-right resize handle area). Deferred to next session. Fix candidates:

1. Move the × further out (e.g. `top:-22; right:-22`) so it clears both corner handles.
2. Relocate × to the top-left corner (away from the handles users typically reach for).
3. Hide × while the rect is `.selected` — handles and × never coexist. User deletes by pressing Delete/Backspace after selecting, or by Escape-then-hover.

Will decide with the user next session.

---

*This log is updated as work progresses. Each commit referenced above corresponds to a concrete slice of the story; `git log --oneline` is the authoritative timeline.*
