# arinais-stuborn ♡

Turn lecture slide PDFs into a page you can import into Notion, with the same wording and the same diagrams.
Everything runs in the browser: no AI, no server, and the PDF never leaves the visitor's device.

## What it does

1. **Upload** a PDF (drag & drop or file picker).
2. The converter reads every slide with [pdf.js](https://mozilla.github.io/pdf.js/):
   - text with fonts, sizes, colours and positions
   - vector shapes (boxes, ovals, arrows) and embedded images
3. **Template detection:** anything that repeats in the page margins on most pages (logo, author footer, page numbers) is ignored.
4. **Per slide:**
   - text outside graphics → real Markdown: `##` heading, bullets, sub-bullets, numbered lists, `→` lines and tables. Bold, red/coloured and underlined words become **bold**.
   - graphics (and the text inside them) → one cropped PNG, with logo and footer painted out.
   - vertical side notes ("Quelle: …") → a text line under the slide.
   - empty slides → `*(Folie N – leer)*`.
5. You get back **`<name>_Notion.zip`** containing `<name>.md` and an `images/` folder. In Notion, go to **Import → Markdown & CSV** and pick the zip.

## Project layout

```
public/              ← the website (static, no build step)
  index.html
  css/style.css
  js/app.js          ← UI: upload, progress, results, download
  js/converter.js    ← the deterministic PDF → Notion converter
  vendor/            ← pdf.js 4.10 + JSZip 3.10 (self-hosted, no CDN needed)
tests/
  harness.html       ← runs the converter on tests/…/sample.pdf
  run_harness.py     ← headless-Chrome test: python tests/run_harness.py slides.pdf out/
vercel.json          ← static hosting config (serves public/)
```

## Run locally

```bash
python3 -m http.server 8080 -d public
# open http://localhost:8080
```
(Any static file server works. Opening `index.html` straight from disk does **not** work, because ES modules and web workers need http.)

## Deploy to Vercel

**Option A: GitHub (recommended)**
1. Push this folder to a GitHub repo.
2. On vercel.com, click **Add New → Project**, then import the repo.
3. Leave everything on default. `vercel.json` already sets *Framework: Other* and *Output directory: public*, with no build command.
4. Click **Deploy**.

**Option B: Vercel CLI**
```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production
```

## Licences
pdf.js: Apache-2.0 (see `public/vendor/PDFJS-LICENSE`). JSZip: MIT.
