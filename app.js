(function () {
    'use strict';

    // Configure PDF.js worker
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    // ---- State ----
    const state = {
        pdfDoc: null,          // pdf.js document
        pdfBytes: null,        // original file bytes (ArrayBuffer)
        currentPage: 1,
        totalPages: 0,
        scale: 1.5,
        activeTool: 'text',   // 'text', 'rect', or 'mark'
        // textOverlays[pageNum] = [ { x, y, text, fontSize, color, fontFamily, z } ]
        textOverlays: {},
        // rectOverlays[pageNum] = [ { x, y, w, h, fillColor, fillOpacity, borderColor, borderOpacity, borderWidth, z } ]
        rectOverlays: {},
        // markOverlays[pageNum] = [ { x, y, w, h, kind: 'check'|'cross', color, strokeWidth, z } ]
        // Marks are click-to-place with a fixed square size (MARK_DEFAULT_SIZE)
        // centered on the click. Click-drag-to-size was removed because uneven
        // aspect ratios looked wrong for checkbox marking, and a Firefox-only
        // bug caused drag-created marks to snap to the left edge on release.
        // Clicking an existing mark selects it; toolbar color/width then apply
        // to the selection, and a corner handle allows square-preserving resize.
        markOverlays: {},
        // BUGFIX (rect doesn't cover text): every overlay gets a monotonically
        // increasing `z` at creation. renderAllOverlays() and the save handler
        // both sort by z so later-created overlays paint on top of earlier
        // ones regardless of type. Previously rects were always rendered
        // before text, so a 100%-opaque rect drawn after text still had text
        // visibly bleeding through — both in the editor preview and in the
        // saved PDF. Page number doesn't matter for the counter (no two
        // overlays can share a page AND a z).
        nextZ: 0,
        // Drag state for drawing rectangles
        drawing: false,
        drawStart: null,
        // Drag state for moving existing rectangles
        draggingRect: null, // { el, idx, offsetX, offsetY, startX, startY, moved }
        // Drag state for moving existing text overlays. Same shape as
        // draggingRect. Added because text overlays were not movable
        // previously — only rectangles had a drag handler. Now both kinds of
        // overlay reuse the same document-level mousemove/mouseup pipeline.
        draggingText: null, // { el, idx, offsetX, offsetY, startX, startY, moved }
        // Drag state for moving existing marks. Same shape as the two above.
        draggingMark: null,
        // Resize state for marks. Bottom-right handle drags outward from the
        // fixed top-left anchor; size = max(dx, dy) + origSize so the mark
        // stays square (user requirement: no uneven marks).
        resizingMark: null,
        // Resize state for rectangles. Unlike marks, rects get 8 handles
        // (4 edges + 4 corners) and no square constraint — the user wants
        // free-form w/h. `handle` is a compass string ('n', 's', 'e', 'w',
        // 'nw', 'ne', 'sw', 'se'); its letters drive the math in the
        // mousemove branch (a 'w' moves the west edge, so x AND w change;
        // an 'e' keeps the west edge fixed, so only w changes; same for
        // n/s on the vertical axis).
        resizingRect: null,
        // Page mapping: virtual page index → original pdf.js page number
        pageMap: [],
        // BUGFIX (bug 2 — can't recolor existing text): tracks the index of
        // the most recently focused text overlay on the current page. The
        // toolbar inputs (font size / color / family) used to gate their
        // handlers on `.text-overlay-content:focus`, but clicking any of
        // those inputs steals focus from the contentEditable, so the guard
        // always failed silently and the edit was dropped. Instead we
        // remember which overlay was last focused and apply toolbar edits
        // to it by index. Cleared in renderAllOverlays() (DOM rebuild) so
        // stale indices can't point at the wrong overlay after page change,
        // delete, undo, or clear.
        lastFocusedTextIdx: null,
    };

    // ---- DOM refs ----
    const $ = (sel) => document.querySelector(sel);
    const uploadArea   = $('#uploadArea');
    const dropZone     = $('#dropZone');
    const fileInput    = $('#fileInput');
    const filePickerBtn = $('#filePickerBtn');
    const editorArea   = $('#editorArea');
    const toolbar      = $('#toolbar');
    const canvas       = $('#pdfCanvas');
    const textLayer    = $('#textLayer');
    const prevPageBtn  = $('#prevPage');
    const nextPageBtn  = $('#nextPage');
    const pageInfo     = $('#pageInfo');
    const fontSizeIn   = $('#fontSize');
    const fontColorIn  = $('#fontColor');
    const fontFamilyIn = $('#fontFamily');
    const undoBtn      = $('#undoBtn');
    const clearPageBtn = $('#clearPageBtn');
    const saveBtn      = $('#saveBtn');
    const loadingOverlay = $('#loadingOverlay');
    const ctx          = canvas.getContext('2d');

    // Tool toggle & rect controls
    const toolTextBtn      = $('#toolText');
    const toolRectBtn      = $('#toolRect');
    const textControls     = $('#textControls');
    const rectControls     = $('#rectControls');
    const rectFillIn       = $('#rectFill');
    const rectFillOpacIn   = $('#rectFillOpacity');
    const rectBorderIn     = $('#rectBorder');
    const rectBorderOpacIn = $('#rectBorderOpacity');
    const rectBorderWidthIn = $('#rectBorderWidth');
    const rectFillOpacLabel  = $('#rectFillOpacLabel');
    const rectBorderOpacLabel = $('#rectBorderOpacLabel');
    const deletePageBtn    = $('#deletePageBtn');
    const deleteRangeBtn   = $('#deleteRangeBtn');
    const deleteFromIn     = $('#deleteFrom');
    const deleteToIn       = $('#deleteTo');

    // Mark tool controls
    const toolMarkBtn      = $('#toolMark');
    const markControls     = $('#markControls');
    const markKindCheckBtn = $('#markKindCheck');
    const markKindCrossBtn = $('#markKindCross');
    const markColorIn      = $('#markColor');
    const markStrokeWidthIn = $('#markStrokeWidth');

    // ---- Helpers ----
    function showLoading() { loadingOverlay.classList.remove('hidden'); }
    function hideLoading() { loadingOverlay.classList.add('hidden'); }

    function getOverlays(page) {
        if (!state.textOverlays[page]) state.textOverlays[page] = [];
        return state.textOverlays[page];
    }

    function getRectOverlays(page) {
        if (!state.rectOverlays[page]) state.rectOverlays[page] = [];
        return state.rectOverlays[page];
    }

    function getMarkOverlays(page) {
        if (!state.markOverlays[page]) state.markOverlays[page] = [];
        return state.markOverlays[page];
    }

    function getCurrentMarkKind() {
        return markKindCrossBtn && markKindCrossBtn.classList.contains('active') ? 'cross' : 'check';
    }

    function normalizeHexColor(hex, fallback = '#000000') {
        let h = String(hex || fallback).trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(h)) {
            h = h.split('').map((ch) => ch + ch).join('');
        }
        if (!/^[0-9a-f]{6}$/i.test(h)) {
            h = String(fallback).replace(/^#/, '');
        }
        return '#' + h.toLowerCase();
    }

    function parseHexColor(hex) {
        const h = normalizeHexColor(hex).slice(1);
        return {
            r: Number.parseInt(h.substring(0, 2), 16),
            g: Number.parseInt(h.substring(2, 4), 16),
            b: Number.parseInt(h.substring(4, 6), 16),
        };
    }

    function clampPercent(value, fallback = 100) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(100, n));
    }

    function percentToUnit(value, fallback = 100) {
        return clampPercent(value, fallback) / 100;
    }

    function normalizeBorderWidth(value, fallback = 2) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, n);
    }

    function hexToRgba(hex, opacityPercent) {
        const c = parseHexColor(hex);
        const a = percentToUnit(opacityPercent, 0);
        return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + a + ')';
    }

    function getEditableText(el) {
        return (el.innerText || el.textContent || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    }

    function focusTextContent(el) {
        el.focus();
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // ---- File Upload ----
    filePickerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
        // BUGFIX: reset the input's value so selecting the SAME file a second
        // time still fires a `change` event. Without this, re-uploading the
        // exact same file (e.g. after editing it externally) silently no-ops
        // because the browser considers the value unchanged.
        e.target.value = '';
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type === 'application/pdf') {
            handleFile(file);
        }
    });

    async function handleFile(file) {
        showLoading();
        try {
            const arrayBuffer = await file.arrayBuffer();
            state.pdfBytes = arrayBuffer;
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
            state.pdfDoc = await loadingTask.promise;
            state.totalPages = state.pdfDoc.numPages;
            state.currentPage = 1;
            state.textOverlays = {};
            state.rectOverlays = {};
            state.markOverlays = {};
            state.pageMap = Array.from({ length: state.totalPages }, (_, i) => i + 1);

            uploadArea.classList.add('hidden');
            editorArea.classList.remove('hidden');
            toolbar.classList.remove('hidden');

            await renderPage(state.currentPage);
        } catch (err) {
            alert('Failed to load PDF: ' + err.message);
        } finally {
            hideLoading();
        }
    }

    // ---- Page Rendering ----
    async function renderPage(num) {
        const originalPageNum = state.pageMap[num - 1];
        const page = await state.pdfDoc.getPage(originalPageNum);
        const viewport = page.getViewport({ scale: state.scale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        textLayer.style.width = viewport.width + 'px';
        textLayer.style.height = viewport.height + 'px';

        await page.render({ canvasContext: ctx, viewport }).promise;

        updatePageInfo();
        renderAllOverlays();
    }

    function renderAllOverlays() {
        textLayer.innerHTML = '';
        // Any prior focused text overlay index is now stale — the DOM has
        // just been wiped and indices may shift (delete/undo/page change).
        // See state.lastFocusedTextIdx docstring.
        state.lastFocusedTextIdx = null;

        // Paint by creation order (z): later overlays stack on top. Both kinds
        // append to the same parent, so DOM append order IS paint order.
        // Array.sort is stable in modern engines, so missing/duplicate z
        // values fall back to insertion order without re-shuffling.
        const rects = getRectOverlays(state.currentPage);
        const texts = getOverlays(state.currentPage);
        const marks = getMarkOverlays(state.currentPage);
        const items = [
            ...rects.map((ov, idx) => ({ kind: 'rect', ov, idx })),
            ...texts.map((ov, idx) => ({ kind: 'text', ov, idx })),
            ...marks.map((ov, idx) => ({ kind: 'mark', ov, idx })),
        ].sort((a, b) => (a.ov.z || 0) - (b.ov.z || 0));

        for (const item of items) {
            if (item.kind === 'rect') createRectElement(item.ov, item.idx);
            else if (item.kind === 'mark') createMarkElement(item.ov, item.idx);
            else createOverlayElement(item.ov, item.idx);
        }
    }

    function updatePageInfo() {
        pageInfo.textContent = `Page ${state.currentPage} / ${state.totalPages}`;
        prevPageBtn.disabled = state.currentPage <= 1;
        nextPageBtn.disabled = state.currentPage >= state.totalPages;
        const onlyOnePage = state.totalPages <= 1;
        deletePageBtn.disabled = onlyOnePage;
        deleteRangeBtn.disabled = onlyOnePage;
        deleteFromIn.max = state.totalPages;
        deleteToIn.max = state.totalPages;
    }

    // ---- Page Navigation ----
    prevPageBtn.addEventListener('click', async () => {
        if (state.currentPage <= 1) return;
        saveCurrentOverlays();
        state.currentPage--;
        await renderPage(state.currentPage);
    });

    nextPageBtn.addEventListener('click', async () => {
        if (state.currentPage >= state.totalPages) return;
        saveCurrentOverlays();
        state.currentPage++;
        await renderPage(state.currentPage);
    });

    // ---- Text Overlays ----
    function createOverlayElement(ov, idx) {
        const div = document.createElement('div');
        div.className = 'text-overlay';
        div.style.left = ov.x + 'px';
        div.style.top = ov.y + 'px';
        div.style.fontSize = ov.fontSize + 'px';
        div.style.color = ov.color;
        div.style.fontFamily = mapFont(ov.fontFamily);
        div.dataset.index = idx;

        const content = document.createElement('div');
        content.className = 'text-overlay-content';
        content.contentEditable = true;
        content.spellcheck = false;
        content.textContent = ov.text;
        content.dataset.index = idx;
        // BUGFIX (text color rendered gray): color was only being set on the
        // outer wrapper div and we relied on CSS inheritance to cascade into
        // the contentEditable child. In some browser/CSS combinations the
        // contentEditable element doesn't inherit `color` cleanly (e.g. user-
        // agent styles on editable regions, or interaction with the
        // :focus-within background rule making dark text look washed out).
        // Setting color directly on the content element guarantees the
        // chosen color actually renders.
        content.style.color = ov.color;
        div.appendChild(content);

        // Delete button
        const handle = document.createElement('button');
        handle.className = 'text-overlay-handle';
        handle.textContent = '\u00d7';
        handle.title = 'Delete';
        handle.addEventListener('click', (e) => {
            e.stopPropagation();
            getOverlays(state.currentPage).splice(idx, 1);
            renderAllOverlays();
        });
        div.appendChild(handle);

        // Sync edits back to state
        content.addEventListener('input', () => {
            const overlay = getOverlays(state.currentPage)[idx];
            if (overlay) overlay.text = getEditableText(content);
        });

        // When focused, remember this as the active text overlay and sync
        // the toolbar to its values. BUGFIX (bug 2): we now stash the index
        // in state.lastFocusedTextIdx so the toolbar input handlers can
        // still find it after focus moves to the color/size/font picker
        // (which blurs the contentEditable). Previously they gated on
        // `.text-overlay-content:focus` and silently no-op'd.
        content.addEventListener('focus', () => {
            state.lastFocusedTextIdx = idx;
            fontSizeIn.value = ov.fontSize;
            fontColorIn.value = ov.color;
            fontFamilyIn.value = ov.fontFamily;
        });

        // BUGFIX (text drag): text overlays used to be pinned wherever they
        // were first placed — there was no drag handler at all. Now we bind
        // mousedown to the OUTER wrapper (`.text-overlay`) and explicitly
        // ignore events originating on the inner content (`.text-overlay-
        // content`) or the delete button. That split preserves the existing
        // interactions:
        //   - click inside the text  → focuses contentEditable for editing
        //   - click on the × handle  → deletes the overlay
        //   - mousedown on the 1px dashed border area (the ~4px margin the
        //     outer div exposes around the content) → begins a drag
        // We reuse the document-level mousemove/mouseup pipeline below by
        // populating `state.draggingText` with the same {el, idx, offset,
        // start, moved} shape already used by `state.draggingRect`.
        div.addEventListener('mousedown', (e) => {
            if (e.target === content || content.contains(e.target)) return;
            if (e.target === handle) return;
            // Don't swallow the event if the user is actively editing —
            // a mousedown on the border while focused would otherwise blur
            // the content and feel jarring. Let blur happen naturally first.
            e.preventDefault();

            const r = div.getBoundingClientRect();
            state.draggingText = {
                el: div,
                idx,
                offsetX: e.clientX - r.left,
                offsetY: e.clientY - r.top,
                startX: e.clientX,
                startY: e.clientY,
                moved: false,
            };
            div.classList.add('dragging');
        });

        textLayer.appendChild(div);
        return content;
    }

    // ---- Tool Switching ----
    toolTextBtn.addEventListener('click', () => setTool('text'));
    toolRectBtn.addEventListener('click', () => setTool('rect'));

    // BUGFIX (rect cross-contamination): Centralizes the "deselect every rect"
    // operation. `updateSelectedRect()` mutates whichever rect still has the
    // `.selected` class, so a stale selection from an earlier click causes
    // every toolbar slider change to silently rewrite that old rect — which
    // surfaced to the user as "drawing a new rect changed my old one" and
    // also as "opacity doesn't always work" (they were dragging the slider
    // while an invisible old rect was receiving the update instead of the
    // new one they expected). Call this before starting any new draw,
    // switching tools, or clicking on empty canvas.
    function clearRectSelection() {
        textLayer.querySelectorAll('.rect-overlay.selected')
            .forEach((el) => el.classList.remove('selected'));
    }

    // Default square side (canvas pixels) for click-to-place marks. Chosen
    // to roughly match the size of a typical PDF checkbox; the user can
    // resize after placement via the corner handle.
    const MARK_DEFAULT_SIZE = 40;

    function clearMarkSelection() {
        textLayer.querySelectorAll('.mark-overlay.selected')
            .forEach((el) => el.classList.remove('selected'));
    }

    // Sync the mark toolbar (color, stroke width) to the given overlay when
    // it becomes selected. Kind buttons are intentionally NOT synced — they
    // represent "kind for the NEXT mark you place", so clicking Check/Cross
    // while a mark is selected affects future marks only, not the selection.
    // This avoids the "I clicked cross and my selected check turned into a
    // cross" confusion.
    function syncToolbarToMark(ov) {
        markColorIn.value = ov.color;
        markStrokeWidthIn.value = ov.strokeWidth;
    }

    // Mirror the rect toolbar→selection pipeline for marks: the `.selected`
    // mark is the implicit target of color/width input events, and we
    // re-style its SVG path in place rather than a full re-render (faster
    // and keeps the selection class where it is).
    function updateSelectedMark() {
        const sel = textLayer.querySelector('.mark-overlay.selected');
        if (!sel) return;
        const idx = parseInt(sel.dataset.markIndex, 10);
        const ov = getMarkOverlays(state.currentPage)[idx];
        if (!ov) return;
        ov.color = normalizeHexColor(markColorIn.value, '#16a34a');
        ov.strokeWidth = normalizeBorderWidth(markStrokeWidthIn.value, 3);
        const path = sel.querySelector('svg path');
        if (path) {
            path.setAttribute('stroke', ov.color);
            path.setAttribute('stroke-width', String(ov.strokeWidth));
        }
    }

    function setTool(tool) {
        state.activeTool = tool;
        toolTextBtn.classList.toggle('active', tool === 'text');
        toolRectBtn.classList.toggle('active', tool === 'rect');
        toolMarkBtn.classList.toggle('active', tool === 'mark');
        textControls.classList.toggle('hidden', tool !== 'text');
        rectControls.classList.toggle('hidden', tool !== 'rect');
        markControls.classList.toggle('hidden', tool !== 'mark');
        // Both rect (click-drag) and mark (click-to-place) read as
        // "create-on-canvas" tools, so both get the crosshair cursor.
        // `.drawing-rect` is a mild misnomer now; kept to avoid a CSS
        // rename churn in this diff.
        textLayer.classList.toggle('drawing-rect', tool === 'rect' || tool === 'mark');
        // Switching tools should never leave a rect "selected" for the next
        // tool's toolbar inputs to accidentally mutate. See clearRectSelection.
        clearRectSelection();
        // Same reasoning for marks — a stale mark selection would silently
        // receive color/width edits meant for the next mark.
        clearMarkSelection();
    }

    toolMarkBtn.addEventListener('click', () => setTool('mark'));
    markKindCheckBtn.addEventListener('click', () => {
        markKindCheckBtn.classList.add('active');
        markKindCrossBtn.classList.remove('active');
    });
    markKindCrossBtn.addEventListener('click', () => {
        markKindCrossBtn.classList.add('active');
        markKindCheckBtn.classList.remove('active');
    });

    // Click on textLayer: in text mode creates a text box; in mark mode
    // places a fixed-size square mark centered on the click.
    textLayer.addEventListener('click', (e) => {
        // Mark mode: click-to-place. Switched from the old click-drag UX
        // because (a) drag produced uneven aspect ratios users disliked for
        // checkbox marking, and (b) a Firefox-only bug caused drag-created
        // marks to snap to the left edge on mouseup. A fixed square removes
        // both issues; the user can still resize via the corner handle after
        // selection.
        if (state.activeTool === 'mark') {
            if (e.target.closest('.text-overlay') || e.target.closest('.rect-overlay') || e.target.closest('.mark-overlay')) return;
            clearRectSelection();
            clearMarkSelection();
            const rect = textLayer.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const SIZE = MARK_DEFAULT_SIZE;
            // Center the mark on the click, then clamp so the full box stays
            // inside the canvas.
            const overlay = {
                x: Math.max(0, Math.min(rect.width - SIZE, cx - SIZE / 2)),
                y: Math.max(0, Math.min(rect.height - SIZE, cy - SIZE / 2)),
                w: SIZE,
                h: SIZE,
                kind: getCurrentMarkKind(),
                color: normalizeHexColor(markColorIn.value, '#16a34a'),
                strokeWidth: normalizeBorderWidth(markStrokeWidthIn.value, 3),
                z: state.nextZ++,
            };
            getMarkOverlays(state.currentPage).push(overlay);
            const newIdx = getMarkOverlays(state.currentPage).length - 1;
            renderAllOverlays();
            // Auto-select so the user can immediately tweak color / width /
            // size without an extra click. Matches the rect auto-select
            // behavior introduced for bug 4.
            const newEl = textLayer.querySelector('.mark-overlay[data-mark-index="' + newIdx + '"]');
            if (newEl) newEl.classList.add('selected');
            return;
        }
        if (state.activeTool !== 'text') return;
        if (e.target.closest('.text-overlay') || e.target.closest('.rect-overlay') || e.target.closest('.mark-overlay')) return;

        // Clicking empty canvas in text mode is an unambiguous "I'm done with
        // that rect I had selected" signal — drop the selection so later
        // toolbar tweaks don't silently rewrite it. (See clearRectSelection.)
        clearRectSelection();

        const rect = textLayer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const overlay = {
            x,
            y,
            text: '',
            fontSize: parseInt(fontSizeIn.value, 10) || 16,
            // BUGFIX (text color): normalize through normalizeHexColor() to
            // match how rect creation handles its color inputs (see
            // mouseup handler further down). Previously this was a raw
            // `fontColorIn.value || '#000000'`, so any unexpected value
            // format silently slipped through and broke downstream CSS
            // inheritance / PDF rendering.
            color: normalizeHexColor(fontColorIn.value, '#000000'),
            fontFamily: fontFamilyIn.value || 'Helvetica',
            z: state.nextZ++,
        };

        getOverlays(state.currentPage).push(overlay);
        const idx = getOverlays(state.currentPage).length - 1;
        const el = createOverlayElement(overlay, idx);
        focusTextContent(el);
    });

    // ---- Rectangle Drawing (mousedown → mousemove → mouseup) ----
    // Only rectangles use the click-drag-to-size pipeline now. Marks moved
    // to click-to-place — see the textLayer click handler above.
    textLayer.addEventListener('mousedown', (e) => {
        if (state.activeTool !== 'rect') return;
        if (e.target.closest('.text-overlay') || e.target.closest('.rect-overlay') || e.target.closest('.mark-overlay')) return;

        // BUGFIX (rect cross-contamination): MUST clear the previous selection
        // BEFORE we start a new draw. Otherwise the prior `.selected` rect
        // remains the target of `updateSelectedRect()` — and once the user
        // finishes the new draw and starts tweaking toolbar values for it,
        // those values are written to the OLD rect (or both). See
        // clearRectSelection() comment for the full chain.
        clearRectSelection();

        const rect = textLayer.getBoundingClientRect();
        state.drawing = true;
        state.drawStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        // Create preview element
        const preview = document.createElement('div');
        preview.className = 'rect-preview';
        preview.style.left = state.drawStart.x + 'px';
        preview.style.top = state.drawStart.y + 'px';
        preview.style.width = '0px';
        preview.style.height = '0px';
        preview.id = 'rectPreview';
        textLayer.appendChild(preview);

        e.preventDefault();
    });

    textLayer.addEventListener('mousemove', (e) => {
        if (!state.drawing || !state.drawStart) return;

        const rect = textLayer.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;

        const x = Math.min(state.drawStart.x, curX);
        const y = Math.min(state.drawStart.y, curY);
        const w = Math.abs(curX - state.drawStart.x);
        const h = Math.abs(curY - state.drawStart.y);

        const preview = $('#rectPreview');
        if (preview) {
            preview.style.left = x + 'px';
            preview.style.top = y + 'px';
            preview.style.width = w + 'px';
            preview.style.height = h + 'px';
        }
    });

    // BUGFIX: mouseup is bound to `document` (not `textLayer`) on purpose.
    // Previously this listener lived on textLayer, so if the user started a
    // drag inside the canvas but released the mouse OUTSIDE it (e.g. over the
    // toolbar or off the window edge), mouseup would never fire here:
    //   - state.drawing stayed `true`,
    //   - the #rectPreview ghost div was never removed, and
    //   - the next mousedown saw stale state and produced a broken rect.
    // Binding on document guarantees we always see the mouse release no matter
    // where it lands, so we can finalize (or cancel) the draw cleanly.
    document.addEventListener('mouseup', (e) => {
        if (!state.drawing || !state.drawStart) return;

        const rect = textLayer.getBoundingClientRect();
        // Clamp the release point to the textLayer bounds. If the user dragged
        // off-canvas, we still produce a rectangle that ends at the edge
        // rather than extending past it with negative/overflowing coords.
        const rawX = e.clientX - rect.left;
        const rawY = e.clientY - rect.top;
        const endX = Math.max(0, Math.min(rect.width, rawX));
        const endY = Math.max(0, Math.min(rect.height, rawY));

        const x = Math.min(state.drawStart.x, endX);
        const y = Math.min(state.drawStart.y, endY);
        const w = Math.abs(endX - state.drawStart.x);
        const h = Math.abs(endY - state.drawStart.y);

        state.drawing = false;
        state.drawStart = null;

        // Remove preview
        const preview = $('#rectPreview');
        if (preview) preview.remove();

        // Only create if big enough (avoid accidental clicks)
        if (w < 5 || h < 5) return;

        const overlay = {
            x, y, w, h,
            fillColor: normalizeHexColor(rectFillIn.value),
            fillOpacity: clampPercent(rectFillOpacIn.value, 20),
            borderColor: normalizeHexColor(rectBorderIn.value),
            borderOpacity: clampPercent(rectBorderOpacIn.value, 100),
            borderWidth: normalizeBorderWidth(rectBorderWidthIn.value),
            z: state.nextZ++,
        };

        getRectOverlays(state.currentPage).push(overlay);
        const newIdx = getRectOverlays(state.currentPage).length - 1;
        renderAllOverlays();

        // BUGFIX (bug 4 — opacity slider "sticks"): auto-select the rect we
        // just drew. Without this, renderAllOverlays() rebuilds all rects
        // with no .selected class, so updateSelectedRect() silently no-ops
        // on every subsequent slider move until the user remembers to click
        // the rect. From the user's POV the slider "doesn't work" or the
        // color is stuck at the initial opacity. Auto-selecting matches the
        // intent: you just made this rect, you're about to tune it.
        const newEl = textLayer.querySelector('.rect-overlay[data-rect-index="' + newIdx + '"]');
        if (newEl) newEl.classList.add('selected');
    });

    // ---- Rectangle Element Creation ----
    function applyRectStyles(div, ov) {
        div.style.backgroundColor = hexToRgba(ov.fillColor, ov.fillOpacity);
        div.style.borderStyle = 'solid';
        div.style.borderWidth = normalizeBorderWidth(ov.borderWidth, 0) + 'px';
        div.style.borderColor = hexToRgba(ov.borderColor, ov.borderOpacity);
    }

    function createRectElement(ov, idx) {
        const div = document.createElement('div');
        div.className = 'rect-overlay';
        div.style.left = ov.x + 'px';
        div.style.top = ov.y + 'px';
        div.style.width = ov.w + 'px';
        div.style.height = ov.h + 'px';
        div.dataset.rectIndex = idx;

        applyRectStyles(div, ov);

        // Delete button
        const handle = document.createElement('button');
        handle.className = 'text-overlay-handle';
        handle.textContent = '\u00d7';
        handle.title = 'Delete';
        handle.addEventListener('click', (e) => {
            e.stopPropagation();
            getRectOverlays(state.currentPage).splice(idx, 1);
            renderAllOverlays();
        });
        div.appendChild(handle);

        // 8 resize handles: 4 corners + 4 edges. Shown only when the rect
        // is .selected (CSS). Each stops propagation in mousedown so the
        // outer rect drag doesn't also fire. The compass string on each
        // handle drives the math in the document-level mousemove branch.
        const RECT_HANDLES = [
            { pos: 'nw', kind: 'corner' },
            { pos: 'n',  kind: 'edge' },
            { pos: 'ne', kind: 'corner' },
            { pos: 'e',  kind: 'edge' },
            { pos: 'se', kind: 'corner' },
            { pos: 's',  kind: 'edge' },
            { pos: 'sw', kind: 'corner' },
            { pos: 'w',  kind: 'edge' },
        ];
        for (const h of RECT_HANDLES) {
            const rh = document.createElement('div');
            rh.className = 'rect-resize-handle ' + h.pos + ' ' + h.kind;
            rh.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                state.resizingRect = {
                    el: div,
                    idx,
                    handle: h.pos,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: ov.x,
                    origY: ov.y,
                    origW: ov.w,
                    origH: ov.h,
                };
            });
            div.appendChild(rh);
        }

        // Mousedown: start drag or select
        div.addEventListener('mousedown', (e) => {
            if (e.target === handle) return; // let delete button work
            // Resize handles have their own mousedown that stopPropagates,
            // but keep a defensive guard in case the event somehow reaches
            // here (e.g. target being the handle's child in the future).
            if (e.target.classList && e.target.classList.contains('rect-resize-handle')) return;
            e.stopPropagation();
            e.preventDefault();

            const layerRect = textLayer.getBoundingClientRect();
            state.draggingRect = {
                el: div,
                idx,
                offsetX: e.clientX - div.getBoundingClientRect().left,
                offsetY: e.clientY - div.getBoundingClientRect().top,
                startX: e.clientX,
                startY: e.clientY,
                moved: false,
            };
            div.classList.add('dragging');

            // Select this rect and populate toolbar
            setTool('rect');
            rectFillIn.value = ov.fillColor;
            rectFillOpacIn.value = ov.fillOpacity;
            rectBorderIn.value = ov.borderColor;
            rectBorderOpacIn.value = ov.borderOpacity;
            rectBorderWidthIn.value = ov.borderWidth;
            updateOpacityLabels();
            textLayer.querySelectorAll('.rect-overlay.selected').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
        });

        textLayer.appendChild(div);
        return div;
    }

    // ---- Mark Element Creation ----
    // Paths are expressed in a 0..100 viewBox so the same two path strings
    // work at any size. `vector-effect: non-scaling-stroke` keeps the line
    // weight constant when the viewBox is stretched to a non-square box.
    const MARK_PATHS = {
        check: 'M 20 55 L 40 75 L 85 25',
        cross: 'M 20 20 L 80 80 M 80 20 L 20 80',
    };

    function createMarkElement(ov, idx) {
        const div = document.createElement('div');
        div.className = 'mark-overlay';
        div.style.left = ov.x + 'px';
        div.style.top = ov.y + 'px';
        div.style.width = ov.w + 'px';
        div.style.height = ov.h + 'px';
        div.dataset.markIndex = idx;

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', MARK_PATHS[ov.kind] || MARK_PATHS.check);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', ov.color);
        path.setAttribute('stroke-width', String(ov.strokeWidth));
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('vector-effect', 'non-scaling-stroke');

        svg.appendChild(path);
        div.appendChild(svg);

        const handle = document.createElement('button');
        handle.className = 'text-overlay-handle';
        handle.textContent = '\u00d7';
        handle.title = 'Delete';
        handle.addEventListener('click', (e) => {
            e.stopPropagation();
            getMarkOverlays(state.currentPage).splice(idx, 1);
            renderAllOverlays();
        });
        div.appendChild(handle);

        // Resize handle — visible only while the mark is selected (CSS).
        // Dragging it resizes the mark while preserving the square aspect
        // ratio from the anchored top-left corner.
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'mark-resize-handle';
        resizeHandle.title = 'Resize';
        div.appendChild(resizeHandle);

        resizeHandle.addEventListener('mousedown', (e) => {
            // Stop the outer mark mousedown from kicking off a move drag.
            e.stopPropagation();
            e.preventDefault();
            state.resizingMark = {
                el: div,
                idx,
                startX: e.clientX,
                startY: e.clientY,
                origW: ov.w,
                origH: ov.h,
                origX: ov.x,
                origY: ov.y,
            };
        });

        div.addEventListener('mousedown', (e) => {
            if (e.target === handle || e.target === resizeHandle) return;
            e.stopPropagation();
            e.preventDefault();

            // Select this mark before any move-drag. Selection drives (1) the
            // orange outline the user requested, (2) toolbar color/width sync,
            // and (3) visibility of the resize handle. Done unconditionally —
            // if the user clicks without dragging, the selection remains so
            // they can tweak color/width. (Rect deselects after drag by
            // design, but marks keep selection because the explicit intent of
            // the feature is "select, then edit".)
            setTool('mark');
            div.classList.add('selected');
            syncToolbarToMark(ov);

            state.draggingMark = {
                el: div,
                idx,
                offsetX: e.clientX - div.getBoundingClientRect().left,
                offsetY: e.clientY - div.getBoundingClientRect().top,
                startX: e.clientX,
                startY: e.clientY,
                moved: false,
            };
            div.classList.add('dragging');
        });

        textLayer.appendChild(div);
        return div;
    }

    // Update selected rect when toolbar values change
    function updateSelectedRect() {
        const sel = textLayer.querySelector('.rect-overlay.selected');
        if (!sel) return;
        const idx = parseInt(sel.dataset.rectIndex, 10);
        const ov = getRectOverlays(state.currentPage)[idx];
        if (!ov) return;
        ov.fillColor = normalizeHexColor(rectFillIn.value);
        ov.fillOpacity = clampPercent(rectFillOpacIn.value, 20);
        ov.borderColor = normalizeHexColor(rectBorderIn.value);
        ov.borderOpacity = clampPercent(rectBorderOpacIn.value, 100);
        ov.borderWidth = normalizeBorderWidth(rectBorderWidthIn.value);
        applyRectStyles(sel, ov);
    }

    function updateOpacityLabels() {
        rectFillOpacLabel.textContent = rectFillOpacIn.value + '%';
        rectBorderOpacLabel.textContent = rectBorderOpacIn.value + '%';
    }

    rectFillIn.addEventListener('input', updateSelectedRect);
    rectFillOpacIn.addEventListener('input', () => { updateOpacityLabels(); updateSelectedRect(); });
    rectBorderIn.addEventListener('input', updateSelectedRect);
    rectBorderOpacIn.addEventListener('input', () => { updateOpacityLabels(); updateSelectedRect(); });
    rectBorderWidthIn.addEventListener('input', updateSelectedRect);

    // Mark toolbar edits apply to whichever mark is currently .selected.
    // Kind buttons (Check / Cross) are not wired here — they control the
    // kind of the NEXT mark to place, not the current selection.
    markColorIn.addEventListener('input', updateSelectedMark);
    markStrokeWidthIn.addEventListener('input', updateSelectedMark);

    // Update the active text overlay when toolbar values change.
    //
    // BUGFIX (bug 2 — can't recolor existing text / resize / change font
    // after placing): these handlers used to gate on
    // `.text-overlay-content:focus`, but clicking the color/size/font
    // picker moves focus OUT of the contentEditable, so by the time the
    // `input` event fires the selector returns null and the edit is
    // silently dropped. We now resolve the target via
    // state.lastFocusedTextIdx (set in the content `focus` handler,
    // cleared on every renderAllOverlays rebuild) and look the DOM
    // element up by data-index — independent of current focus.
    function getActiveTextEls() {
        const idx = state.lastFocusedTextIdx;
        if (idx == null) return null;
        const overlay = getOverlays(state.currentPage)[idx];
        if (!overlay) return null;
        const wrapper = textLayer.querySelector('.text-overlay[data-index="' + idx + '"]');
        if (!wrapper) return null;
        const content = wrapper.querySelector('.text-overlay-content');
        if (!content) return null;
        return { idx, overlay, wrapper, content };
    }

    fontSizeIn.addEventListener('input', () => {
        const t = getActiveTextEls();
        if (!t) return;
        const val = parseInt(fontSizeIn.value, 10) || 16;
        t.overlay.fontSize = val;
        t.wrapper.style.fontSize = val + 'px';
        t.content.style.fontSize = val + 'px';
    });

    fontColorIn.addEventListener('input', () => {
        const t = getActiveTextEls();
        if (!t) return;
        // Color set on BOTH the wrapper and the inner contentEditable —
        // some browsers don't cleanly inherit `color` into editable
        // regions, so relying on cascade alone renders as the body
        // default. Normalize first so downstream (CSS + PDF save) sees
        // the same canonical hex.
        const color = normalizeHexColor(fontColorIn.value, '#000000');
        t.overlay.color = color;
        t.wrapper.style.color = color;
        t.content.style.color = color;
    });

    fontFamilyIn.addEventListener('change', () => {
        const t = getActiveTextEls();
        if (!t) return;
        t.overlay.fontFamily = fontFamilyIn.value;
        t.wrapper.style.fontFamily = mapFont(fontFamilyIn.value);
    });

    function mapFont(name) {
        const map = {
            Helvetica: 'Helvetica, Arial, sans-serif',
            TimesRoman: "'Times New Roman', Times, serif",
            Courier: "'Courier New', Courier, monospace",
        };
        return map[name] || name;
    }

    // Save current overlay DOM state back into the state object
    function saveCurrentOverlays() {
        const elems = textLayer.querySelectorAll('.text-overlay');
        const overlays = getOverlays(state.currentPage);
        elems.forEach((el, i) => {
            if (overlays[i]) {
                const content = el.querySelector('.text-overlay-content');
                overlays[i].text = content ? getEditableText(content).trimEnd() : '';
            }
        });
    }

    // ---- Undo / Clear ----
    undoBtn.addEventListener('click', () => {
        if (state.activeTool === 'rect') {
            const rects = getRectOverlays(state.currentPage);
            if (rects.length) { rects.pop(); renderAllOverlays(); }
        } else if (state.activeTool === 'mark') {
            const marks = getMarkOverlays(state.currentPage);
            if (marks.length) { marks.pop(); renderAllOverlays(); }
        } else {
            const overlays = getOverlays(state.currentPage);
            if (overlays.length) { overlays.pop(); renderAllOverlays(); }
        }
    });

    clearPageBtn.addEventListener('click', () => {
        state.textOverlays[state.currentPage] = [];
        state.rectOverlays[state.currentPage] = [];
        state.markOverlays[state.currentPage] = [];
        renderAllOverlays();
    });

    // ---- Delete Pages ----
    async function deletePages(from, to) {
        if (from < 1 || to > state.totalPages || from > to) {
            alert('Invalid page range. Please enter values between 1 and ' + state.totalPages + '.');
            return;
        }
        const deleteCount = to - from + 1;
        if (deleteCount >= state.totalPages) {
            alert('Cannot delete all pages. At least one page must remain.');
            return;
        }
        const msg = deleteCount === 1
            ? 'Delete page ' + from + '?'
            : 'Delete pages ' + from + ' to ' + to + ' (' + deleteCount + ' pages)?';
        if (!confirm(msg)) return;

        saveCurrentOverlays();

        // Remove from pageMap
        state.pageMap.splice(from - 1, deleteCount);

        // Rebuild overlays with shifted keys
        const newText = {};
        const newRect = {};
        const newMark = {};
        for (const [key, val] of Object.entries(state.textOverlays)) {
            const p = parseInt(key, 10);
            if (p >= from && p <= to) continue; // deleted
            const newP = p > to ? p - deleteCount : p;
            newText[newP] = val;
        }
        for (const [key, val] of Object.entries(state.rectOverlays)) {
            const p = parseInt(key, 10);
            if (p >= from && p <= to) continue;
            const newP = p > to ? p - deleteCount : p;
            newRect[newP] = val;
        }
        for (const [key, val] of Object.entries(state.markOverlays)) {
            const p = parseInt(key, 10);
            if (p >= from && p <= to) continue;
            const newP = p > to ? p - deleteCount : p;
            newMark[newP] = val;
        }
        state.textOverlays = newText;
        state.rectOverlays = newRect;
        state.markOverlays = newMark;

        state.totalPages -= deleteCount;
        if (state.currentPage > state.totalPages) {
            state.currentPage = state.totalPages;
        }
        await renderPage(state.currentPage);
    }

    deletePageBtn.addEventListener('click', () => deletePages(state.currentPage, state.currentPage));
    deleteRangeBtn.addEventListener('click', () => {
        const from = parseInt(deleteFromIn.value, 10);
        const to = parseInt(deleteToIn.value, 10);
        deletePages(from, to);
    });

    // ---- Save & Download ----
    saveBtn.addEventListener('click', async () => {
        saveCurrentOverlays();
        showLoading();

        try {
            const { PDFDocument, rgb, StandardFonts } = PDFLib;
            const pdfDoc = await PDFDocument.load(state.pdfBytes);

            // Remove deleted pages (reverse order to preserve indices)
            const originalPageCount = pdfDoc.getPageCount();
            const keptPages = new Set(state.pageMap);
            for (let i = originalPageCount - 1; i >= 0; i--) {
                if (!keptPages.has(i + 1)) {
                    pdfDoc.removePage(i);
                }
            }
            const pages = pdfDoc.getPages();

            // Embed standard fonts
            const fonts = {
                Helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
                TimesRoman: await pdfDoc.embedFont(StandardFonts.TimesRoman),
                Courier: await pdfDoc.embedFont(StandardFonts.Courier),
            };

            // Helper: get viewport for a virtual page number
            async function getViewportForPage(pageNumStr) {
                const virtualNum = parseInt(pageNumStr, 10);
                const originalNum = state.pageMap[virtualNum - 1];
                const pdfPage = await state.pdfDoc.getPage(originalNum);
                return pdfPage.getViewport({ scale: state.scale });
            }

            function parsePdfColor(hex) {
                const c = parseHexColor(hex);
                return {
                    r: c.r / 255,
                    g: c.g / 255,
                    b: c.b / 255,
                };
            }

            // ---- Draw overlays in creation order (z) so later ones cover earlier ones ----
            // BUGFIX (rect doesn't cover text): previously rects were drawn in
            // one pass, then text in a second pass, so a 100%-opaque rect
            // drawn after text still had text bleeding through in the output
            // PDF. We now merge both kinds per-page, sort by z, and emit
            // pdf-lib draw calls in that order — pdf-lib paints in call order.
            const allPageKeys = new Set([
                ...Object.keys(state.rectOverlays),
                ...Object.keys(state.textOverlays),
                ...Object.keys(state.markOverlays),
            ]);

            // Mark path segments in normalized (0..1) coords within the mark's
            // bounding box. A `null` entry means "pen up" — start a new segment
            // at the next point (used by the cross, which is two disjoint
            // lines). Kept here so the save code and createMarkElement stay
            // in sync on the geometry.
            const MARK_SAVE_PATHS = {
                check: [[0.20, 0.55], [0.40, 0.75], [0.85, 0.25]],
                cross: [[0.20, 0.20], [0.80, 0.80], null, [0.80, 0.20], [0.20, 0.80]],
            };

            for (const pageNumStr of allPageKeys) {
                const pageIdx = parseInt(pageNumStr, 10) - 1;
                if (pageIdx < 0 || pageIdx >= pages.length) continue;
                const page = pages[pageIdx];
                const { width: pageWidth, height: pageHeight } = page.getSize();
                const viewport = await getViewportForPage(pageNumStr);
                const canvasWidth = viewport.width;
                const canvasHeight = viewport.height;

                const rects = state.rectOverlays[pageNumStr] || [];
                const texts = state.textOverlays[pageNumStr] || [];
                const marks = state.markOverlays[pageNumStr] || [];
                const items = [
                    ...rects.map(ov => ({ kind: 'rect', ov })),
                    ...texts.map(ov => ({ kind: 'text', ov })),
                    ...marks.map(ov => ({ kind: 'mark', ov })),
                ].sort((a, b) => (a.ov.z || 0) - (b.ov.z || 0));

                for (const { kind, ov } of items) {
                    if (kind === 'rect') {
                        const pdfX = (ov.x / canvasWidth) * pageWidth;
                        const pdfW = (ov.w / canvasWidth) * pageWidth;
                        const pdfH = (ov.h / canvasHeight) * pageHeight;
                        // Flip Y: top of rect in canvas → bottom-left origin in PDF
                        const pdfY = pageHeight - ((ov.y / canvasHeight) * pageHeight) - pdfH;

                        const rectOpts = { x: pdfX, y: pdfY, width: pdfW, height: pdfH };

                        // BUGFIX: fallbacks were both `0` here, but at creation
                        // time (mouseup handler) the defaults are 20 for fill
                        // and 100 for border. Keep save-time fallbacks
                        // aligned with creation-time defaults so an overlay
                        // missing these fields still renders at the UI default.
                        const fillOpacity = clampPercent(ov.fillOpacity, 20);
                        const borderOpacity = clampPercent(ov.borderOpacity, 100);
                        const borderWidth = normalizeBorderWidth(ov.borderWidth, 0);
                        const hasFill = fillOpacity > 0;
                        const hasBorder = borderOpacity > 0 && borderWidth > 0;

                        if (!hasFill && !hasBorder) continue;

                        if (hasFill) {
                            const fill = parsePdfColor(ov.fillColor);
                            rectOpts.color = rgb(fill.r, fill.g, fill.b);
                            rectOpts.opacity = fillOpacity / 100;
                        }
                        // BUGFIX (opacity): previously the else-branch set
                        // `color: rgb(1,1,1); opacity: 0` as a "transparent
                        // white fill" workaround. pdf-lib still emitted a fill
                        // operator, which some viewers render as a faint white
                        // box. Leaving color/opacity unset skips the fill op
                        // entirely and emits only the stroke.

                        if (hasBorder) {
                            const border = parsePdfColor(ov.borderColor);
                            rectOpts.borderColor = rgb(border.r, border.g, border.b);
                            rectOpts.borderOpacity = borderOpacity / 100;
                            rectOpts.borderWidth = borderWidth / state.scale;
                        }

                        page.drawRectangle(rectOpts);
                    } else if (kind === 'mark') {
                        const pdfX = (ov.x / canvasWidth) * pageWidth;
                        const pdfW = (ov.w / canvasWidth) * pageWidth;
                        const pdfH = (ov.h / canvasHeight) * pageHeight;
                        // Top-left of mark in canvas space → bottom-left in PDF space.
                        // mapPoint converts normalized (u,v) within the box
                        // (v=0 at top, v=1 at bottom in canvas convention) to
                        // PDF coords (bottom-left origin).
                        const pdfTopY = pageHeight - (ov.y / canvasHeight) * pageHeight;
                        const mapPoint = (u, v) => ({
                            x: pdfX + u * pdfW,
                            y: pdfTopY - v * pdfH,
                        });

                        const c = parsePdfColor(ov.color);
                        const thickness = normalizeBorderWidth(ov.strokeWidth, 3) / state.scale;
                        const path = MARK_SAVE_PATHS[ov.kind] || MARK_SAVE_PATHS.check;

                        let prev = null;
                        for (const pt of path) {
                            if (pt === null) { prev = null; continue; }
                            const here = mapPoint(pt[0], pt[1]);
                            if (prev) {
                                page.drawLine({
                                    start: prev,
                                    end: here,
                                    thickness,
                                    color: rgb(c.r, c.g, c.b),
                                    opacity: 1,
                                });
                            }
                            prev = here;
                        }
                    } else {
                        const text = ov.text;
                        if (!text) continue;

                        const pdfX = (ov.x / canvasWidth) * pageWidth;
                        const scaledFontSize = (ov.fontSize / state.scale);
                        const pdfY = pageHeight - ((ov.y / canvasHeight) * pageHeight) - scaledFontSize;

                        const font = fonts[ov.fontFamily] || fonts.Helvetica;
                        const c = parsePdfColor(ov.color);

                        const lines = text.split('\n');
                        lines.forEach((line, lineIdx) => {
                            page.drawText(line, {
                                x: pdfX,
                                y: pdfY - (lineIdx * scaledFontSize * 1.2),
                                size: scaledFontSize,
                                font,
                                color: rgb(c.r, c.g, c.b),
                            });
                        });
                    }
                }
            }

            const modifiedBytes = await pdfDoc.save();
            const blob = new Blob([modifiedBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'edited.pdf';
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            alert('Failed to save PDF: ' + err.message);
            console.error(err);
        } finally {
            hideLoading();
        }
    });

    // ---- Overlay Dragging (document-level) ----
    // Both rect and text drags reuse the same document-level handlers so that
    // releasing the mouse anywhere on the page — even outside the canvas —
    // still terminates the drag cleanly. `state.draggingRect` and
    // `state.draggingText` use the same shape; whichever one is non-null
    // identifies which kind of overlay is being dragged.
    document.addEventListener('mousemove', (e) => {
        // Rect resize: 8-handle free-form. Any letter 'w' means the west
        // edge moves (right edge is the anchor, x and w both change); 'e'
        // keeps the west edge fixed and only w changes. Same logic on the
        // n/s axis for y and h. Min size 8px; canvas-edge clamped so the
        // rect can't escape the viewport. Handled before resizingMark for
        // consistency with the checked-first pattern.
        if (state.resizingRect) {
            const rr = state.resizingRect;
            const dx = e.clientX - rr.startX;
            const dy = e.clientY - rr.startY;
            const layerRect = textLayer.getBoundingClientRect();
            const MIN = 8;

            let newX = rr.origX;
            let newY = rr.origY;
            let newW = rr.origW;
            let newH = rr.origH;

            if (rr.handle.indexOf('w') !== -1) {
                const rightEdge = rr.origX + rr.origW;
                newX = Math.max(0, Math.min(rr.origX + dx, rightEdge - MIN));
                newW = rightEdge - newX;
            } else if (rr.handle.indexOf('e') !== -1) {
                newW = Math.max(MIN, Math.min(rr.origW + dx, layerRect.width - rr.origX));
            }
            if (rr.handle.indexOf('n') !== -1) {
                const bottomEdge = rr.origY + rr.origH;
                newY = Math.max(0, Math.min(rr.origY + dy, bottomEdge - MIN));
                newH = bottomEdge - newY;
            } else if (rr.handle.indexOf('s') !== -1) {
                newH = Math.max(MIN, Math.min(rr.origH + dy, layerRect.height - rr.origY));
            }

            rr.el.style.left = newX + 'px';
            rr.el.style.top = newY + 'px';
            rr.el.style.width = newW + 'px';
            rr.el.style.height = newH + 'px';
            return;
        }

        // Mark resize: top-left anchored, square-preserving. Checked first so
        // a simultaneous drag state (shouldn't exist, but defensive) can't
        // fight the resize.
        if (state.resizingMark) {
            const rm = state.resizingMark;
            const dx = e.clientX - rm.startX;
            const dy = e.clientY - rm.startY;
            // Larger of the two axes drives the square size so the user
            // feels in control whichever way they drag the handle.
            const delta = Math.max(dx, dy);
            const layerRect = textLayer.getBoundingClientRect();
            // Don't let the mark grow past the canvas edge from its fixed
            // top-left; don't let it shrink below 8px (stroke-linejoin gets
            // weird past that).
            const maxSize = Math.min(layerRect.width - rm.origX, layerRect.height - rm.origY);
            const size = Math.max(8, Math.min(maxSize, rm.origW + delta));
            rm.el.style.width = size + 'px';
            rm.el.style.height = size + 'px';
            return;
        }

        const dr = state.draggingRect || state.draggingText || state.draggingMark;
        if (!dr) return;

        const dx = e.clientX - dr.startX;
        const dy = e.clientY - dr.startY;

        if (!dr.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            dr.moved = true;
        }

        if (dr.moved) {
            const layerRect = textLayer.getBoundingClientRect();
            let newX = e.clientX - layerRect.left - dr.offsetX;
            let newY = e.clientY - layerRect.top - dr.offsetY;

            // Clamp within textLayer bounds. Rect and mark know their size
            // from state (ov.w/ov.h). Text overlays size to content so we
            // measure the element's rendered size instead.
            if (state.draggingRect) {
                const ov = getRectOverlays(state.currentPage)[dr.idx];
                newX = Math.max(0, Math.min(newX, layerRect.width - ov.w));
                newY = Math.max(0, Math.min(newY, layerRect.height - ov.h));
            } else if (state.draggingMark) {
                const ov = getMarkOverlays(state.currentPage)[dr.idx];
                newX = Math.max(0, Math.min(newX, layerRect.width - ov.w));
                newY = Math.max(0, Math.min(newY, layerRect.height - ov.h));
            } else {
                newX = Math.max(0, Math.min(newX, layerRect.width - dr.el.offsetWidth));
                newY = Math.max(0, Math.min(newY, layerRect.height - dr.el.offsetHeight));
            }

            dr.el.style.left = newX + 'px';
            dr.el.style.top = newY + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        // Commit rect resize to state. Selection persists so the user can
        // continue tweaking the same rect (toolbar edits, further resize,
        // or a move-drag). Early return before the move-drag commit code
        // below, which would otherwise strip .selected on drag-end.
        if (state.resizingRect) {
            const rr = state.resizingRect;
            const ov = getRectOverlays(state.currentPage)[rr.idx];
            if (ov) {
                ov.x = parseFloat(rr.el.style.left);
                ov.y = parseFloat(rr.el.style.top);
                ov.w = parseFloat(rr.el.style.width);
                ov.h = parseFloat(rr.el.style.height);
            }
            state.resizingRect = null;
            return;
        }

        // Commit mark resize to state. Selection is kept so the user can
        // continue tweaking color / width / position.
        if (state.resizingMark) {
            const rm = state.resizingMark;
            const ov = getMarkOverlays(state.currentPage)[rm.idx];
            if (ov) {
                ov.w = parseFloat(rm.el.style.width);
                ov.h = parseFloat(rm.el.style.height);
            }
            state.resizingMark = null;
            return;
        }

        const dr = state.draggingRect || state.draggingText || state.draggingMark;
        if (!dr) return;

        dr.el.classList.remove('dragging');

        if (dr.moved) {
            // Commit new position back to state. Use the correct overlay
            // array depending on which drag was in flight.
            let ov;
            if (state.draggingRect) ov = getRectOverlays(state.currentPage)[dr.idx];
            else if (state.draggingMark) ov = getMarkOverlays(state.currentPage)[dr.idx];
            else ov = getOverlays(state.currentPage)[dr.idx];
            if (ov) {
                ov.x = parseFloat(dr.el.style.left);
                ov.y = parseFloat(dr.el.style.top);
            }
            // BUGFIX (bug 3): dragging a rect to MOVE it is not an intent
            // to edit its props — the user's cursor is heading elsewhere.
            // Leaving .selected on after a drag was the most common way
            // users ended up "editing" an old rect without realizing it.
            if (state.draggingRect) dr.el.classList.remove('selected');
        }

        state.draggingRect = null;
        state.draggingText = null;
        state.draggingMark = null;
    });

    // ---- Keyboard shortcuts ----
    // BUGFIX: isEditingField() replaces the old `tagName !== 'DIV'` check.
    //   The previous guard was wrong in two ways:
    //     1. It blocked our Ctrl+Z any time focus was on ANY div — but our
    //        text overlays are the ONLY divs we actually want to exempt, and
    //        we really only care that they're contentEditable.
    //     2. It did NOT exempt <input>/<textarea>/<select> (font size, color
    //        picker, page range, etc.). Pressing Ctrl+Z inside those fields
    //        should trigger the browser's native undo on that field, not pop
    //        an overlay off the page.
    //   Using `isContentEditable` + form-field tag names fixes both cases.
    function isEditingField(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    document.addEventListener('keydown', (e) => {
        // Ctrl+Z to undo (only when not editing text / in a form field)
        if (e.ctrlKey && e.key === 'z' && !isEditingField(document.activeElement)) {
            e.preventDefault();
            undoBtn.click();
        }
        // Ctrl+S to save
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            if (state.pdfDoc) saveBtn.click();
        }
        // BUGFIX (bug 3): Escape deselects any active rect. Gives the user
        // an explicit, always-available way to leave edit mode before
        // changing toolbar values that should NOT apply to the last rect
        // they clicked.
        if (e.key === 'Escape') {
            clearRectSelection();
            clearMarkSelection();
        }
    });

    // BUGFIX (bug 3): mousedown outside both the canvas and the rect
    // toolbar clears .selected. Example: user clicks rect A (now
    // .selected), moves to the header/body/page-nav to do something else,
    // then comes back and changes the color picker expecting to set up
    // the next draw — without this, rect A would be silently rewritten.
    // We deliberately do NOT clear on clicks inside #textLayer (handled
    // there: rect mousedowns re-select, empty-space mousedowns draw and
    // already clear) or inside #rectControls (those clicks ARE the
    // intentional edit of the currently selected rect).
    document.addEventListener('mousedown', (e) => {
        if (textLayer.contains(e.target)) return;
        if (rectControls.contains(e.target)) return;
        if (markControls.contains(e.target)) return;
        clearRectSelection();
        clearMarkSelection();
    });
})();
