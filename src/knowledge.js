// Knowledge base: files the user adds in Settings (resume, notes, docs). Text
// is extracted once and stored in the app's data folder
// (%APPDATA%\ghost-overlay\knowledge); it's added to the AI's instructions so
// answers can draw on it (e.g. replying with the user's real experience).
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const DIR = path.join(app.getPath('userData'), 'knowledge');
const INDEX = path.join(DIR, 'index.json');
const BRIEF = path.join(DIR, 'brief.txt'); // what the user is doing right now (typed in the Brief panel)
const MAX_BRIEF = 8000;
const MAX_CHARS = 60000; // total across files, so prompts stay fast
let cachedBlock = null;   // promptBlock() result, reset when files change
let cachedChunks = null;  // interviewChunks() result, reset when files change

const KINDS = {
  '.txt': 'text', '.md': 'text',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
};
const EXTENSIONS = Object.keys(KINDS).map((e) => e.slice(1));

function list() {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return [];
  }
}

function saveIndex(items) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(items, null, 2));
}

async function pdfText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      pages.push(content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join(''));
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

// Image → JPEG base64, at most 2000 px on the long side (keeps it under the
// AI's image size limits while staying readable).
function imageForAi(file) {
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error('Could not open this image.');
  const { width, height } = img.getSize();
  if (Math.max(width, height) > 2000) img = img.resize(width >= height ? { width: 2000 } : { height: 2000 });
  return img.toJPEG(90).toString('base64');
}

// readImage(base64Jpeg) → text, provided by the caller (uses the AI).
async function add(file, { readImage }) {
  const name = path.basename(file);
  const kind = KINDS[path.extname(file).toLowerCase()];
  if (!kind) throw new Error(`${name}: unsupported file type (use PDF, TXT, PNG or JPG).`);

  let text;
  if (kind === 'text') {
    text = fs.readFileSync(file, 'utf8');
  } else if (kind === 'pdf') {
    text = await pdfText(file);
    if (text.replace(/\s/g, '').length < 20) {
      throw new Error(`${name}: no selectable text (it may be a scan). Add a screenshot or photo of it as PNG/JPG instead.`);
    }
  } else {
    text = await readImage(imageForAi(file));
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error(`${name}: no text found.`);
  return addText(name, kind, text);
}

function addText(name, kind, text) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, name, kind, chars: text.length, addedAt: new Date().toISOString() };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${entry.id}.txt`), text);
  saveIndex([...list(), entry]);
  cachedBlock = cachedChunks = null;
  return entry;
}

function remove(id) {
  saveIndex(list().filter((e) => e.id !== id));
  cachedBlock = cachedChunks = null;
  try { fs.unlinkSync(path.join(DIR, `${id}.txt`)); } catch {}
}

function getBrief() {
  try { return fs.readFileSync(BRIEF, 'utf8'); } catch { return ''; }
}

function setBrief(text) {
  text = String(text || '').trim().slice(0, MAX_BRIEF);
  fs.mkdirSync(DIR, { recursive: true });
  if (text) fs.writeFileSync(BRIEF, text);
  else try { fs.unlinkSync(BRIEF); } catch {}
  cachedBlock = null;
  return text;
}

function briefBlock() {
  const brief = getBrief().trim();
  return brief ? `

## Right now (the user's brief)
The user wrote this about what they are doing right now. It is the most important context: keep every answer on this topic and tailor it to this situation (company, role, subject, level, what to focus on or avoid). If it conflicts with the files below, follow the brief.

<brief>
${brief}
</brief>` : '';
}

// Text for the AI's instructions ('' when the brief and knowledge base are empty).
function promptBlock() {
  if (cachedBlock !== null) return cachedBlock;
  const brief = briefBlock();
  const items = list().filter((i) => i.kind !== 'interview'); // those are recalled per question
  if (!items.length) return (cachedBlock = brief);
  let budget = MAX_CHARS;
  const files = [];
  for (const item of items) {
    let text;
    try { text = fs.readFileSync(path.join(DIR, `${item.id}.txt`), 'utf8'); } catch { continue; }
    if (budget <= 0) break;
    if (text.length > budget) text = `${text.slice(0, budget)}\n[…truncated]`;
    budget -= text.length;
    files.push(`<file name="${item.name}">\n${text}\n</file>`);
  }
  return (cachedBlock = `${brief}

## About the user (from files they added)
The user added these files so your answers fit them. When a question is about the user (their experience, skills, background, projects, education), answer as the user, in first person, using these facts. Don't invent experience the files don't support; if they don't cover it, answer generally.

${files.join('\n\n')}`);
}

// ---------- Past interviews ----------
// Notes learned from each interview: one block per question asked ("Q: …").
// recall() returns the blocks that share the most words with the current
// question, rarer words counting more.
// ponytail: keyword overlap, not embeddings; add an embedding index if
// paraphrased questions get missed.
const STOP = new Set(('the and or to of in on for with is are was were be been you your yours me my mine it its '
  + 'this that these those what how why when where who which do does did can could would should will tell about '
  + 'so like just yeah okay ok um uh have has had at as by from an we our they them their there here')
  .split(' '));
const terms = (s) => (s.toLowerCase().match(/[a-z0-9+#]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));

function interviewChunks() {
  if (cachedChunks) return cachedChunks;
  cachedChunks = [];
  for (const item of list().filter((i) => i.kind === 'interview')) {
    let text;
    try { text = fs.readFileSync(path.join(DIR, `${item.id}.txt`), 'utf8'); } catch { continue; }
    for (const block of text.split(/\n\s*\n/)) {
      if (block.trim().startsWith('Q:')) cachedChunks.push({ text: block.trim(), terms: new Set(terms(block)) });
    }
  }
  return cachedChunks;
}

function recall(query, k = 4) {
  const chunks = interviewChunks();
  const words = [...new Set(terms(query))];
  if (!chunks.length || !words.length) return [];
  const weight = Object.fromEntries(words.map((w) => {
    const df = chunks.filter((c) => c.terms.has(w)).length;
    return [w, df ? Math.log(1 + chunks.length / df) : 0];
  }));
  return chunks
    .map((c) => {
      const shared = words.filter((w) => c.terms.has(w));
      return { text: c.text, shared: shared.length, score: shared.reduce((s, w) => s + weight[w], 0) };
    })
    .filter((r) => r.shared >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.text);
}

module.exports = { list, add, addText, remove, getBrief, setBrief, promptBlock, recall, EXTENSIONS, DIR, MAX_BRIEF };
