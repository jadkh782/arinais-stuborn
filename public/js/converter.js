// arinais-stuborn — deterministic slide-PDF → Notion converter.
// No AI, no server: everything runs in the browser with pdf.js + JSZip.
//
// Pipeline
//   1. analyse every page: text items, vector shapes, images (via pdf.js operator list)
//   2. detect the slide template (logo, footer, page numbers) = elements repeated on most pages
//   3. per slide: text outside graphics -> real Markdown; graphics (+ text inside them) -> cropped PNG
//   4. write one Markdown file + images/ and zip it for Notion's "Markdown & CSV" import

import * as pdfjs from '../vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const { OPS, Util } = pdfjs;

// ---------- small geometry helpers ----------
const box = (x0, y0, x1, y1) => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const union = (a, b) => (a ? box(Math.min(a.x0, b.x0), Math.min(a.y0, b.y0), Math.max(a.x1, b.x1), Math.max(a.y1, b.y1)) : { ...b });
const expand = (b, d) => box(b.x0 - d, b.y0 - d, b.x1 + d, b.y1 + d);
const intersects = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const contains = (outer, x, y) => x >= outer.x0 && x <= outer.x1 && y >= outer.y0 && y <= outer.y1;
const center = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];

function transformBox(m, b) {
  const pts = [
    Util.applyTransform([b[0], b[1]], m),
    Util.applyTransform([b[2], b[1]], m),
    Util.applyTransform([b[0], b[3]], m),
    Util.applyTransform([b[2], b[3]], m),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

// bounding box of a constructPath op, computed from the points themselves
// (pdf.js' own minMax ignores curve segments)
function pathBounds(args) {
  if (!args) return null;
  const [ops, coords, mm] = args;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  if (ops && coords) {
    let j = 0;
    for (const op of ops) {
      if (op === OPS.rectangle) { const [x, y, w, h] = [coords[j], coords[j + 1], coords[j + 2], coords[j + 3]]; add(x, y); add(x + w, y + h); j += 4; }
      else if (op === OPS.moveTo || op === OPS.lineTo) { add(coords[j], coords[j + 1]); j += 2; }
      else if (op === OPS.curveTo) { for (let k = 0; k < 6; k += 2) add(coords[j + k], coords[j + k + 1]); j += 6; }
      else if (op === OPS.curveTo2 || op === OPS.curveTo3) { for (let k = 0; k < 4; k += 2) add(coords[j + k], coords[j + k + 1]); j += 4; }
    }
  }
  if (!isFinite(x0) && mm && mm.length >= 4 && isFinite(mm[0])) return [mm[0], mm[1], mm[2], mm[3]];
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}

const toRGB =(a) => (a && a.length >= 3 ? [a[0], a[1], a[2]] : typeof a === 'string' ? hexToRgb(a) : [0, 0, 0]);
function hexToRgb(h) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(h || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}
const nearWhite = (c) => c[0] > 244 && c[1] > 244 && c[2] > 244;

// Symbol / Wingdings private-use glyphs that PowerPoint uses for bullets and arrows
const PUA_MAP = {
  '': '•', '': '•', '': '▪', '': '▪', '': '▪', '': '▪', '': '◆', '': '❖',
  '': '→', '': '→', '': '→', '': '→', '': '→', '': '→', '': '→', '': '→',
  '': '✓', '': '☑', '': '–', '': '—',
};
const cleanStr = (s) => s.replace(/[-]/g, (c) => PUA_MAP[c] ?? '•').replace(/ /g, ' ');

const BULLETS = '•▪●◦‣∙·■□◆❖✓☑►▸';
const DASHES = '–−-‒—';
const ARROWS = '→⇒➔➜➝➞➢';

// ---------- 1. page analysis ----------
async function analysePage(page, index) {
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width;
  const H = vp.height;
  const ol = await page.getOperatorList();
  const tc = await page.getTextContent();

  // walk the operator list keeping track of the transform matrix and colours
  let ctm = [1, 0, 0, 1, 0, 0];
  let fill = [0, 0, 0];
  let stroke = [0, 0, 0];
  const stack = [];
  const shapes = [];
  const images = [];
  let pending = null;

  const paintOps = new Map([
    [OPS.fill, 'f'], [OPS.eoFill, 'f'],
    [OPS.stroke, 's'], [OPS.closeStroke, 's'],
    [OPS.fillStroke, 'fs'], [OPS.eoFillStroke, 'fs'], [OPS.closeFillStroke, 'fs'], [OPS.closeEOFillStroke, 'fs'],
  ]);
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask].filter((x) => x !== undefined));

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, fill, stroke]);
    else if (fn === OPS.restore) { if (stack.length) [ctm, fill, stroke] = stack.pop(); }
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push([ctm, fill, stroke]);
      if (args && args[0]) ctm = Util.transform(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) [ctm, fill, stroke] = stack.pop(); }
    else if (fn === OPS.setFillRGBColor) fill = toRGB(args);
    else if (fn === OPS.setStrokeRGBColor) stroke = toRGB(args);
    else if (fn === OPS.constructPath) {
      const mm = pathBounds(args);
      pending = mm ? transformBox(Util.transform(vp.transform, ctm), mm) : null;
    } else if (fn === OPS.endPath) pending = null; // clipping path, nothing visible
    else if (paintOps.has(fn)) {
      if (pending) shapes.push({ b: pending, kind: paintOps.get(fn), fill: [...fill], stroke: [...stroke] });
      pending = null;
    } else if (imageOps.has(fn)) {
      const b = transformBox(Util.transform(vp.transform, ctm), [0, 0, 1, 1]);
      if (area(b) > 4) images.push({ b });
    }
  }

  // text items -> viewport coordinates
  const texts = [];
  let spaceNext = false;
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) {
      spaceNext = !!it.str && !it.hasEOL;
      if (it.hasEOL) spaceNext = false;
      continue;
    }
    const m = Util.transform(vp.transform, it.transform);
    const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
    const rot = Math.atan2(m[1], m[0]) * 180 / Math.PI; // 0 = horizontal
    let fontName = '';
    try { fontName = page.commonObjs.get(it.fontName)?.name || ''; } catch { /* font not loaded */ }
    const style = tc.styles[it.fontName] || {};
    const bold = /bold|black|heavy|semibold|demi/i.test(fontName) || /bold/i.test(style.fontFamily || '');
    const courier = /courier/i.test(fontName);
    const w = it.width;
    let b;
    if (Math.abs(rot) < 1) b = box(m[4], m[5] - size * 0.82, m[4] + w, m[5] + size * 0.22);
    else b = transformBox(Util.transform(vp.transform, it.transform), [0, -0.22, w / (Math.hypot(it.transform[0], it.transform[1]) || 1), 0.82]);
    texts.push({
      str: cleanStr(it.str), x: m[4], base: m[5], size, w, rot, bold, courier, b,
      order: texts.length, tx: it.transform, spaceBefore: spaceNext,
    });
    spaceNext = false;
  }

  return { index, W, H, shapes, images, texts, page };
}

// ---------- 2. template detection ----------
const keyOf = (b) => `${Math.round(b.x0 / 3)}|${Math.round(b.y0 / 3)}|${Math.round(b.x1 / 3)}|${Math.round(b.y1 / 3)}`;

function detectTemplate(pages) {
  const n = pages.length;
  const need = Math.max(2, Math.ceil(n * 0.5));
  const count = (getItems, keyFn) => {
    const c = new Map();
    for (const p of pages) {
      const seen = new Set(getItems(p).map(keyFn));
      for (const k of seen) c.set(k, (c.get(k) || 0) + 1);
    }
    return c;
  };
  const shapeCount = count((p) => p.shapes, (s) => 's' + keyOf(s.b));
  const imageCount = count((p) => p.images, (s) => 'i' + keyOf(s.b));
  const textCount = count((p) => p.texts, (t) => 't' + t.str + '|' + Math.round(t.x / 4) + '|' + Math.round(t.base / 4));

  for (const p of pages) {
    const bandTop = p.H * 0.09;
    const bandBottom = p.H * 0.88;
    // template elements (logo, footer, page numbers) live in the page margins
    const atEdge = (b) => b.y1 <= p.H * 0.16 || b.y0 >= p.H * 0.84 || b.x1 <= p.W * 0.1 || b.x0 >= p.W * 0.9;
    const enough = n >= 3;
    for (const s of p.shapes) s.template = enough && atEdge(s.b) && shapeCount.get('s' + keyOf(s.b)) >= need;
    for (const s of p.images) s.template = enough && atEdge(s.b) && imageCount.get('i' + keyOf(s.b)) >= need;
    for (const t of p.texts) {
      const repeated = enough && atEdge(t.b) && textCount.get('t' + t.str + '|' + Math.round(t.x / 4) + '|' + Math.round(t.base / 4)) >= need;
      const pageNo = /^\s*\d{1,4}\s*$/.test(t.str) && (t.b.y0 > bandBottom || t.b.y1 < bandTop) && Math.abs(t.rot) < 1;
      t.template = repeated || pageNo;
    }
  }
}

// ---------- 3. colour sampling (for red / coloured highlight text) ----------
async function renderPage(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, ctx, scale };
}

function sampleTextColour(img, t) {
  const { ctx, scale } = img;
  const x0 = Math.max(0, Math.floor(t.b.x0 * scale));
  const y0 = Math.max(0, Math.floor(t.b.y0 * scale));
  const w = Math.max(1, Math.min(ctx.canvas.width - x0, Math.ceil((t.b.x1 - t.b.x0) * scale)));
  const h = Math.max(1, Math.min(ctx.canvas.height - y0, Math.ceil((t.b.y1 - t.b.y0) * scale)));
  const d = ctx.getImageData(x0, y0, w, h).data;
  // background = most common colour in the box
  const hist = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let bgKey = 0; let best = -1;
  for (const [k, v] of hist) if (v > best) { best = v; bgKey = k; }
  const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8];
  let ink = 0; let colored = 0; let r = 0; let g = 0; let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
    if (diff < 120) continue;
    ink++;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx - mn > 90) { colored++; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  }
  if (!ink || colored / ink < 0.45) return null;
  return [r / colored, g / colored, b / colored];
}

// ---------- 4. lines, blocks & markdown ----------
function buildLines(texts) {
  const items = texts.slice().sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const t of items) {
    let line = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
      const L = lines[i];
      if (Math.abs(L.base - t.base) <= Math.max(L.size, t.size) * 0.38) { line = L; break; }
    }
    if (!line) { line = { base: t.base, size: t.size, items: [] }; lines.push(line); }
    line.items.push(t);
    if (t.size > line.size) { line.size = t.size; line.base = t.base; }
  }
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    L.b = L.items.reduce((acc, t) => union(acc, t.b), null);
    L.x = L.b.x0;
  }
  lines.sort((a, b) => a.b.y0 - b.b.y0 || a.x - b.x);
  return lines;
}

// split a line into cells where there is a big horizontal gap
function cellsOf(L) {
  const cells = [];
  let cur = null;
  for (const t of L.items) {
    if (cur && t.x - cur.b.x1 > L.size * 1.6) { cells.push(cur); cur = null; }
    if (!cur) cur = { items: [], b: null };
    cur.items.push(t);
    cur.b = union(cur.b, t.b);
  }
  if (cur) cells.push(cur);
  return cells;
}

// assign the items of a line to existing table columns (by x position)
function splitByCols(L, starts) {
  const cells = starts.map(() => ({ items: [], b: null }));
  // a single text item can span two columns when the PDF used a wide space instead of a tab
  const items = [];
  for (const t of L.items) {
    let cur = t;
    for (const st of starts) {
      if (!(cur.x < st - 10 && cur.x + cur.w > st + 10 && cur.str.includes(' '))) continue;
      const cw = cur.w / cur.str.length;
      let best = -1; let bestD = Infinity;
      for (let k = 0; k < cur.str.length; k++) {
        if (cur.str[k] !== ' ') continue;
        const d = Math.abs(cur.x + (k + 1) * cw - st);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0 || bestD > L.size * 2) continue;
      const left = cur.str.slice(0, best).trimEnd();
      const right = cur.str.slice(best + 1).trimStart();
      const lw = left.length * cw;
      items.push({ ...cur, str: left, w: lw, b: box(cur.x, cur.b.y0, cur.x + lw, cur.b.y1) });
      const rx = Math.max(st, cur.x + cur.w - right.length * cw);
      cur = { ...cur, str: right, x: rx, w: cur.x + cur.w - rx, b: box(rx, cur.b.y0, cur.x + cur.w, cur.b.y1), spaceBefore: true };
    }
    items.push(cur);
  }
  for (const t of items) {
    let k = 0;
    for (let c = 0; c < starts.length; c++) if (t.x >= starts[c] - 10) k = c;
    cells[k].items.push(t);
    cells[k].b = union(cells[k].b, t.b);
  }
  if (cells.some((c) => !c.items.length)) return null;
  if (Math.abs(cells[0].b.x0 - starts[0]) > 14) return null;
  // the gap before each column must be a real gap, not the middle of a sentence
  for (let c = 1; c < cells.length; c++) if (cells[c].b.x0 - cells[c - 1].b.x1 < L.size * 0.55) return null;
  return cells;
}

const isEmph = (t) => t.bold || t.accent || t.underline;
const isUrl = (s) => /^https?:\/\//i.test(s.trim());

// turn a list of text items into inline markdown (bold runs for bold / coloured / underlined text)
function inlineMd(items, { plain = false } = {}) {
  const runs = [];
  let prev = null;
  for (const t of items) {
    let s = t.str;
    if (prev) {
      const gap = t.x - (prev.x + prev.w);
      if ((gap > t.size * 0.18 || (t.spaceBefore && gap > -t.size * 0.1)) && !/\s$/.test(prev.str) && !/^\s/.test(s)) s = ' ' + s;
    }
    const emph = !plain && isEmph(t) && !t.link;
    const last = runs[runs.length - 1];
    if (last && last.emph === emph) last.text += s;
    else runs.push({ emph, text: s });
    prev = t;
  }
  let out = '';
  for (const r of runs) {
    if (!r.emph || !r.text.trim()) { out += r.text; continue; }
    const lead = r.text.match(/^\s*/)[0];
    const trail = r.text.match(/\s*$/)[0];
    const core = r.text.trim().replace(/\*/g, '\\*');
    out += `${lead}**${core}**${trail}`;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

function plainText(items) {
  return inlineMd(items, { plain: true });
}

function escapeBlockStart(s) {
  return s
    .replace(/^([+\-*]) /, '\\$1 ')
    .replace(/^(#{1,6}) /, '\\$1 ')
    .replace(/^>/, '\\>')
    .replace(/^(\d+)\. /, '$1\\. ');
}

// classify the start of a line: bullet / sub-bullet / numbered / arrow / plain
function markerOf(L) {
  const first = L.items[0];
  const s = first.str.trimStart();
  const ch = s[0];
  const restItems = (skip) => {
    // remove `skip` characters from the beginning of the line
    const items = L.items.map((t) => ({ ...t }));
    let left = skip;
    while (left > 0 && items.length) {
      const t = items[0];
      const trimmed = t.str.replace(/^\s+/, '');
      if (trimmed.length <= left) { left -= trimmed.length; items.shift(); }
      else { t.str = trimmed.slice(left); left = 0; }
    }
    if (items.length) items[0].str = items[0].str.replace(/^\s+/, '');
    return items.filter((t) => t.str.length);
  };
  if (BULLETS.includes(ch) || (first.courier && s.trim() === 'o')) return { type: 'bullet', items: restItems(1), textX: L.items[1]?.x ?? L.x };
  if (DASHES.includes(ch) && (s.length === 1 || s[1] === ' ' || s[1] === '\t')) return { type: 'dash', items: restItems(1), textX: L.items[1]?.x ?? L.x };
  if (ARROWS.includes(ch)) return { type: 'arrow', items: restItems(1), textX: s.length === 1 ? L.items[1]?.x : L.x + first.size };
  const num = /^(\d{1,2}|[a-z])[.)](\s|$)/.exec(s);
  if (num && (L.items.length > 1 || s.length > num[0].length)) {
    return { type: 'number', n: num[1], items: restItems(num[1].length + 1), textX: L.items[1]?.x ?? L.x };
  }
  return { type: 'plain', items: L.items };
}

function linesToMarkdown(lines, ctx) {
  const blocks = []; // {kind, md}
  if (!lines.length) return blocks;
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)];
  const W = ctx.W;
  const maxRight = Math.min(W * 0.95, Math.max(...lines.map((l) => l.b.x1)));

  // --- tables: a line with ≥2 cells (big gaps) followed by lines that split into the same columns
  const used = new Set();
  const tableAt = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i) || markerOf(lines[i]).type !== 'plain') continue;
    const c0 = cellsOf(lines[i]);
    if (c0.length < 2 || /^[\d.)\s]+$/.test(plainText(c0[0].items))) continue;
    const starts = c0.map((c) => c.b.x0);
    const rows = [c0];
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j].b.y0 - lines[j - 1].b.y1 > lines[j].size * 1.6) break;
      if (Math.abs(lines[j].size - lines[i].size) > 1.5) break;
      const cj = splitByCols(lines[j], starts);
      if (!cj) break;
      rows.push(cj); j++;
    }
    if (rows.length >= 2) {
      for (let k = i; k < j; k++) used.add(k);
      tableAt.set(i, rows);
    }
  }

  let prev = null; // previous emitted paragraph-ish line for wrap merging
  let headingDone = ctx.headingAllowed === false;
  let listOpen = null;
  let firstBulletX = null;

  for (let i = 0; i < lines.length; i++) {
    if (tableAt.has(i)) {
      const rows = tableAt.get(i);
      const cols = rows[0].length;
      const rightAlign = [];
      for (let k = 0; k < cols; k++) {
        const ends = rows.map((r) => r[k].b.x1);
        const starts = rows.map((r) => r[k].b.x0);
        const spreadEnd = Math.max(...ends) - Math.min(...ends);
        const spreadStart = Math.max(...starts) - Math.min(...starts);
        rightAlign.push(k > 0 && spreadEnd + 1 < spreadStart && rows.some((r) => /\d/.test(plainText(r[k].items))));
      }
      const fmt = (r) => '| ' + r.map((c) => inlineMd(c.items).replace(/\|/g, '\\|')).join(' | ') + ' |';
      const md = [fmt(rows[0]), '|' + rightAlign.map((r) => (r ? '---:' : '---')).join('|') + '|', ...rows.slice(1).map(fmt)].join('\n');
      blocks.push({ kind: 'table', md });
      prev = null; listOpen = null;
      i += rows.length - 1;
      continue;
    }
    if (used.has(i)) continue;
    const L = lines[i];
    const mk = markerOf(L);

    // wrapped continuation of the previous line?
    if (prev && mk.type === 'plain') {
      const P = prev.line;
      const gap = L.base - P.base;
      const sameSize = Math.abs(L.size - P.size) < 1.2;
      const fw = L.items[0].str.trim().split(/\s+/)[0] || '';
      const firstWordW = L.items[0].w * (fw.length / Math.max(1, L.items[0].str.length));
      const longPrev = P.b.x1 > W * 0.68 || P.b.x1 + firstWordW + L.size * 0.3 > maxRight - L.size;
      const alignedStart = L.x >= (prev.textX ?? P.x) - 4 && L.x <= (prev.textX ?? P.x) + L.size * 1.5;
      if (sameSize && longPrev && gap > 0 && gap <= L.size * 1.75 && alignedStart) {
        const joinItems = L.items.map((t, k) => (k === 0 ? { ...t, x: Infinity } : t));
        const sep = /-$/.test(prev.block.raw) && /^[a-zäöü]/.test(L.items[0].str) ? '' : ' ';
        prev.block.raw += sep + plainText(L.items);
        prev.block.md += sep + inlineMd(joinItems);
        prev.line = L;
        continue;
      }
    }

    const content = inlineMd(mk.items);
    const raw = plainText(mk.items);
    const allBold = L.items.every((t) => isEmph(t));
    let block;

    if (!headingDone && mk.type === 'plain' && (allBold || L.size >= bodySize * 1.25) && raw.length <= 140) {
      block = { kind: 'heading', md: `## ${raw}`, raw };
      headingDone = true;
      blocks.push(block);
      prev = null; listOpen = null;
      continue;
    }
    headingDone = true;

    if (mk.type === 'plain' && L.size >= bodySize * 1.2 && allBold && raw.length <= 100) {
      block = { kind: 'heading3', md: `### ${raw}`, raw };
      blocks.push(block); prev = null; listOpen = null; continue;
    }

    if (mk.type === 'bullet' || mk.type === 'dash') {
      if (firstBulletX === null || (!listOpen && mk.type === 'bullet')) firstBulletX = L.x;
      const nested = mk.type === 'dash' ? (listOpen ? 1 : 0) : (L.x > firstBulletX + 12 ? 1 : 0);
      block = { kind: 'list', md: `${'    '.repeat(nested)}- ${content}`, raw };
      listOpen = 'bullet';
    } else if (mk.type === 'number') {
      const isList = listOpen === 'number' || mk.n === '1' || mk.n === 'a';
      block = isList
        ? { kind: 'list', md: `${/\d/.test(mk.n) ? mk.n : '1'}. ${content}`, raw }
        : { kind: 'p', md: `${mk.n}\\. ${content}`, raw };
      listOpen = isList ? 'number' : null;
    } else if (mk.type === 'arrow') {
      block = { kind: 'p', md: `→ ${content}`, raw };
      listOpen = null;
    } else {
      const itemTextX = prev?.textX ?? Infinity;
      const looksBullet = listOpen && prev?.block?.kind === 'list' && L.x >= itemTextX - 4 && L.x <= itemTextX + L.size
        && L.base - prev.line.base <= L.size * 1.75;
      if (looksBullet) {
        // continuation text of a list item that wasn't long enough to be detected as a wrap
        prev.block.md += ' ' + content; prev.block.raw += ' ' + raw; prev.line = L; continue;
      }
      block = { kind: 'p', md: escapeBlockStart(content), raw };
      listOpen = null;
    }
    blocks.push(block);
    prev = { block, line: L, textX: mk.textX };
  }
  return blocks;
}

function joinBlocks(blocks) {
  let out = '';
  let prevKind = null;
  for (const b of blocks) {
    if (out) out += b.kind === 'list' && prevKind === 'list' ? '\n' : '\n\n';
    out += b.md;
    prevKind = b.kind;
  }
  return out;
}

// ---------- 5. per-slide layout ----------
function layoutSlide(p) {
  const { W, H } = p;
  const pageArea = W * H;

  const texts = p.texts.filter((t) => !t.template);
  const horiz = texts.filter((t) => Math.abs(t.rot) < 1);
  const vertical = texts.filter((t) => Math.abs(Math.abs(t.rot) - 90) < 2);
  const diagonal = texts.filter((t) => Math.abs(t.rot) >= 1 && Math.abs(Math.abs(t.rot) - 90) >= 2);
  const diagBoxes = diagonal.map((t) => expand(t.b, t.size));

  // background rectangles (big filled areas) are not graphics
  const backgrounds = [];
  const graphics = [];
  for (const s of p.shapes) {
    if (s.template) continue;
    const a = area(s.b);
    const thin = s.b.x1 - s.b.x0 < 2.6 || s.b.y1 - s.b.y0 < 2.6;
    if (a >= pageArea * 0.4 && s.kind === 'f') { backgrounds.push(s); continue; }
    if (s.kind === 'f' && nearWhite(s.fill)) continue; // invisible white fill
    if (thin) {
      // thin horizontal line just under a text item = underline (can cover only part of the item)
      if (s.b.y1 - s.b.y0 < 2.6) {
        for (const t of horiz) {
          const under = s.b.y0 >= t.base - 1 && s.b.y0 <= t.base + t.size * 0.35;
          const overlap = Math.min(s.b.x1, t.b.x1) - Math.max(s.b.x0, t.b.x0);
          if (under && overlap > t.size * 0.8 && (s.b.x1 - s.b.x0) < (t.b.x1 - t.b.x0) * 1.4 + t.size) {
            (t.ul ||= []).push([Math.max(s.b.x0, t.b.x0), Math.min(s.b.x1, t.b.x1)]);
          }
        }
      }
      continue;
    }
    const [cx, cy] = center(s.b);
    if (diagBoxes.some((d) => contains(d, cx, cy))) continue; // sticker behind diagonal text
    if (a < 30) continue;
    graphics.push(s.b);
  }
  for (const im of p.images) if (!im.template && area(im.b) > 150) graphics.push(im.b);

  const lines = buildLines(splitUnderlined(horiz));
  let region = null;
  for (const g of graphics) region = union(region, g);

  const above = [];
  const inside = [];
  const below = [];
  if (!region) above.push(...lines);
  else {
    for (const L of lines) {
      const [cx, cy] = center(L.b);
      const inShape = graphics.some((g) => contains(expand(g, 2), cx, cy));
      if (inShape || (cy >= region.y0 && cy <= region.y1)) inside.push(L);
      else if (cy < region.y0) above.push(L);
      else below.push(L);
    }
    // a small graphic beside the text with no text of its own (sticker, icon, logo-ish) -> keep text flow, image after
    const xOverlap = (L) => L.b.x0 < region.x1 - 2 && region.x0 + 2 < L.b.x1;
    if (!inside.length && (area(region) < pageArea * 0.06 || (area(region) < pageArea * 0.15 && !lines.some(xOverlap)))) {
      above.length = 0; below.length = 0;
      above.push(...lines);
    }
    for (const L of inside) region = union(region, L.b);
  }

  // side notes (vertical text, e.g. "Quelle: …") read bottom-to-top or top-to-bottom
  const noteGroups = [];
  if (vertical.length) {
    const byCol = new Map();
    for (const t of vertical) {
      const k = Math.round(t.b.x0 / 6);
      if (!byCol.has(k)) byCol.set(k, []);
      byCol.get(k).push(t);
    }
    for (const items of byCol.values()) {
      const up = items[0].rot < 0; // text running bottom→top in viewport coords
      items.sort((a, b) => (up ? b.b.y1 - a.b.y1 : a.b.y0 - b.b.y0));
      let s = '';
      let prevEnd = null;
      for (const t of items) {
        const start = up ? t.b.y1 : t.b.y0;
        const gap = prevEnd === null ? 0 : (up ? prevEnd - start : start - prevEnd);
        if (s && gap > t.size * 0.18 && !/\s$/.test(s) && !/^\s/.test(t.str)) s += ' ';
        s += t.str;
        prevEnd = up ? t.b.y0 : t.b.y1;
      }
      noteGroups.push(s.replace(/\s+/g, ' ').trim());
    }
  }
  const stickers = [];
  if (diagonal.length) {
    const items = diagonal.slice().sort((a, b) => a.order - b.order);
    stickers.push(items.map((t) => t.str).join('').replace(/\s+/g, ' ').trim());
  }

  return { lines, above, inside, below, region, graphics, backgrounds, notes: noteGroups, stickers, horiz };
}

// split text items whose underline covers only some words
function splitUnderlined(items) {
  const out = [];
  for (const t of items) {
    if (!t.ul) { out.push(t); continue; }
    const n = t.str.length;
    const cw = t.w / Math.max(1, n);
    let marks = new Array(n).fill(false);
    for (const [u0, u1] of t.ul) {
      const a = Math.max(0, Math.round((u0 - t.x) / cw));
      const b = Math.min(n, Math.round((u1 - t.x) / cw));
      for (let k = a; k < b; k++) marks[k] = true;
    }
    // snap to whole words
    const words = [...t.str.matchAll(/\S+/g)];
    marks = new Array(n).fill(false);
    for (const w of words) {
      const a = w.index; const b = a + w[0].length;
      let cov = 0;
      for (const [u0, u1] of t.ul) {
        const wx0 = t.x + a * cw; const wx1 = t.x + b * cw;
        cov += Math.max(0, Math.min(u1, wx1) - Math.max(u0, wx0));
      }
      if (cov >= (b - a) * cw * 0.5) for (let k = a; k < b; k++) marks[k] = true;
    }
    // make spaces between underlined words underlined too
    for (let k = 1; k < n - 1; k++) if (t.str[k] === ' ' && marks[k - 1] && marks[k + 1]) marks[k] = true;
    let start = 0;
    for (let k = 1; k <= n; k++) {
      if (k === n || marks[k] !== marks[start]) {
        const str = t.str.slice(start, k);
        if (str.length) {
          const x = t.x + start * cw; const w = str.length * cw;
          out.push({ ...t, str, x, w, b: box(x, t.b.y0, x + w, t.b.y1), underline: marks[start], ul: undefined, spaceBefore: start === 0 ? t.spaceBefore : false });
        }
        start = k;
      }
    }
  }
  return out;
}

function headingFromGraphic(insideLines) {
  if (!insideLines.length) return '';
  const sizes = insideLines.map((l) => l.size);
  const max = Math.max(...sizes);
  const second = Math.max(...sizes.filter((s) => s < max - 0.6), 0);
  const ordered = insideLines.slice().sort((a, b) => a.b.y0 - b.b.y0 || a.x - b.x);
  if (second && max - second >= 1.5) {
    const L = ordered.find((l) => l.size === max);
    const cells = cellsOf(L);
    if (cells.length === 1) return plainText(L.items);
  }
  for (const L of ordered) {
    if (cellsOf(L).length === 1 && L.items.every((t) => t.bold || t.accent)) {
      const s = plainText(L.items);
      if (s.length <= 90 && s.length > 1) return s;
    }
  }
  return '';
}

async function cropRegion(p, region, layout, scale) {
  const pad = 10;
  const r = box(Math.max(0, region.x0 - pad), Math.max(0, region.y0 - pad), Math.min(p.W, region.x1 + pad), Math.min(p.H, region.y1 + pad));
  const img = await renderPage(p.page, scale);
  const sx = Math.floor(r.x0 * scale);
  const sy = Math.floor(r.y0 * scale);
  const sw = Math.ceil((r.x1 - r.x0) * scale);
  const sh = Math.ceil((r.y1 - r.y0) * scale);
  // paint over template bits (logo, footer) that ended up inside the crop
  const tmpl = [
    ...p.shapes.filter((s) => s.template).map((s) => s.b),
    ...p.images.filter((s) => s.template).map((s) => s.b),
    ...p.texts.filter((t) => t.template).map((t) => t.b),
    ...p.texts.filter((t) => !t.template && Math.abs(Math.abs(t.rot) - 90) < 2).map((t) => t.b),
  ].filter((b) => area(b) < p.W * p.H * 0.4 && intersects(b, r) && !layout.graphics.some((g) => intersects(expand(b, -1), g)));
  for (const b of tmpl) {
    const ex = expand(b, 2);
    const px = Math.max(0, Math.floor(ex.x0 * scale) - 3);
    const py = Math.max(0, Math.floor(ex.y0 * scale));
    const c = img.ctx.getImageData(px, py, 1, 1).data;
    img.ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    img.ctx.fillRect(Math.floor(ex.x0 * scale), Math.floor(ex.y0 * scale), Math.ceil((ex.x1 - ex.x0) * scale), Math.ceil((ex.y1 - ex.y0) * scale));
  }
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(img.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  const thumb = out.toDataURL('image/png', 0.6);
  img.canvas.width = img.canvas.height = 0;
  return { blob, thumb, w: sw, h: sh };
}

function detectGerman(pages) {
  const all = pages.flatMap((p) => p.texts.map((t) => t.str)).join(' ');
  const de = (all.match(/\b(und|der|die|das|nicht|mit|für|ist|eine?|werden|von)\b|[äöüß]/gi) || []).length;
  const en = (all.match(/\b(the|and|of|is|are|for|with|this|that|from)\b/gi) || []).length;
  return de > en;
}

function titleFromFile(name) {
  return name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Slides';
}

const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Slides';

// ---------- public API ----------
export async function convertPdf(file, onProgress = () => {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const n = doc.numPages;
  const pages = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    pages.push(await analysePage(page, i));
    onProgress({ phase: 'read', done: i, total: n });
  }
  detectTemplate(pages);
  const german = detectGerman(pages);
  const L = german
    ? { slide: 'Folie', empty: 'leer', img: 'folie' }
    : { slide: 'Slide', empty: 'empty', img: 'slide' };
  const pad = String(n).length < 2 ? 2 : String(n).length;

  const title = titleFromFile(file.name);
  const sections = [];
  const images = [];
  const slidesInfo = [];

  for (const p of pages) {
    const lay = layoutSlide(p);
    // colour sampling for the native text
    const nativeLines = [...lay.above, ...lay.below, ...(lay.region ? lay.inside : [])];
    if (nativeLines.length) {
      const img = await renderPage(p.page, 1.5);
      for (const Ln of nativeLines) {
        for (const t of Ln.items) {
          const c = sampleTextColour(img, t);
          if (c) {
            const blueish = c[2] > c[0] + 40 && c[2] > c[1] + 20;
            if (blueish && isUrl(t.str)) t.link = true;
            else t.accent = true;
          }
        }
      }
      img.canvas.width = img.canvas.height = 0;
    }

    const num = String(p.index).padStart(pad, '0');
    let md = '';
    let type;
    const parts = [];
    if (!lay.region) {
      const blocks = linesToMarkdown(lay.above, { W: p.W, headingAllowed: true });
      if (blocks.length) { parts.push(joinBlocks(blocks)); type = 'text'; }
      else type = 'empty';
    } else {
      const top = linesToMarkdown(lay.above, { W: p.W, headingAllowed: true });
      let heading = top.find((b) => b.kind === 'heading');
      if (top.length) parts.push(joinBlocks(top));
      let alt = heading ? heading.raw : headingFromGraphic(lay.inside);
      if (!top.length && alt) parts.push(`## ${alt}`);
      const crop = await cropRegion(p, lay.region, lay, 2);
      const fname = `${L.img}-${num}.png`;
      images.push({ name: fname, blob: crop.blob });
      parts.push(`![${(alt || `${L.slide} ${p.index}`).replace(/[[\]]/g, '')}](images/${fname})`);
      const bottom = linesToMarkdown(lay.below, { W: p.W, headingAllowed: !top.length && !alt });
      if (bottom.length) parts.push(joinBlocks(bottom));
      type = top.length || bottom.length ? 'mixed' : 'graphic';
      slidesInfo.push({ index: p.index, type, thumb: crop.thumb });
    }
    if (type === 'empty') parts.push(`*(${L.slide} ${p.index} – ${L.empty})*`);
    for (const s of lay.stickers) parts.push(`> **${s}**`);
    for (const nTxt of lay.notes) parts.push(escapeBlockStart(nTxt));
    md = parts.join('\n\n');
    sections.push(md);
    if (type === 'text' || type === 'empty') slidesInfo.push({ index: p.index, type });
    onProgress({ phase: 'build', done: p.index, total: n });
  }

  const markdown = `# ${title}\n\n` + sections.join('\n\n---\n\n') + '\n';
  const JSZip = window.JSZip;
  const zip = new JSZip();
  const mdName = `${safeFileName(title)}.md`;
  zip.file(mdName, markdown);
  const folder = zip.folder('images');
  for (const im of images) folder.file(im.name, im.blob);
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (m) => onProgress({ phase: 'zip', done: Math.round(m.percent), total: 100 }));
  slidesInfo.sort((a, b) => a.index - b.index);
  await doc.destroy();
  return {
    zipBlob,
    zipName: `${safeFileName(title)}_Notion.zip`,
    markdown,
    mdName,
    slides: slidesInfo,
    stats: {
      pages: n,
      text: slidesInfo.filter((s) => s.type === 'text').length,
      graphic: slidesInfo.filter((s) => s.type === 'graphic' || s.type === 'mixed').length,
      empty: slidesInfo.filter((s) => s.type === 'empty').length,
      images: images.length,
    },
  };
}
