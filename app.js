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
        activeTool: 'text',   // 'text' or 'rect'
        // textOverlays[pageNum] = [ { x, y, text, fontSize, color, fontFamily } ]
        textOverlays: {},
        // rectOverlays[pageNum] = [ { x, y, w, h, fillColor, fillOpacity, borderColor, borderOpacity, borderWidth } ]
        rectOverlays: {},
        // Drag state for drawing rectangles
        drawing: false,
        drawStart: null,
        // Drag state for moving existing rectangles
        draggingRect: null, // { el, idx, offsetX, offsetY, startX, startY, moved }
        // Page mapping: virtual page index → original pdf.js page number
        pageMap: [],
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
        // Render rects first (behind text)
        getRectOverlays(state.currentPage).forEach((ov, idx) => {
            createRectElement(ov, idx);
        });
        // Then text on top
        getOverlays(state.currentPage).forEach((ov, idx) => {
            createOverlayElement(ov, idx);
        });
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

        // When focused, update toolbar controls to match this overlay
        content.addEventListener('focus', () => {
            fontSizeIn.value = ov.fontSize;
            fontColorIn.value = ov.color;
            fontFamilyIn.value = ov.fontFamily;
        });

        textLayer.appendChild(div);
        return content;
    }

    // ---- Tool Switching ----
    toolTextBtn.addEventListener('click', () => setTool('text'));
    toolRectBtn.addEventListener('click', () => setTool('rect'));

    function setTool(tool) {
        state.activeTool = tool;
        toolTextBtn.classList.toggle('active', tool === 'text');
        toolRectBtn.classList.toggle('active', tool === 'rect');
        textControls.classList.toggle('hidden', tool !== 'text');
        rectControls.classList.toggle('hidden', tool !== 'rect');
        textLayer.classList.toggle('drawing-rect', tool === 'rect');
    }

    // Click on textLayer to create new text box (only in text mode)
    textLayer.addEventListener('click', (e) => {
        if (state.activeTool !== 'text') return;
        if (e.target.closest('.text-overlay') || e.target.closest('.rect-overlay')) return;

        const rect = textLayer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const overlay = {
            x,
            y,
            text: '',
            fontSize: parseInt(fontSizeIn.value, 10) || 16,
            color: fontColorIn.value || '#000000',
            fontFamily: fontFamilyIn.value || 'Helvetica',
        };

        getOverlays(state.currentPage).push(overlay);
        const idx = getOverlays(state.currentPage).length - 1;
        const el = createOverlayElement(overlay, idx);
        focusTextContent(el);
    });

    // ---- Rectangle Drawing (mousedown → mousemove → mouseup) ----
    textLayer.addEventListener('mousedown', (e) => {
        if (state.activeTool !== 'rect') return;
        if (e.target.closest('.text-overlay') || e.target.closest('.rect-overlay')) return;

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
        };

        getRectOverlays(state.currentPage).push(overlay);
        renderAllOverlays();
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

        // Mousedown: start drag or select
        div.addEventListener('mousedown', (e) => {
            if (e.target === handle) return; // let delete button work
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

    // Update focused overlay when toolbar values change
    fontSizeIn.addEventListener('input', () => {
        const focused = textLayer.querySelector('.text-overlay-content:focus');
        if (focused) {
            const idx = parseInt(focused.dataset.index, 10);
            const val = parseInt(fontSizeIn.value, 10) || 16;
            getOverlays(state.currentPage)[idx].fontSize = val;
            focused.closest('.text-overlay').style.fontSize = val + 'px';
            focused.style.fontSize = val + 'px';
        }
    });

    fontColorIn.addEventListener('input', () => {
        const focused = textLayer.querySelector('.text-overlay-content:focus');
        if (focused) {
            const idx = parseInt(focused.dataset.index, 10);
            getOverlays(state.currentPage)[idx].color = fontColorIn.value;
            focused.closest('.text-overlay').style.color = fontColorIn.value;
        }
    });

    fontFamilyIn.addEventListener('change', () => {
        const focused = textLayer.querySelector('.text-overlay-content:focus');
        if (focused) {
            const idx = parseInt(focused.dataset.index, 10);
            getOverlays(state.currentPage)[idx].fontFamily = fontFamilyIn.value;
            focused.closest('.text-overlay').style.fontFamily = mapFont(fontFamilyIn.value);
        }
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
        } else {
            const overlays = getOverlays(state.currentPage);
            if (overlays.length) { overlays.pop(); renderAllOverlays(); }
        }
    });

    clearPageBtn.addEventListener('click', () => {
        state.textOverlays[state.currentPage] = [];
        state.rectOverlays[state.currentPage] = [];
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
        state.textOverlays = newText;
        state.rectOverlays = newRect;

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

            // ---- Draw rectangles first (behind text) ----
            for (const [pageNumStr, rects] of Object.entries(state.rectOverlays)) {
                const pageIdx = parseInt(pageNumStr, 10) - 1;
                if (pageIdx < 0 || pageIdx >= pages.length) continue;
                const page = pages[pageIdx];
                const { width: pageWidth, height: pageHeight } = page.getSize();
                const viewport = await getViewportForPage(pageNumStr);
                const canvasWidth = viewport.width;
                const canvasHeight = viewport.height;

                for (const ov of rects) {
                    const pdfX = (ov.x / canvasWidth) * pageWidth;
                    const pdfW = (ov.w / canvasWidth) * pageWidth;
                    const pdfH = (ov.h / canvasHeight) * pageHeight;
                    // Flip Y: top of rect in canvas → bottom-left origin in PDF
                    const pdfY = pageHeight - ((ov.y / canvasHeight) * pageHeight) - pdfH;

                    const rectOpts = { x: pdfX, y: pdfY, width: pdfW, height: pdfH };

                    // BUGFIX: fallbacks were both `0` here, but at creation
                    // time (mouseup handler) the defaults are 20 for fill and
                    // 100 for border. If an overlay somehow arrived missing
                    // these fields (e.g. legacy state, crash/restore), the
                    // saved PDF would render invisibly while the on-screen
                    // preview showed it at the UI defaults — a confusing
                    // "save loses my rectangle" bug. Keep the save-time
                    // fallbacks aligned with creation-time defaults.
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
                    } else {
                        rectOpts.color = rgb(1, 1, 1);
                        rectOpts.opacity = 0;
                    }

                    if (hasBorder) {
                        const border = parsePdfColor(ov.borderColor);
                        rectOpts.borderColor = rgb(border.r, border.g, border.b);
                        rectOpts.borderOpacity = borderOpacity / 100;
                        rectOpts.borderWidth = borderWidth / state.scale;
                    }

                    page.drawRectangle(rectOpts);
                }
            }

            // ---- Draw text overlays ----
            for (const [pageNumStr, overlays] of Object.entries(state.textOverlays)) {
                const pageIdx = parseInt(pageNumStr, 10) - 1;
                if (pageIdx < 0 || pageIdx >= pages.length) continue;
                const page = pages[pageIdx];
                const { width: pageWidth, height: pageHeight } = page.getSize();
                const viewport = await getViewportForPage(pageNumStr);
                const canvasWidth = viewport.width;
                const canvasHeight = viewport.height;

                for (const ov of overlays) {
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

    // ---- Rectangle Dragging (document-level) ----
    document.addEventListener('mousemove', (e) => {
        if (!state.draggingRect) return;

        const dr = state.draggingRect;
        const dx = e.clientX - dr.startX;
        const dy = e.clientY - dr.startY;

        if (!dr.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            dr.moved = true;
        }

        if (dr.moved) {
            const layerRect = textLayer.getBoundingClientRect();
            let newX = e.clientX - layerRect.left - dr.offsetX;
            let newY = e.clientY - layerRect.top - dr.offsetY;

            // Clamp within textLayer bounds
            const ov = getRectOverlays(state.currentPage)[dr.idx];
            newX = Math.max(0, Math.min(newX, layerRect.width - ov.w));
            newY = Math.max(0, Math.min(newY, layerRect.height - ov.h));

            dr.el.style.left = newX + 'px';
            dr.el.style.top = newY + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (!state.draggingRect) return;

        const dr = state.draggingRect;
        dr.el.classList.remove('dragging');

        if (dr.moved) {
            // Commit new position to state
            const ov = getRectOverlays(state.currentPage)[dr.idx];
            ov.x = parseFloat(dr.el.style.left);
            ov.y = parseFloat(dr.el.style.top);
        }

        state.draggingRect = null;
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
    });
})();
