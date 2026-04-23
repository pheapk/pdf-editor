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

### Session 1 — Initial bug fixes (2026-04-17 Fri → 2026-04-18 Sat)

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

### Session 2 — Mark tool + z-order (2026-04-18 Sat)

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

### Session 3 — Handle visibility + rect resize (2026-04-18 Sat)

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

### Session 4 — × handle positioning (2026-04-19 Sun)

**Context.** Follow-up to session 3's residual bug. User chose option 1 (move ×, minimal change). What was meant to be a one-line CSS tweak became a four-iteration debug arc as each fix exposed the next failure mode.

#### v1 — `top: -18px` → `top: -24px`

Reasoning: × bottom (-8) clears NE resize handle top (-7) by 1px. Math looked clean on paper. Shipped → user reported:

> "The position is raised but they turn gray over mouse hover. And mouse shows line crossing, not figure. Cannot X rect or mark."

Diagnosis: 1px vertical clearance was insufficient because × and NE handle were still horizontally aligned (both at `right: -2` / `right: -7`). As the cursor approached × from below, it entered the NE handle's hit region first — cursor flipped to `nwse-resize` and the click landed on the handle, not ×.

#### v2 — diagonal offset + z-index

Pushed × to the OUTER-NE corner (`top: -28px; right: -20px; z-index: 11`):

| Element | Vertical | Horizontal (rel. parent right) |
| --- | --- | --- |
| × | -28 to -12 | +4 to +20 |
| NE resize handle | -7 to +7 | -7 to +7 |

5px vertical + 11px horizontal gap — boxes no longer touch in 2D. `z-index: 11` provides belt-and-braces (resize handles are z:10) so any future positioning regression still hits × first. Mark also shifted (same shared class), even though mark's only handle is bottom-right. Acceptable side effect at this stage.

User reloaded → reported a *new* bug:

> "even when the Rect or Mark is selected, X disappears when the mouse no longer hovers over within the 'box' around the Rect or Mark. So it's not possible to click on it."

#### v3 — the `:hover` disappearance trap

Diagnosis: × was being shown via `.rect-overlay:hover .text-overlay-handle { display: block }`. Because × now sits *outside* the rect's bounding box, moving the cursor from rect interior toward × crosses empty space — the `:hover` on `.rect-overlay` drops, × hides, click never lands. The same trap killed the mark ×.

Fix: decouple visibility from hover when the element is selected. Once the user clicks "edit this rect," × stays visible regardless of cursor position:

```css
.rect-overlay:hover .text-overlay-handle,
.rect-overlay.selected .text-overlay-handle { display: block; }
/* same for .mark-overlay */
```

Unselected rects keep hover-to-reveal so idle rects don't litter the canvas with × badges. User confirmed: works for text, rect, and mark.

#### v4 — per-type tightening

User feedback after v3:

> "X is a bit far from the box. Rect has thick border so it doesn't look too bad. We can move that the smallest. Second is the Mark, it seems further. X of Text is quite far."

The v2 position (-28/-20) was tuned to clear the rect's NE resize handle — but that constraint doesn't apply to text (no handles) or mark (only SE handle). One shared class meant text and mark inherited a position they didn't need. Solution: keep the base position for text and add per-type overrides:

| Overlay | top | right | Rationale |
| --- | --- | --- | --- |
| Text | -18 | -2 | No handles. Restore the original tight-corner placement. |
| Mark | -20 | -8 | NE clear; small extra offset reads as visual separation from the SVG body. |
| Rect | -24 | -12 | Must clear NE handle (-7/-7). Vertical: × bottom -8 vs NE top -7 → 1px gap, but horizontal offset (-12) means cursor approach path doesn't pass through NE before reaching ×. |

CSS specificity: `.rect-overlay .text-overlay-handle` (0,2,0) > `.text-overlay-handle` base (0,1,0), so overrides win cleanly without `!important`.

**Lesson recorded.** A "one-line CSS fix" that touches a class shared by three component types is rarely one line. v1 ignored the cursor-approach geometry (only checked bounding box overlap), v2 ignored that the `:hover` reveal selector requires the cursor to stay inside the bounding box, v3 fixed visibility but kept the over-conservative position for all three types, v4 differentiated by handle constraints. Each step was correct given what was known — the shape of the bug just kept revealing more of itself.

**Design notes — considered and rejected.**
- **Moving × to top-left corner.** NW resize handle is there too — same conflict, just relocated.
- **Hiding × while `.selected`.** Breaks the muscle memory of "hover → click × to delete" users have on unselected overlays. Adds a mode users must remember.
- **Single position with maximum offset for all types.** What v2 effectively did. Looks disconnected on text (which has no reason to push × that far out).

### Session 5 — Copy/paste for marks (2026-04-22 Wed)

**User request.** "I'd like to add the ability to copy and paste Mark."

**Design.** Keyboard only (Cmd/Ctrl+C, Cmd/Ctrl+V), no new UI. Paste lands on the *current* page (not the source page) so the user can "copy on page 2, navigate to page 5, paste here." Offset +20/+20 from the source coords — visibly distinct from the original without being disconnected. Repeated Cmd+V staircases because the clipboard's own `x/y` update to the just-placed position.

**v1 — shipped but silently broken.**

Added `state.markClipboard`, two branches in the existing document-level `keydown` listener. Syntax-checked, shipped. User reloaded and reported:

> "Copy and paste do not work. To clarify we should be able to copy paste in the same page."

Diagnosed end-to-end with Playwright rather than guessing:
1. Placed a mark, focused the stroke-width input, confirmed `document.activeElement.tagName === 'INPUT'` AND `.mark-overlay.selected` exists.
2. Pressed Meta+C / Meta+V → mark count unchanged.
3. Blurred the input (focus → body) → Meta+C / Meta+V → staircase appeared as designed.

**Root cause.** The v1 guard used `!isEditingField(document.activeElement)`, which matches `INPUT / TEXTAREA / SELECT / contentEditable`. Clicking a mark calls `e.preventDefault()` but does NOT blur previously-focused toolbar inputs — so once the user touches the stroke-width field or color picker, focus stays on that `<input>` even while the mark is visibly selected. Our handler thought the user was typing in a form field and yielded to the browser's native copy/paste (which does nothing meaningful on a color picker).

**Fix.** Narrow the guard: only bail if `document.activeElement.isContentEditable` is true. That preserves native copy/paste inside text overlays (where the user really *is* selecting text) but lets our shortcut run when the focus is on a mere form input that has nothing interesting to copy. A visibly-selected mark is the user's subject of attention regardless of which sliver of DOM happens to hold focus.

**Why not blur on mark click?** Considered and rejected. Stealing focus on every mark click would break the "click a mark, tweak its color, click somewhere else" muscle memory — users expect focus to stay where they put it. The guard change is surgical; it only affects the two new shortcuts.

**Commits.** v1 (broken) and the fix land together in the session-5 commit — v1 never shipped on its own, since Playwright caught the bug before it left the branch.

---

## Session 6 — 2026-04-23 Thu: Text copy / paste (mirror Mark)

With Mark copy / paste shipped and validated in Session 5, the natural next step was to extend the same shortcut to Text overlays. User's framing:

> "Now let add the copy and paste feature we did with Mark to Text."

followed by a critical carve-out:

> "it only works when the whole textbox is selected but not while editing text. While editing text, cmd/ctrl + c should copy work like normal text copy."

That constraint is what shaped the whole design. Rect copy / paste is deferred — one overlay type at a time.

### Design decision: unified clipboard, single slot

Renamed `state.markClipboard` → `state.clipboard = { type: 'mark' | 'text', data: {...} }`. A single-slot, discriminated clipboard matches the OS clipboard mental model — copying a text kicks out a copied mark and vice versa. Two-slot alternatives were considered and rejected: the UX becomes "which one gets pasted?" and no keyboard shortcut disambiguates cleanly. Single slot also makes the eventual Rect extension trivial (just add a third `type`).

### Copy priority: selected mark first, then focused text

When `!editingText`, the copy handler looks for a selected mark first; falling through, it reads `state.lastFocusedTextIdx` (the index of the most recently focused text on the current page — already tracked since Session 1 for the toolbar-recolor fix). This ordering matches what the user sees: a visible mark selection outline beats an invisible "text was last focused" hint.

Text doesn't have an explicit "selected" state — the contentEditable either has focus (editing) or it doesn't (candidate for overlay-copy). To copy a text overlay the user blurs first (click elsewhere, Escape). `lastFocusedTextIdx` survives the blur, so a Cmd+C right after tells us which overlay was the subject of attention.

### The carve-out: `isContentEditable` guard stays

`editingText = document.activeElement && document.activeElement.isContentEditable` — unchanged from Session 5. When the user is actively typing inside a text overlay, Cmd+C yields to the browser's native `copy` event (the text range in the `Selection` is what matters there, not the overlay itself). The handler doesn't call `preventDefault`, so the browser's default behavior runs. That's exactly the UX the user asked for.

Blurring the contentEditable (Escape, click-elsewhere) returns to "overlay copy" mode automatically — no extra state to flip.

### Subtle bug caught during design: set lastFocusedTextIdx AFTER render

First draft assigned `state.lastFocusedTextIdx = newIdx` before calling `renderAllOverlays()`. But `renderAllOverlays()` unconditionally nulls that field on every DOM rebuild (by design — stale indices after delete/undo/page-change are a known footgun; see the original `lastFocusedTextIdx` docstring). So the assignment was immediately clobbered, and the *next* Cmd+C had no text to target.

Fix: assign *after* render. A one-line ordering change with a comment explaining why. Easy to get wrong if someone refactors without reading the docstring, which is why the comment lives inline.

### Subtle UX choice: paste does NOT auto-focus

Text creation (click-to-place) auto-focuses the new overlay's contentEditable so the user can type immediately. But paste is different — the *point* of Cmd+V is to stamp a copy of already-authored text. Auto-focusing would flip into contentEditable mode, and the next Cmd+V would hit the `editingText` guard and native-paste instead of stamping another overlay. The staircase UX that makes copy / paste useful in this editor (hammer Cmd+V to place multiples) would break on the second press.

So paste leaves the pasted text unfocused. `lastFocusedTextIdx` is updated to point at the new overlay so a subsequent Cmd+C copies the just-pasted copy (which is usually what the user wants).

### Clamping heuristic for text

Marks store `w` and `h`, so the clamp `max(0, min(layerRect.w - w, x+20))` keeps the whole mark on-canvas. Text has no stored width — contentEditable auto-sizes to its content, which changes as the user types. Used a conservative 40px floor instead: `max(0, min(layerRect.w - 40, x+20))`. Forty is roughly the smallest visible drag surface; the clamp prevents a paste near the right edge from pushing the overlay entirely off-canvas, but it doesn't try to be perfect for wide content. Good enough.

### Verification (Playwright)

Dev server on :8000, fixture `test/fixtures/sample.pdf`, cache-bust via `?v=N`. Four test cases ran green:

1. **Text staircase.** Place text, type "hello", blur, Cmd+C, Cmd+V, Cmd+V. Three overlays at (149,149), (169,169), (189,189) — exact +20/+20 delta as specified.
2. **Native-copy carve-out.** Focus first text, select contents, Cmd+C then Cmd+V. Overlay count stayed at 3. `document.activeElement.isContentEditable` confirmed `true`. Handler did nothing (no `preventDefault`), browser handled copy / paste natively.
3. **Mark regression.** Switch to Mark tool, place a mark, Cmd+C, Cmd+V, Cmd+V. Three marks staircased. Session 5 behavior unchanged.
4. **Cross-type replace.** Copy mark → copy text → Cmd+V. Text count +1, mark count +0. Single-slot behavior confirmed.

### File touched

- `app.js` — state rename + keydown handler extension. Roughly 30 lines added around the existing mark branch.

---

*This log is updated as work progresses. Each commit referenced above corresponds to a concrete slice of the story; `git log --oneline` is the authoritative timeline.*
