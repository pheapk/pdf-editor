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
        // textOverlays[pageNum] = [ { x, y, text, fontSize, color, fontFamily } ]
        textOverlays: {},
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

    // ---- Helpers ----
    function showLoading() { loadingOverlay.classList.remove('hidden'); }
    function hideLoading() { loadingOverlay.classList.add('hidden'); }

    function getOverlays(page) {
        if (!state.textOverlays[page]) state.textOverlays[page] = [];
        return state.textOverlays[page];
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
        renderTextOverlays();
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
    function renderTextOverlays() {
        // Clear existing DOM overlays
        textLayer.innerHTML = '';

        const overlays = getOverlays(state.currentPage);
        overlays.forEach((ov, idx) => {
            createOverlayElement(ov, idx);
        });
    }

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
            renderTextOverlays();
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

    // Click on canvas/textLayer to create new text box
    textLayer.addEventListener('click', (e) => {
        // Don't create new box if clicking on existing overlay
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
        const overlays = getOverlays(state.currentPage);
        if (overlays.length) {
            overlays.pop();
            renderTextOverlays();
        }
    });

    clearPageBtn.addEventListener('click', () => {
        state.textOverlays[state.currentPage] = [];
        renderTextOverlays();
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

            // Process each page's overlays
            for (const [pageNumStr, overlays] of Object.entries(state.textOverlays)) {
                const pageIdx = parseInt(pageNumStr, 10) - 1;
                if (pageIdx < 0 || pageIdx >= pages.length) continue;
                const page = pages[pageIdx];
                const { width: pageWidth, height: pageHeight } = page.getSize();

                // We need to map from canvas coords to PDF coords.
                // Canvas size = PDF page size * scale
                // PDF origin is bottom-left; canvas origin is top-left.
                const pdfPage = await state.pdfDoc.getPage(parseInt(pageNumStr, 10));
                const viewport = pdfPage.getViewport({ scale: state.scale });
                const canvasWidth = viewport.width;
                const canvasHeight = viewport.height;

                for (const ov of overlays) {
                    const text = ov.text;
                    if (!text) continue;

                    // Convert canvas x,y to PDF x,y
                    const pdfX = (ov.x / canvasWidth) * pageWidth;
                    // Flip Y: canvas top-left → PDF bottom-left
                    // Approximate text height offset
                    const scaledFontSize = (ov.fontSize / state.scale);
                    const pdfY = pageHeight - ((ov.y / canvasHeight) * pageHeight) - scaledFontSize;

                    const font = fonts[ov.fontFamily] || fonts.Helvetica;

                    // Parse hex color to rgb
                    const hex = ov.color.replace('#', '');
                    const r = parseInt(hex.substring(0, 2), 16) / 255;
                    const g = parseInt(hex.substring(2, 4), 16) / 255;
                    const b = parseInt(hex.substring(4, 6), 16) / 255;

                    // Handle multi-line text
                    const lines = text.split('\n');
                    lines.forEach((line, lineIdx) => {
                        page.drawText(line, {
                            x: pdfX,
                            y: pdfY - (lineIdx * scaledFontSize * 1.2),
                            size: scaledFontSize,
                            font,
                            color: rgb(r, g, b),
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
