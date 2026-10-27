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

## Notes → cute PDF (second tab, `#notes`)

1. **Scan or pick** photos of handwritten notes (the camera button opens the phone camera), or just type.
2. The handwriting is read **on the device** with [Tesseract.js](https://tesseract.projectnaptha.com/) 5 (English + German). Photos are never uploaded; only the reader's code and language data are downloaded from jsDelivr the first time.
3. She fixes anything it misread in a small markdown editor: `# title`, `## heading`, `- bullet`, `1. number`, `[ ] to-do`, `> sticky note`, `**highlight**`.
4. She picks a paper (strawberry milk, lavender dream, peach blossom) and a handwriting font (Caveat, Gaegu, Patrick Hand). A live preview shows the A4 pages, with washi tape, doodles, a motivational sticker and a footer on each one.
5. Downloads:
   - **`<title> ♡.pdf`**, made with jsPDF
   - **`<title>_Notion.zip`**: the editable text plus the cute pages as `images/page-NN.jpg`, imported the same way as the slides zip

Neat print reads well. Cursive often needs fixing by hand, which is what the editor is for.

## Project layout

```
public/              ← the website (static, no build step)
  index.html
  css/style.css
  js/app.js          ← UI: upload, progress, results, download
  js/converter.js    ← the deterministic PDF → Notion converter
  js/notes.js        ← notes tab: on-device handwriting reading, cute pages, PDF + Notion zip
  vendor/            ← pdf.js 4.10 + JSZip 3.10 (self-hosted, no CDN needed)
                       (the notes tab loads tesseract.js 5.1.1 + jsPDF 2.5.2 from jsDelivr)
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
pdf.js: Apache-2.0 (see `public/vendor/PDFJS-LICENSE`). JSZip: MIT. Tesseract.js: Apache-2.0. jsPDF: MIT. Fonts: SIL Open Font License (Google Fonts).
