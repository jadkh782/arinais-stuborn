import { convertPdf } from './converter.js';

const $ = (id) => document.getElementById(id);
const views = ['upload', 'work', 'done', 'error'];
const show = (name) => views.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== name));

const MAX_MB = 150;

const AFFIRMATIONS = [
  'one lecture at a time, you\'ve got this ♡',
  'you are smarter than any exam ✿',
  'small steps every day add up to big wins',
  'proud of you for showing up today ♡',
  'future you is already thankful ✦',
  'you\'re doing amazing, keep going',
  'hard topics are just future strengths ✿',
  'believe in yourself like i believe in you ♡',
];
const WORK_LOVE = [
  'every slide you learn is a step closer ♡',
  'you can do this ✿',
  'deep breath, you\'ve got this',
  'look at you, getting things done ✦',
  'so proud of you ♡',
];

function rotate(el, list, ms) {
  let i = Math.floor(Math.random() * list.length);
  el.textContent = list[i];
  return setInterval(() => {
    el.classList.add('fade');
    setTimeout(() => { i = (i + 1) % list.length; el.textContent = list[i]; el.classList.remove('fade'); }, 400);
  }, ms);
}
rotate($('affirm'), AFFIRMATIONS, 4200);
rotate($('work-love'), WORK_LOVE, 2600);
let result = null;

const PHASES = {
  read: ['reading your slides…', (d, t) => `slide ${d} of ${t}`],
  build: ['making it pretty…', (d, t) => `slide ${d} of ${t}`],
  zip: ['wrapping your zip 🎀', (d) => `${d}%`],
};

function setProgress({ phase, done, total }) {
  const [title, sub] = PHASES[phase] || PHASES.read;
  $('work-title').textContent = title;
  $('work-sub').textContent = sub(done, total);
  const base = { read: 0, build: 40, zip: 90 }[phase] ?? 0;
  const span = { read: 40, build: 50, zip: 10 }[phase] ?? 40;
  $('bar').style.width = `${Math.min(100, base + (span * done) / Math.max(1, total))}%`;
}

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

const TYPE_LABEL = { text: 'text', graphic: 'picture', mixed: 'text + pic', empty: 'empty' };

function renderDone(file, r) {
  $('done-file').textContent = `${file.name} → ${r.zipName}`;
  const s = r.stats;
  $('chips').innerHTML = [
    `<span class="chip"><b>${s.pages}</b> slides</span>`,
    `<span class="chip"><b>${s.text}</b> as real text</span>`,
    `<span class="chip"><b>${s.graphic}</b> with diagrams</span>`,
    s.empty ? `<span class="chip"><b>${s.empty}</b> empty</span>` : '',
  ].join('');
  const box = $('slides');
  box.innerHTML = '';
  for (const sl of r.slides) {
    const el = document.createElement('div');
    el.className = `slide ${sl.type}`;
    if (sl.thumb) {
      const img = document.createElement('img');
      img.src = sl.thumb;
      img.alt = `slide ${sl.index}`;
      img.loading = 'lazy';
      el.appendChild(img);
    } else {
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = sl.type === 'empty' ? '☁️' : '📝';
      el.appendChild(ico);
    }
    el.insertAdjacentHTML('beforeend', `<span class="no">${sl.index}</span><span class="tag">${TYPE_LABEL[sl.type] || sl.type}</span>`);
    box.appendChild(el);
  }
  $('md-out').textContent = r.markdown;
}

async function handle(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) return fail('That doesn\'t look like a PDF. Please pick a .pdf file ♡');
  if (file.size > MAX_MB * 1024 * 1024) return fail(`That file is over ${MAX_MB} MB. Try a smaller one ♡`);
  if (!window.JSZip) return fail('Still loading. Give it a second and try again ♡');
  show('work');
  setProgress({ phase: 'read', done: 0, total: 1 });
  try {
    result = await convertPdf(file, setProgress);
    renderDone(file, result);
    show('done');
    download(result.zipBlob, result.zipName);
  } catch (e) {
    console.error(e);
    const msg = /password/i.test(String(e)) ? 'This PDF is password-protected. Remove the password and try again.'
      : /Invalid PDF|structure/i.test(String(e)) ? 'This PDF seems to be damaged or not a real PDF.'
        : 'Something went wrong while reading this PDF.';
    fail(msg);
  }
}

function fail(msg) {
  $('err-msg').textContent = msg;
  show('error');
}

// ----- wiring -----
const drop = $('drop');
const input = $('file');
input.addEventListener('change', () => { handle(input.files[0]); input.value = ''; });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
// allow dropping anywhere on the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!$('tab-slides').classList.contains('hidden') && !$('view-upload').classList.contains('hidden') && e.dataTransfer?.files?.[0]) handle(e.dataTransfer.files[0]);
});

// ----- tabs: #notes shows the handwriting tab, anything else the slides tab -----
function showTab() {
  const notes = location.hash === '#notes';
  $('tab-slides').classList.toggle('hidden', notes);
  $('tab-notes').classList.toggle('hidden', !notes);
  $('tabbtn-slides').setAttribute('aria-selected', String(!notes));
  $('tabbtn-notes').setAttribute('aria-selected', String(notes));
}
window.addEventListener('hashchange', showTab);
showTab();

$('btn-download').addEventListener('click', () => result && download(result.zipBlob, result.zipName));
$('btn-again').addEventListener('click', () => { result = null; show('upload'); });
$('btn-retry').addEventListener('click', () => show('upload'));
$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('md-out').textContent);
    $('btn-copy').textContent = 'copied ♡';
    setTimeout(() => { $('btn-copy').textContent = 'copy'; }, 1500);
  } catch { /* clipboard not allowed */ }
});
