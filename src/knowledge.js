// Knowledge base: files the user adds in Settings (resume, notes, docs). Text
// is extracted once and stored in the app's data folder
// (%APPDATA%\ghost-overlay\knowledge); it's added to the AI's instructions so
// answers can draw on it (e.g. replying with the user's real experience).
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const DIR = path.join(app.getPath('userData'), 'knowledge');
const INDEX = path.join(DIR, 'index.json');
const MAX_CHARS = 60000; // total across files, so prompts stay fast
let cachedBlock = null;   // promptBlock() result, reset when files change

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

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, name, kind, chars: text.length, addedAt: new Date().toISOString() };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${entry.id}.txt`), text);
  saveIndex([...list(), entry]);
  cachedBlock = null;
  return entry;
}

function remove(id) {
  saveIndex(list().filter((e) => e.id !== id));
  cachedBlock = null;
  try { fs.unlinkSync(path.join(DIR, `${id}.txt`)); } catch {}
}

// Text for the AI's instructions ('' when the knowledge base is empty).
function promptBlock() {
  if (cachedBlock !== null) return cachedBlock;
  const items = list();
  if (!items.length) return (cachedBlock = '');
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
  return (cachedBlock = `

## About the user (from files they added)
The user added these files so your answers fit them. When a question is about the user (their experience, skills, background, projects, education), answer as the user, in first person, using these facts. Don't invent experience the files don't support; if they don't cover it, answer generally.

${files.join('\n\n')}`);
}

module.exports = { list, add, remove, promptBlock, EXTENSIONS, DIR };
