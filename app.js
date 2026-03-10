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

    function hexToRgba(hex, opacityPercent) {
        const h = (hex || '#000000').replace('#', '');
        const r = parseInt(h.substring(0, 2), 16) || 0;
        const g = parseInt(h.substring(2, 4), 16) || 0;
        const b = parseInt(h.substring(4, 6), 16) || 0;
        const a = Math.max(0, Math.min(1, (opacityPercent != null ? opacityPercent : 0) / 100));
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
    }

    // ---- File Upload ----
    filePickerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
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
        const page = await state.pdfDoc.getPage(num);
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
        div.contentEditable = true;
        div.textContent = ov.text;
        div.style.left = ov.x + 'px';
        div.style.top = ov.y + 'px';
        div.style.fontSize = ov.fontSize + 'px';
        div.style.color = ov.color;
        div.style.fontFamily = mapFont(ov.fontFamily);
        div.dataset.index = idx;

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
        div.addEventListener('input', () => {
            getOverlays(state.currentPage)[idx].text = div.textContent;
        });

        // When focused, update toolbar controls to match this overlay
        div.addEventListener('focus', () => {
            fontSizeIn.value = ov.fontSize;
            fontColorIn.value = ov.color;
            fontFamilyIn.value = ov.fontFamily;
        });

        textLayer.appendChild(div);
        return div;
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
        if (e.target !== textLayer) return;

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
        el.focus();
    });

    // ---- Rectangle Drawing (mousedown → mousemove → mouseup) ----
    textLayer.addEventListener('mousedown', (e) => {
        if (state.activeTool !== 'rect') return;
        if (e.target !== textLayer) return;

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

    textLayer.addEventListener('mouseup', (e) => {
        if (!state.drawing || !state.drawStart) return;

        const rect = textLayer.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;

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
            fillColor: rectFillIn.value,
            fillOpacity: parseInt(rectFillOpacIn.value, 10),
            borderColor: rectBorderIn.value,
            borderOpacity: parseInt(rectBorderOpacIn.value, 10),
            borderWidth: parseFloat(rectBorderWidthIn.value) || 2,
        };

        getRectOverlays(state.currentPage).push(overlay);
        renderAllOverlays();
    });

    // ---- Rectangle Element Creation ----
    function applyRectStyles(div, ov) {
        div.style.backgroundColor = hexToRgba(ov.fillColor, ov.fillOpacity);
        div.style.borderStyle = 'solid';
        div.style.borderWidth = ov.borderWidth + 'px';
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
        ov.fillColor = rectFillIn.value;
        ov.fillOpacity = parseInt(rectFillOpacIn.value, 10);
        ov.borderColor = rectBorderIn.value;
        ov.borderOpacity = parseInt(rectBorderOpacIn.value, 10);
        ov.borderWidth = parseFloat(rectBorderWidthIn.value) || 2;
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
        const focused = textLayer.querySelector('.text-overlay:focus');
        if (focused) {
            const idx = parseInt(focused.dataset.index, 10);
            const val = parseInt(fontSizeIn.value, 10) || 16;
            getOverlays(state.currentPage)[idx].fontSize = val;
            focused.style.fontSize = val + 'px';
        }
    });

    fontColorIn.addEventListener('input', () => {
        const focused = textLayer.querySelector('.text-overlay:focus');
        if (focused) {
            const idx = parseInt(focused.dataset.index, 10);
            getOverlays(state.currentPage)[idx].color = fontColorIn.value;
            focused.style.color = fontColorIn.value;
        }
    });

    fontFamilyIn.addEventListener('change', () => {
        const focused = textLayer.querySelector('.text-overlay:focus');
        if (focused) {
            const idx = parseInt(focused.dataset.index, 10);
            getOverlays(state.currentPage)[idx].fontFamily = fontFamilyIn.value;
            focused.style.fontFamily = mapFont(fontFamilyIn.value);
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
                overlays[i].text = el.textContent.replace('\u00d7', '').trim();
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

    // ---- Save & Download ----
    saveBtn.addEventListener('click', async () => {
        saveCurrentOverlays();
        showLoading();

        try {
            const { PDFDocument, rgb, StandardFonts } = PDFLib;
            const pdfDoc = await PDFDocument.load(state.pdfBytes);
            const pages = pdfDoc.getPages();

            // Embed standard fonts
            const fonts = {
                Helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
                TimesRoman: await pdfDoc.embedFont(StandardFonts.TimesRoman),
                Courier: await pdfDoc.embedFont(StandardFonts.Courier),
            };

            // Helper: get viewport for a page
            async function getViewportForPage(pageNumStr) {
                const pdfPage = await state.pdfDoc.getPage(parseInt(pageNumStr, 10));
                return pdfPage.getViewport({ scale: state.scale });
            }

            function parseHex(hex) {
                const h = (hex || '#000000').replace('#', '');
                return {
                    r: (parseInt(h.substring(0, 2), 16) || 0) / 255,
                    g: (parseInt(h.substring(2, 4), 16) || 0) / 255,
                    b: (parseInt(h.substring(4, 6), 16) || 0) / 255,
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

                    const fill = parseHex(ov.fillColor);
                    const border = parseHex(ov.borderColor);

                    page.drawRectangle({
                        x: pdfX,
                        y: pdfY,
                        width: pdfW,
                        height: pdfH,
                        color: rgb(fill.r, fill.g, fill.b),
                        opacity: ov.fillOpacity / 100,
                        borderColor: rgb(border.r, border.g, border.b),
                        borderOpacity: ov.borderOpacity / 100,
                        borderWidth: ov.borderWidth / state.scale,
                    });
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
                    const c = parseHex(ov.color);

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
    document.addEventListener('keydown', (e) => {
        // Ctrl+Z to undo (only when not editing text)
        if (e.ctrlKey && e.key === 'z' && document.activeElement.tagName !== 'DIV') {
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
