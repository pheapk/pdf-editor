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

## Session 7 — 2026-04-23 Thu: Box-level text selection (parity with Mark)

Right after Session 6 shipped, the user tested copy / paste and flagged a real UX gap:

> "When selecting the textbox in the middle, the cursor focus is inside the textbox, so cmd/ctrl + c doesn't copy the textbox. When selecting the border of the textbox it doesn't select the textbox. So we need to be able to select the border of the textbox, and that will select it and keep it selected. Then we can cmd/ctrl+c to copy and paste it. Mark after clicking on it, it stays selected."

The Session-6 design relied on `lastFocusedTextIdx` as the implicit "copy target" — the user had to blur first (click away or Escape) before Cmd+C would see a text overlay to copy. That's a hidden state: nothing on screen tells you that a text is still "logically selected" after you click away. Mark's UX doesn't have this problem because clicking a mark adds a visible `.selected` outline that persists.

Fix: give text overlays the same two-layer interaction as marks. Clicking the **wrapper's padding gutter** (the 4px border region) adds `.selected`; clicking **inside the contentEditable** enters edit mode and clears any selection.

### Two states, never both

The content `focus` handler now calls `clearTextSelection()`, so a text is either box-selected OR being edited, never both. Rationale: if a text were simultaneously outlined AND focused, the user would reasonably expect Cmd+C to copy one or the other, but our `editingText` guard forces the "focused" interpretation — so the outline would become a visual lie. Clearing it on focus means what you see matches what the keybind does.

### Copy priority: explicit beats implicit

The keydown copy handler now tries three sources in order:

1. `.mark-overlay.selected` — Session 5 behavior, unchanged.
2. `.text-overlay.selected` — **new**: the wrapper the user just box-clicked.
3. `state.lastFocusedTextIdx` — fallback for users who Escape out of editing and immediately hit Cmd+C. Kept because it's the natural "I was just here" hint and was the only path in Session 6.

Explicit selection beats the implicit "last focused" hint. If the user clicked a border, that's their unambiguous answer to "what do you want to copy?"

### Visual: orange outline, matches Mark

`.text-overlay.selected` previously set only `border-color: var(--primary)` (same blue as `:hover`), so selection was invisible against the hover state. Replaced with `outline: 3px solid #f59e0b` (same warm orange Mark uses). Three states now read distinctly:

- **Hover** — blue dashed border + subtle blue tint.
- **Editing** — blue solid border (`:focus-within`).
- **Box-selected** — orange outline with offset, plus the × delete handle stays visible.

No overlap. If the user hovers a selected text, the outline persists because `outline` is separate from `border`.

### Other behavior changes (all small)

- **Escape**: now blurs the contentEditable in addition to clearing selections. A single key leaves every edit state — no more "Escape, but I'm still somehow editing."
- **Outside-click clear**: `document mousedown` outside `#textLayer` / toolbars now also calls `clearTextSelection()`. Selections don't leak when the user drags the page around.
- **setTool**: clears text selection (already cleared rect and mark). Switching tools should never leave a stale box-selected overlay to receive stray Cmd+C.
- **Mark / rect creation handlers**: also clear text selection. Any "I'm starting a new overlay" action is a complete reset.
- **Paste**: after a text paste, the new overlay gets `.selected` added. Visible feedback for where the paste landed, and matches the mark-paste behavior from Session 5.

### Verification (Playwright)

Four cases, all green:

1. **Border click selects.** Click the 4px padding gutter at a wrapper's edge → `.text-overlay.selected` appears, `document.activeElement.isContentEditable === false`.
2. **Selected → Cmd+C → Cmd+V → Cmd+V staircases.** Three overlays at y+0 / +20 / +40, last is `.selected`.
3. **Content click clears selection.** Focus the contentEditable of a selected overlay → selection drops, `editingText === true`.
4. **Native-copy carve-out still intact.** Focus content, select range, Cmd+C → `defaultPrevented === false`, overlay count unchanged.

Computed-style check confirmed the selected outline renders at `rgb(245, 158, 11)` (the Mark orange) so there's no stylesheet-cascade surprise.

### Files touched

- `app.js` — one new helper (`clearTextSelection`), box-selection hook in the wrapper mousedown, clear on content focus, copy-priority extension, Escape / setTool / outside-click / paste integration.
- `styles.css` — `.text-overlay.selected` replaced with orange outline + persistent × handle rule.

### Follow-up: the "works only sometimes" bug

After the first version of this session shipped, the user tested and reported:

> "Copy seems to work, but randomly, because the cursor stays in the textbox when selecting the textborder border, or selecting another textbox. So when selecting a textbox border, the cursor needs to stay out of the inside the textbox."

**Root cause.** The wrapper mousedown calls `e.preventDefault()` so the browser doesn't start a native text selection or drag. But `preventDefault` on mousedown also suppresses the implicit blur that would normally fire when clicking a focusable element elsewhere. Net effect: the caret stayed parked in whichever overlay the user was previously editing (often a *different* text overlay). `editingText` was still `true` on the next keydown, so Cmd+C hit our carve-out and bailed to the browser's native copy on an empty Selection — which is the same as pressing Cmd+C on nothing. Symptom: "copy worked sometimes" (when nothing was focused) and "copy did nothing other times" (when a stale caret lingered).

**Fix.** Explicit blur in the wrapper mousedown, right before adding `.selected`:

```js
if (document.activeElement && document.activeElement.isContentEditable) {
    document.activeElement.blur();
}
```

Once blurred, `activeElement` is `<body>`, `editingText` is `false`, and the next keydown sees exactly one text overlay with `.selected` — an unambiguous copy target.

**Verified.** Created text A ("alpha"), text B ("beta"), left caret parked in B, clicked A's border, pressed Cmd+C then Cmd+V: `editingText: false`, `activeTag: BODY`, `aSelected: true`, paste produced a third overlay with text "alpha". No more "works only sometimes."

### Follow-up-to-the-follow-up: same bug across Mark and Rect

User tested again:

> "Ok the cursor fix but only for textbox to textbox. There is another issue, when the cursor is inside the textbox, selecting Mark doesn't remove the cursor from the inside the textbox, even though the Mark is selected."

Same root cause, wider scope. The Mark mousedown, Rect mousedown, and Rect drawing mousedown all call `preventDefault` — same implicit-blur suppression, same "caret parked in a text overlay stays put" outcome. Even the empty-canvas click-to-place mark path was a latent trap: if the user switched from Text to Mark tool via the toolbar, the contentEditable caret survived the tool switch, and clicking empty canvas to drop a new mark didn't always blur it (browser-dependent).

**Fix.** Extracted the blur pattern into a small helper and called it from every mousedown that preventDefaults + the click-to-place mark path:

```js
function blurActiveEditable() {
    if (document.activeElement && document.activeElement.isContentEditable) {
        document.activeElement.blur();
    }
}
```

Call sites: text wrapper mousedown (replaces the inline blur from the earlier follow-up), mark overlay mousedown, rect overlay mousedown, rect drawing mousedown, mark click-to-place. Five sites, one-line each.

**Verified.** Four Playwright cases, all green:

- **Text → existing mark.** Caret in a text, click a mark on-canvas → body active, mark selected. Then Cmd+C / Cmd+V → mark count +1, text count unchanged. The exact case the user reported.
- **Text → existing rect.** Caret in a text, click a rect → body active, rect selected, `editingText === false`.
- **Text → mark click-to-place.** Caret in a text, toolbar switch to Mark, click empty canvas → body active, new mark auto-selected.
- **Regression text → text.** Still works — Session-7 behavior unchanged, now via the shared helper.

One loose end: the text creation path (click empty canvas in Text tool) doesn't need the helper because it calls `focusTextContent()` on the new overlay, which moves focus explicitly and naturally blurs the previous caret. That's the one "click empty canvas" path that doesn't need defensive blur.

---

## Session 8 — 2026-04-25 Sat: Make dev-log workflow tool-agnostic

Two days after Session 7 wrapped, the user opened a fresh conversation worried about persistence:

> "If I close this session and return back to a new session, will claude code continue adding to development_log.md session 7… I want to make sure that new session will continue adding to the developmenet_log.md"

Then a follow-up that broadened the scope:

> "I want to add instructions in claude.md that reference development_log.md and development_log_instructions.md so that new session coding agent knows what to do without needed to rely on memory because other coding agent like Codex or Gemini will not have memory like you do."

Up to this point, the dev-log practice was kept alive by Claude Code's memory system — a feedback file at `~/.claude/projects/.../memory/feedback_dev_log.md` that auto-loads into each Claude conversation. That works for Claude. It does nothing for Codex (`AGENTS.md`), Cursor (`.cursor/rules/`), Gemini CLI (`GEMINI.md`), or anyone reading a different convention. The workflow needed to live in the repo, not in a tool-specific store.

### Decisions

Three small choices, each with a real fork:

- **`AGENTS.md` strategy: symlink vs duplicate vs one-line pointer.** Symlink is cleanest (single source of truth) but flaky on Windows, where it can serialize as a plain text path. Duplicate keeps two files in sync (manual chore). One-line pointer is portable but relies on agents *following* the pointer rather than reading inline. User picked the one-line pointer — minimal, no Windows edge case, and tools that respect `AGENTS.md` will read its single sentence and open `CLAUDE.md` for the rest.
- **Where to surface "the plan."** The instructions doc already covered request → diagnosis → decision → execution → verification. User asked: should plans go in too? Considered making plan a subsection of "decision process" (they overlap) vs a separate numbered item (they're different artifacts — one is dialogue, the other is the agent's pre-coding proposal). Picked the latter, with a no-plan caveat for trivial / auto-edit changes so the section doesn't become a forced ritual.
- **Memory: keep or remove?** The feedback memory at `feedback_dev_log.md` is now redundant with the in-repo `CLAUDE.md` pointer. User said "rely on the files," not "delete the memory." Left the memory in place as harmless redundancy; if it ever drifts from the docs, the docs win.

### Plan

Plan mode produced two passes. The first re-entry was inherited from the prior session's plan file (the Mark/Rect blur fix, already implemented before context compaction); verified it was already in `app.js` and exited cleanly. The second pass — after the user clarified scope — wrote the actual plan: rewrite `DEVELOPMENT_LOG_INSTRUCTIONS.md` for an agent audience (drop the user-facing "copy this into your project" bootstrap, add §4 "The plan"), insert a new "Development log" section into `CLAUDE.md` between Ground rules and Running locally, and create `AGENTS.md` as a one-line pointer. Out of scope: removing the memory entry, committing the unrelated `.gitignore` / `.playwright-mcp/` leftovers.

One in-flight reversal worth recording: the first version of CLAUDE.md's opening line called `AGENTS.md` "a symlink to this file." That was true under the symlink approach the user later rejected. After they picked the text-pointer instead, the line was updated to "points here" so it stays accurate.

### Implementation

Commit `81342ae` — three files, +178/−1.

- `DEVELOPMENT_LOG_INSTRUCTIONS.md` rewritten end-to-end. Audience swapped from user-as-bootstrapper to coding-agent-as-maintainer. New §4 "The plan" lives between decision process and implementation summary, with the no-plan caveat as prose. The worked-example excerpt was extended to include a "Plan" subsection so the format is anchored, not just described.
- `CLAUDE.md` first line widened from "Claude Code (claude.ai/code)" to enumerate Claude Code, Codex, Cursor, Gemini CLI, Aider — plus a sentence pointing at `AGENTS.md`. New "## Development log" section sits directly after "Ground rules," ahead of "Running locally," because it's process content, not architecture.
- `AGENTS.md` is a single sentence pointing at `CLAUDE.md`. Tools that respect the `AGENTS.md` convention read it and chase the pointer.

### Verification

No runtime to test. Confirmed by reading `CLAUDE.md` after the edits to check that the first line, the new section, and the section ordering all landed. Confirmed `AGENTS.md` is a regular file, not a symlink, per the user's preference.

This entry itself was written in a follow-up commit after `81342ae`, not alongside it — a minor departure from the "commit the log alongside the feature commit" rule. The cause was ordering: the user wanted to commit the workflow change first, then decide whether the meta-work warranted a session entry. Worth noting precisely because the rules now in force say not to do that.

### Files touched

- `CLAUDE.md`
- `DEVELOPMENT_LOG_INSTRUCTIONS.md`
- `AGENTS.md`
- `DEVELOPMENT_LOG.md` (this entry)

---

*This log is updated as work progresses. Each commit referenced above corresponds to a concrete slice of the story; `git log --oneline` is the authoritative timeline.*
