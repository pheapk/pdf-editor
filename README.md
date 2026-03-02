# PDF Editor

A simple web-based PDF editor. Upload a PDF, add text anywhere on the page, and download the modified file.

## Features

- Drag & drop or file picker PDF upload
- Click anywhere on a page to add text
- Font size, color, and family controls
- Multi-page navigation
- Undo and clear page actions
- Save & download with edits baked into the PDF
- Keyboard shortcuts: Ctrl+S (save), Ctrl+Z (undo)

## Run Locally

Clone the repo and serve with any static HTTP server:

```bash
git clone https://github.com/<your-username>/TestClaudeCode.git
cd TestClaudeCode
python3 -m http.server 8000
```

Then open http://localhost:8000.

> Opening `index.html` directly via `file://` won't work because PDF.js requires an HTTP server to load its web worker.

## GitHub Pages

This repo includes a GitHub Actions workflow that auto-deploys to GitHub Pages on push. To enable it:

1. Go to **Settings > Pages**
2. Set **Source** to **GitHub Actions**
3. Push to the branch and the site will deploy automatically

## Tech Stack

- [PDF.js](https://mozilla.github.io/pdf.js/) - PDF rendering (via CDN)
- [pdf-lib](https://pdf-lib.js.org/) - PDF modification (via CDN)
- Vanilla HTML/CSS/JavaScript - no build step required
