// arinais-stuborn — handwritten notes → cute PDF + Notion zip.
// The handwriting is read on the device with Tesseract.js (photos are never uploaded).
// Pages are laid out once, drawn on canvas, and saved with jsPDF / JSZip.

const $ = (id) => document.getElementById(id);
const views = ['pick', 'work', 'edit', 'error'];
const show = (name) => views.forEach((v) => $(`n-${v}`).classList.toggle('hidden', v !== name));

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'my notes';

// ---------- looks ----------
const THEMES = {
  strawberry: {
    name: 'strawberry milk', paper: '#fff6f9', line: 'rgba(255, 143, 184, .28)', pattern: 'grid',
    ink: '#5a2440', accent: '#ff5c9d', soft: '#ffc8dd', hl: 'rgba(255, 170, 205, .6)', note: '#ffe3ee',
    tape: ['#ffb3cf', '#ffe0ec'], bullet: 'heart', doodle: ['#ff8fb8', '#ffb38f', '#c79bff'],
  },
  lavender: {
    name: 'lavender dream', paper: '#fbf7ff', line: 'rgba(160, 120, 230, .38)', pattern: 'dots',
    ink: '#3f2a5c', accent: '#9b6bff', soft: '#e3d4ff', hl: 'rgba(199, 155, 255, .45)', note: '#efe6ff',
    tape: ['#cdb4ff', '#efe6ff'], bullet: 'star', doodle: ['#b38cff', '#ff9cc4', '#8fc8ff'],
  },
  peach: {
    name: 'peach blossom', paper: '#fff8f3', line: 'rgba(255, 160, 120, .11)', pattern: 'gingham',
    ink: '#5b3226', accent: '#ff7a59', soft: '#ffd6c6', hl: 'rgba(255, 190, 150, .6)', note: '#ffe9dc',
    tape: ['#ffb99a', '#fff0e8'], bullet: 'flower', doodle: ['#ff9a7a', '#ff8fb8', '#ffc94d'],
  },
};
const FONTS = {
  caveat: { name: 'Caveat', family: 'Caveat', size: 30 },
  gaegu: { name: 'Gaegu', family: 'Gaegu', size: 27 },
  patrick: { name: 'Patrick Hand', family: 'Patrick Hand', size: 25 },
};
const TITLE_FONT = '44px Pacifico';

const QUOTES = [
  'you are doing amazing, sweetie',
  "one page at a time, you've got this",
  'smart, pretty and unstoppable',
  'future you is so proud of you',
  'small steps still move you forward',
  'you are smarter than any exam',
  'believe in yourself like i believe in you',
  'hard topics are just future strengths',
  'breathe, you know more than you think',
  'proud of you for showing up today',
  'your brain is beautiful',
  "keep going, it's working",
  'learning looks good on you',
  'you can do hard things',
  'every note is a step closer',
  'stay soft, stay stubborn',
  'done is better than perfect',
  "you've got this, cutie",
  'little by little, a lot',
  'your effort will pay off',
];

// ---------- 1. read the handwriting ----------
let report = () => {};
let workerPromise = null;

function getWorker() {
  if (!window.Tesseract) return Promise.reject(new Error('reader-missing'));
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker('eng+deu', 1, { logger: (m) => report(m) })
      .catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error('bad-image'); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return img;
  }
}

// scale to ~2000 px, grayscale, stretch contrast (2–98 % percentile) so faint pencil and shadows read better
function prepare(src) {
  const k = Math.min(2, 2000 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const gray = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    gray[j] = v;
    hist[v]++;
  }
  const pct = (p) => {
    const target = gray.length * p;
    let n = 0;
    for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= target) return v; }
    return 255;
  };
  const lo = pct(0.02);
  const hi = Math.max(lo + 1, pct(0.98));
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((gray[j] - lo) * 255) / (hi - lo)));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(im, 0, 0);
  return canvas;
}

// Tesseract output → plain line list (works with either result shape)
function linesOf(data) {
  if (Array.isArray(data.blocks) && data.blocks.length) {
    return data.blocks.flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  }
  if (Array.isArray(data.lines) && data.lines.length) return data.lines;
  return String(data.text || '').split('\n').map((text) => ({ text, confidence: 100, bbox: null }));
}

async function readPages(files, onProgress) {
  report = (m) => { if (m.status !== 'recognizing text') onProgress({ phase: 'load' }); };
  onProgress({ phase: 'load' });
  const worker = await getWorker();
  const pages = [];
  for (let i = 0; i < files.length; i++) {
    const src = await loadImage(files[i]);
    const canvas = prepare(src);
    if (src.close) src.close();
    report = (m) => { if (m.status === 'recognizing text') onProgress({ phase: 'read', done: i + (m.progress || 0), total: files.length }); };
    onProgress({ phase: 'read', done: i, total: files.length });
    const { data } = await worker.recognize(canvas);
    pages.push(linesOf(data));
    canvas.width = canvas.height = 0;
  }
  return toMarkdown(pages);
}

// ---------- 2. lines → markdown ----------
function toMarkdown(pages) {
  const blocks = [];
  let para = null;
  let titled = false;
  const push = (kind, s) => { para = null; blocks.push({ kind, s }); };

  pages.forEach((raw, pi) => {
    const lines = raw
      .map((L) => ({ t: String(L.text || '').replace(/\s+/g, ' ').trim(), c: L.confidence ?? 100, b: L.bbox || null }))
      .filter((L) => {
        const letters = (L.t.match(/\p{L}/gu) || []).length;
        return L.t && /[\p{L}\p{N}]/u.test(L.t) && !(L.c < 35 && letters < 2);
      });
    const hs = lines.filter((L) => L.b).map((L) => L.b.y1 - L.b.y0).sort((a, b) => a - b);
    const med = hs.length ? hs[hs.length >> 1] : 0;
    let prev = null;
    lines.forEach((L, li) => {
      const h = L.b ? L.b.y1 - L.b.y0 : 0;
      const gap = prev && prev.b && L.b ? L.b.y0 - prev.b.y1 : 0;
      prev = L;
      let m;
      if (med && h > med * 1.5 && L.t.length <= 60) {
        if (!titled && pi === 0 && li < 3) { titled = true; push('text', `# ${L.t}`); } else push('text', `## ${L.t}`);
      } else if ((m = /^(?:☐|□|\[\s?\])\s*(.+)/u.exec(L.t))) push('list', `[ ] ${m[1]}`);
      else if ((m = /^(?:[•·]\s*|[*~–—-]\s+|o\s+)(.+)/u.exec(L.t))) push('list', `- ${m[1]}`);
      else if ((m = /^(\d{1,2})[.)]\s+(.+)/.exec(L.t))) push('list', `${m[1]}. ${m[2]}`);
      else if (/^(?:→|⇒|->)/.test(L.t)) push('text', L.t);
      else if (para && !(med && gap > med * 0.9)) para.s += ` ${L.t}`;
      else { push('text', L.t.replace(/^([#>+[])/, '\\$1')); para = blocks[blocks.length - 1]; }
    });
    para = null;
  });

  return blocks
    .map((b, i) => (i ? (b.kind === 'list' && blocks[i - 1].kind === 'list' ? '\n' : '\n\n') : '') + b.s)
    .join('') + (blocks.length ? '\n' : '');
}

// ---------- 3. markdown → blocks ----------
function parse(md) {
  const blocks = [];
  let para = null;
  let note = null;
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const t = raw.trim();
    const level = raw.length - raw.trimStart().length >= 2 ? 1 : 0;
    let m;
    if (!t) { para = note = null; continue; }
    if ((m = /^>\s?(.*)$/.exec(t))) {
      if (note) note.lines.push(m[1]);
      else { note = { k: 'note', lines: [m[1]] }; blocks.push(note); }
      para = null;
      continue;
    }
    note = null;
    if ((m = /^#\s+(.+)$/.exec(t))) blocks.push({ k: 'title', text: m[1] });
    else if ((m = /^#{2,6}\s+(.+)$/.exec(t))) blocks.push({ k: 'h', text: m[1] });
    else if ((m = /^(?:[-*•]\s+)?\[( |x|X)?\]\s*(.*)$/.exec(t))) blocks.push({ k: 'todo', done: /x/i.test(m[1] || ''), text: m[2], level });
    else if ((m = /^[-*•]\s+(.+)$/.exec(t))) blocks.push({ k: 'bullet', text: m[1], level });
    else if ((m = /^(\d{1,3})[.)]\s+(.+)$/.exec(t))) blocks.push({ k: 'num', n: m[1], text: m[2], level });
    else {
      const text = t.replace(/^\\([#>+\-*[])/, '$1');
      if (para) para.lines.push(text);
      else { para = { k: 'p', lines: [text] }; blocks.push(para); }
      continue;
    }
    para = null;
  }
  return blocks;
}

const runs = (s) => String(s).split('**').map((t, i) => ({ t, hl: i % 2 === 1 })).filter((r) => r.t);
const plain = (s) => String(s).replace(/\*\*/g, '').trim();

// ---------- 4. layout + drawing ----------
const W = 794;
const H = 1123;
const L0 = 96;
const R0 = 708;
const CW = R0 - L0;
const TOP = 96;
const BOTTOM = 962;
const measure = document.createElement('canvas').getContext('2d');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rr(c, x, y, w, h, r) {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + q, y);
  c.arcTo(x + w, y, x + w, y + h, q);
  c.arcTo(x + w, y + h, x, y + h, q);
  c.arcTo(x, y + h, x, y, q);
  c.arcTo(x, y, x + w, y, q);
  c.closePath();
}

const HEART = new Path2D('M60 100 C20 72 6 52 6 34 C6 18 18 6 34 6 C46 6 55 13 60 22 C65 13 74 6 86 6 C102 6 114 18 114 34 C114 52 100 72 60 100 Z');
function heart(c, x, y, s, color) {
  c.save();
  c.translate(x, y);
  c.scale(s / 110, s / 110);
  c.translate(-60, -53);
  c.fillStyle = color;
  c.fill(HEART);
  c.restore();
}
function star(c, x, y, s, color) {
  c.save();
  c.translate(x, y);
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.22 : s * 0.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.restore();
}
function sparkle(c, x, y, s, color) {
  const r = s / 2;
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(0, -r);
  c.quadraticCurveTo(0, 0, r, 0);
  c.quadraticCurveTo(0, 0, 0, r);
  c.quadraticCurveTo(0, 0, -r, 0);
  c.quadraticCurveTo(0, 0, 0, -r);
  c.fillStyle = color;
  c.fill();
  c.restore();
}
function flower(c, x, y, s, color) {
  const r = s * 0.2;
  c.save();
  c.translate(x, y);
  c.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI) / 5;
    c.beginPath();
    c.arc(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25, r, 0, 2 * Math.PI);
    c.fill();
  }
  c.fillStyle = '#fff3b0';
  c.beginPath();
  c.arc(0, 0, r * 0.85, 0, 2 * Math.PI);
  c.fill();
  c.restore();
}
const SHAPES = { heart, star, sparkle, flower };

function tape(c, x, y, w, h, angle, color, stripe) {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.globalAlpha = 0.85;
  c.fillStyle = color;
  c.fillRect(-w / 2, -h / 2, w, h);
  c.beginPath();
  c.rect(-w / 2, -h / 2, w, h);
  c.clip();
  c.strokeStyle = stripe;
  c.lineWidth = 6;
  c.globalAlpha = 0.6;
  for (let i = -w; i < w; i += 16) {
    c.beginPath();
    c.moveTo(i, -h / 2);
    c.lineTo(i + h, h / 2);
    c.stroke();
  }
  c.restore();
}

function paper(c, t) {
  c.fillStyle = t.paper;
  c.fillRect(0, 0, W, H);
  c.strokeStyle = t.line;
  c.fillStyle = t.line;
  c.lineWidth = 1;
  if (t.pattern === 'grid') {
    c.beginPath();
    for (let x = 26; x < W; x += 26) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); }
    for (let y = 26; y < H; y += 26) { c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); }
    c.stroke();
  } else if (t.pattern === 'dots') {
    c.beginPath();
    for (let x = 24; x < W; x += 24) for (let y = 24; y < H; y += 24) { c.moveTo(x + 1.4, y); c.arc(x, y, 1.4, 0, 2 * Math.PI); }
    c.fill();
  } else {
    for (let x = 0; x < W; x += 36) c.fillRect(x, 0, 18, H);
    for (let y = 0; y < H; y += 36) c.fillRect(0, y, W, 18);
  }
}

// greedy word wrap; returns lines of segments {t, hl, sp, x, w}
function wrap(ctx, parts, max) {
  const toks = [];
  for (const r of parts) for (const p of r.t.split(/(\s+)/)) if (p) toks.push({ t: p, hl: r.hl, sp: /^\s+$/.test(p) });
  const lines = [];
  let cur = [];
  let x = 0;
  const flush = () => {
    while (cur.length && cur[cur.length - 1].sp) cur.pop();
    lines.push(cur);
    cur = [];
    x = 0;
  };
  for (const tk of toks) {
    if (tk.sp) {
      if (!cur.length) continue;
      const w = ctx.measureText(' ').width;
      cur.push({ t: ' ', hl: tk.hl, sp: true, x, w });
      x += w;
      continue;
    }
    let t = tk.t;
    let w = ctx.measureText(t).width;
    if (x + w > max && cur.length) flush();
    while (w > max && t.length > 1) {
      let n = t.length - 1;
      while (n > 1 && ctx.measureText(t.slice(0, n)).width > max) n--;
      const head = t.slice(0, n);
      cur.push({ t: head, hl: tk.hl, x: 0, w: ctx.measureText(head).width });
      flush();
      t = t.slice(n);
      w = ctx.measureText(t).width;
    }
    cur.push({ t, hl: tk.hl, x, w });
    x += w;
  }
  if (cur.length) flush();
  return lines.length ? lines : [[]];
}
const widthOf = (ln) => (ln.length ? ln[ln.length - 1].x + ln[ln.length - 1].w : 0);

const TODAY = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toLowerCase();

async function layout(md, themeKey, fontKey, seed) {
  const t = THEMES[themeKey];
  const f = FONTS[fontKey];
  const S = f.size;
  const LH = Math.round(S * 1.42);
  const fam = `"${f.family}"`;
  const body = `${S}px ${fam}`;
  const bold = `700 ${Math.round(S * 1.25)}px ${fam}`;
  const small = `${Math.round(S * 0.78)}px ${fam}`;
  const HLH = Math.round(S * 1.25 * 1.3);
  try {
    await Promise.all([body, bold, TITLE_FONT].map((font) => document.fonts.load(font, 'Aaäß')));
  } catch { /* fall back to whatever font is available */ }

  const r = rng(seed);
  const blocks = parse(md);
  const first = blocks.find((b) => b.k === 'title');
  const title = (first && plain(first.text)) || 'my notes';
  if (!first) blocks.unshift({ k: 'title', text: title });

  const pages = [];
  let page;
  let y;
  const newPage = () => { page = { ops: [] }; pages.push(page); y = TOP; };
  const need = (h) => { if (y + h > BOTTOM && page.ops.length) newPage(); };
  newPage();

  const textOp = (segs, x, base, font, ink) => (c) => {
    c.font = font;
    for (const s of segs) if (s.hl) { c.fillStyle = t.hl; rr(c, x + s.x - 2, base - S * 0.6, s.w + 4, S * 0.72, 6); c.fill(); }
    c.fillStyle = ink;
    for (const s of segs) if (!s.sp) c.fillText(s.t, x + s.x, base);
  };

  const markerOp = (b, x, my) => (c) => {
    if (b.k === 'bullet') {
      SHAPES[b.level ? 'sparkle' : t.bullet](c, x, my, S * 0.6, t.accent);
    } else if (b.k === 'num') {
      c.strokeStyle = t.accent;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, my, S * 0.44, 0, 2 * Math.PI);
      c.stroke();
      c.fillStyle = t.accent;
      c.font = `700 ${Math.round(S * 0.6)}px ${fam}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(b.n, x, my + 1);
    } else {
      const s = S * 0.66;
      c.strokeStyle = t.accent;
      c.lineWidth = 2.2;
      rr(c, x - s / 2, my - s / 2, s, s, 5);
      c.stroke();
      if (b.done) heart(c, x, my, s * 0.72, t.accent);
    }
  };

  for (const b of blocks) {
    if (b.k === 'title') {
      measure.font = TITLE_FONT;
      const lines = wrap(measure, [{ t: plain(b.text), hl: false }], CW);
      if (y > TOP) y += 10;
      need(lines.length * 60 + 44);
      lines.forEach((ln, i) => {
        const base = y + 46 + i * 60;
        const w = widthOf(ln);
        page.ops.push((c) => {
          c.save();
          c.translate(L0, base);
          c.rotate(-0.012);
          c.fillStyle = t.soft;
          rr(c, -8, -14, w + 16, 22, 11);
          c.fill();
          c.restore();
        });
        page.ops.push(textOp(ln, L0, base, TITLE_FONT, t.ink));
      });
      const dy = y + lines.length * 60 + 30;
      page.ops.push((c) => {
        heart(c, L0 + 8, dy - S * 0.25, S * 0.55, t.accent);
        c.font = small;
        c.fillStyle = t.accent;
        c.fillText(TODAY, L0 + 24, dy);
      });
      y += lines.length * 60 + 52;
    } else if (b.k === 'h') {
      measure.font = bold;
      const lines = wrap(measure, runs(b.text), CW);
      if (y > TOP) y += 12;
      need(lines.length * HLH + LH * 2);
      for (const ln of lines) {
        const base = y + HLH * 0.78;
        const w = widthOf(ln);
        page.ops.push((c) => {
          c.strokeStyle = t.soft;
          c.lineWidth = 8;
          c.lineCap = 'round';
          c.beginPath();
          c.moveTo(L0, base + 7);
          c.quadraticCurveTo(L0 + w / 2, base + 12, L0 + w, base + 5);
          c.stroke();
        });
        page.ops.push(textOp(ln, L0, base, bold, t.accent));
        y += HLH;
      }
      y += 4;
    } else if (b.k === 'p') {
      measure.font = body;
      for (const src of b.lines) {
        for (const ln of wrap(measure, runs(src), CW)) {
          need(LH);
          page.ops.push(textOp(ln, L0, y + LH * 0.72, body, t.ink));
          y += LH;
        }
      }
      y += 8;
    } else if (b.k === 'bullet' || b.k === 'num' || b.k === 'todo') {
      const ind = b.level * 28;
      const x = L0 + ind + 34;
      measure.font = body;
      wrap(measure, runs(b.text), R0 - x).forEach((ln, i) => {
        need(LH);
        const base = y + LH * 0.72;
        if (i === 0) page.ops.push(markerOp(b, L0 + ind + 13, base - S * 0.3));
        page.ops.push(textOp(ln, x, base, body, t.ink));
        y += LH;
      });
      y += 3;
    } else if (b.k === 'note') {
      measure.font = body;
      const lines = b.lines.flatMap((src) => wrap(measure, runs(src), CW - 64));
      let i = 0;
      y += 6;
      while (i < lines.length) {
        const fit = Math.floor((BOTTOM - y - 44) / LH);
        if (fit < Math.min(2, lines.length - i) && page.ops.length) { newPage(); continue; }
        const chunk = lines.slice(i, i + Math.max(1, fit));
        i += chunk.length;
        const top = y;
        const h = chunk.length * LH + 40;
        const ang = (r() - 0.5) * 0.04;
        page.ops.push((c) => {
          const cx = L0 + CW / 2;
          const cy = top + h / 2;
          c.translate(cx, cy);
          c.rotate(ang);
          c.translate(-cx, -cy);
          c.shadowColor = 'rgba(90, 40, 60, .16)';
          c.shadowBlur = 14;
          c.shadowOffsetY = 5;
          c.fillStyle = t.note;
          rr(c, L0 + 8, top, CW - 16, h, 14);
          c.fill();
          c.shadowColor = 'transparent';
          tape(c, cx, top, 96, 24, -0.05, t.tape[0], t.tape[1]);
          chunk.forEach((ln, k) => textOp(ln, L0 + 32, top + 20 + k * LH + LH * 0.72, body, t.ink)(c));
        });
        y += h + 14;
      }
    }
  }

  const q = rng(seed ^ 0x9e3779b9);
  const start = Math.floor(q() * QUOTES.length);
  const quotes = pages.map((_, i) => QUOTES[(start + i * 7) % QUOTES.length]);
  return { pages, title, quotes, t, S, fam, seed };
}

function drawPage(L, i, scale) {
  const { t, S, fam } = L;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale);
  cv.height = Math.round(H * scale);
  const c = cv.getContext('2d');
  c.scale(scale, scale);
  paper(c, t);
  tape(c, 58, 30, 150, 34, -0.62, t.tape[0], t.tape[1]);
  tape(c, W - 58, 30, 150, 34, 0.62, t.tape[0], t.tape[1]);

  // doodles live in the side margins, so they never cover text
  const r = rng(L.seed + (i + 1) * 7919);
  const n = 7;
  const kinds = ['heart', 'sparkle', 'heart', t.bullet, 'sparkle'];
  for (let k = 0; k < n; k++) {
    const x = k % 2 === 0 ? 24 + r() * 44 : W - 24 - r() * 44;
    const y = 150 + ((k + r() * 0.8) / n) * 800;
    const kind = kinds[Math.floor(r() * kinds.length)];
    const size = 12 + r() * 14;
    const color = t.doodle[Math.floor(r() * t.doodle.length)];
    c.save();
    c.translate(x, y);
    c.rotate((r() - 0.5) * 0.8);
    c.globalAlpha = 0.85;
    SHAPES[kind](c, 0, 0, size, color);
    c.restore();
  }

  for (const op of L.pages[i].ops) { c.save(); op(c); c.restore(); }

  // motivational sticker
  const quote = L.quotes[i];
  c.save();
  c.font = `${Math.round(S * 0.8)}px ${fam}`;
  const qw = c.measureText(quote).width + 66;
  c.translate(W / 2, 1016);
  c.rotate(-0.03);
  c.fillStyle = t.soft;
  rr(c, -qw / 2, -23, qw, 46, 23);
  c.fill();
  heart(c, -qw / 2 + 26, 0, 18, t.accent);
  c.fillStyle = t.ink;
  c.textBaseline = 'middle';
  c.fillText(quote, -qw / 2 + 44, 1);
  c.restore();

  // footer
  c.save();
  c.font = `${Math.round(S * 0.66)}px ${fam}`;
  c.fillStyle = t.accent;
  const a = `page ${i + 1}`;
  const b = "you've got this";
  const wa = c.measureText(a).width;
  const wb = c.measureText(b).width;
  const x0 = W / 2 - (wa + 26 + wb) / 2;
  c.fillText(a, x0, 1086);
  heart(c, x0 + wa + 13, 1080, 12, t.accent);
  c.fillText(b, x0 + wa + 26, 1086);
  c.restore();
  return cv;
}

// ---------- 5. + 6. PDF and Notion zip ----------
async function buildPdf(md) {
  if (!window.jspdf) throw new Error('pdf-missing');
  const L = await layout(md, state.theme, state.font, state.seed);
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', compress: true });
  L.pages.forEach((_, i) => {
    if (i) doc.addPage('a4', 'portrait');
    const cv = drawPage(L, i, 2.5);
    doc.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 595.28, 841.89, undefined, 'FAST');
    cv.width = cv.height = 0;
  });
  return { blob: doc.output('blob'), name: `${safeFileName(L.title)} ♡.pdf` };
}

function notionMarkdown(md, title, quote, images) {
  let body = String(md).replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^(\s*)\[( |x|X)?\]\s*/, (_, s, x) => `${s}- [${x && x.trim() ? 'x' : ' '}] `))
    .join('\n')
    .trim();
  if (!/^#\s/m.test(body)) body = `# ${title}${body ? `\n\n${body}` : ''}`;
  const pics = images.map((fn, i) => `![page ${i + 1}](images/${fn})`).join('\n\n');
  return `${body}\n\n> ✿ ${quote}\n\n---\n\n## my cute pages ♡\n\n${pics}\n`;
}

async function buildZip(md) {
  if (!window.JSZip) throw new Error('zip-missing');
  const L = await layout(md, state.theme, state.font, state.seed);
  const zip = new window.JSZip();
  const folder = zip.folder('images');
  const images = [];
  for (let i = 0; i < L.pages.length; i++) {
    const cv = drawPage(L, i, 2);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.9));
    cv.width = cv.height = 0;
    if (!blob) throw new Error('image-failed');
    const fn = `page-${String(i + 1).padStart(2, '0')}.jpg`;
    folder.file(fn, blob);
    images.push(fn);
  }
  const name = safeFileName(L.title);
  zip.file(`${name}.md`, notionMarkdown(md, L.title, L.quotes[0], images));
  return { blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), name: `${name}_Notion.zip` };
}

// ---------- 7. UI ----------
const state = { theme: 'strawberry', font: 'caveat', seed: Math.floor(Math.random() * 1e9), thumbs: [], editing: false };
const text = $('n-text');

function setProgress({ phase, done = 0, total = 1 }) {
  if (phase === 'load') {
    $('n-work-title').textContent = 'getting ready…';
    $('n-work-sub').textContent = 'the first time takes a little longer';
    $('n-bar').style.width = '6%';
    return;
  }
  $('n-work-title').textContent = 'reading your handwriting…';
  $('n-work-sub').textContent = `page ${Math.min(total, Math.floor(done) + 1)} of ${total}`;
  $('n-bar').style.width = `${Math.min(100, 6 + (94 * done) / total)}%`;
}

function fail(msg) {
  $('n-err-msg').textContent = msg;
  show('error');
}

function clearThumbs() {
  state.thumbs.forEach((u) => URL.revokeObjectURL(u));
  state.thumbs = [];
}

function renderThumbs() {
  const box = $('n-thumbs');
  box.textContent = '';
  state.thumbs.forEach((url, i) => {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `your page ${i + 1}`;
    a.appendChild(img);
    box.appendChild(a);
  });
}

let token = 0;
async function preview() {
  const my = ++token;
  const L = await layout(text.value, state.theme, state.font, state.seed);
  if (my !== token) return;
  const box = $('n-pages');
  const scale = Math.max(0.5, Math.min(2, ((box.clientWidth || W) * (window.devicePixelRatio || 1)) / W));
  box.textContent = '';
  L.pages.forEach((_, i) => {
    const cv = drawPage(L, i, scale);
    cv.className = 'page';
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', `cute page ${i + 1}`);
    box.appendChild(cv);
  });
}

let timer = 0;
const schedulePreview = () => { clearTimeout(timer); timer = setTimeout(preview, 300); };

function openEditor(md, empty) {
  state.editing = true;
  text.value = md;
  $('n-empty').classList.toggle('hidden', !empty);
  renderThumbs();
  show('edit');
  preview();
}

async function handleFiles(list, append) {
  const files = [...list].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name));
  if (!files.length) return fail("That doesn't look like a photo. Please pick a picture of your notes ♡");
  show('work');
  try {
    const md = await readPages(files, setProgress);
    if (!append) clearThumbs();
    files.forEach((f) => state.thumbs.push(URL.createObjectURL(f)));
    const before = append ? text.value.trim() : '';
    const found = md.trim();
    openEditor(before && found ? `${before}\n\n${found}\n` : (before || md), !found);
  } catch (e) {
    console.error(e);
    fail(e.message === 'bad-image'
      ? "I couldn't open that photo. Try a JPG or PNG ♡"
      : "The handwriting reader didn't load. Check your internet and try again ♡");
  }
}

function chips(box, items, current, pick) {
  box.textContent = '';
  for (const [key, item] of Object.entries(items)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip n-chip';
    b.setAttribute('aria-pressed', String(key === current));
    if (item.accent) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = item.accent;
      b.appendChild(dot);
    }
    if (item.family) b.style.fontFamily = `"${item.family}", cursive`;
    b.appendChild(document.createTextNode(item.name));
    b.addEventListener('click', () => {
      [...box.children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      pick(key);
      preview();
    });
    box.appendChild(b);
  }
}
chips($('n-themes'), THEMES, state.theme, (k) => { state.theme = k; });
chips($('n-fonts'), FONTS, state.font, (k) => { state.font = k; });

async function run(btn, busy, job) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busy;
  try {
    const { blob, name } = await job(text.value);
    download(blob, name);
    btn.textContent = label;
  } catch (e) {
    console.error(e);
    btn.textContent = 'oops, try again ♡';
    setTimeout(() => { btn.textContent = label; }, 2500);
  } finally {
    btn.disabled = false;
  }
}

let appendNext = false;
const camera = $('n-camera');
const files = $('n-files');
for (const input of [camera, files]) {
  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    if (picked.length) handleFiles(picked, appendNext);
  });
}
$('n-camera-btn').addEventListener('click', () => { appendNext = false; camera.click(); });
$('n-files-btn').addEventListener('click', () => { appendNext = false; files.click(); });
$('n-add').addEventListener('click', () => { appendNext = true; files.click(); });
$('n-type').addEventListener('click', () => { clearThumbs(); openEditor('', false); text.focus(); });
text.addEventListener('input', schedulePreview);
$('n-shuffle').addEventListener('click', () => { state.seed = Math.floor(Math.random() * 1e9); preview(); });
$('n-pdf').addEventListener('click', (e) => run(e.currentTarget, 'making your pdf…', buildPdf));
$('n-zip').addEventListener('click', (e) => run(e.currentTarget, 'wrapping your zip 🎀', buildZip));
$('n-again').addEventListener('click', () => { clearThumbs(); state.editing = false; text.value = ''; show('pick'); });
$('n-retry').addEventListener('click', () => show(state.editing ? 'edit' : 'pick'));
