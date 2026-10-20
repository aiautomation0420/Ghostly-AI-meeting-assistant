const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, dialog, screen, session, Tray, Menu, nativeImage, shell,
} = require('electron');
const fs = require('fs');
// Saved settings override .env; load them before anything reads the environment.
const settings = require('./settings');
settings.load();
const { createProvider, DEFAULT_MODELS } = require('./providers');
const { createTranscriber, hasModel, listModels } = require('./transcriber');
const { createLoopback } = require('./loopback');
const knowledge = require('./knowledge');

const DEBUG = process.env.GHOST_DEBUG === '1'; // log transcripts to ghost.log

// Diagnostic log: ghost.log in the project folder. Over 5 MB, the old log is
// moved to ghost.old.log at startup so it can't grow forever.
const LOG_FILE = path.join(__dirname, '..', 'ghost.log');
try {
  if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log'));
} catch {}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}
process.on('uncaughtException', (e) => log('uncaughtException:', e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.stack || e));

const SYSTEM_PROMPT = `You are a real-time assistant shown in a small overlay on the user's screen during meetings, calls, and work.
- Be concise and scannable: lead with the direct answer, then at most a few short bullets.
- When given a screenshot, figure out what the user most likely needs help with right now (a question on screen, an error, a problem to solve, what to say next) and address that.
- For code, give the working solution first, then a one-line explanation.
- When it's a question the user has to answer (interview, test, application or screening question), write the answer itself, ready for the user to say or type: first person, as the user, the best answer their real experience supports. Never coach or describe the answer ("you could mention…", "use STAR", "talk about a time…"), and don't restate the question.
- For behavioural questions ("tell me about a time…", "describe a situation…", "give an example…"), use STAR with bold labels, one paragraph each, 1-3 natural spoken sentences: **Situation:** **Task:** **Action:** (the longest, with what I did and how) **Result:** (measurable if possible, plus what I learned). Use real facts from the user's files; where a detail like a number isn't known, put a short placeholder such as [X hours] instead of inventing it.
- Never pad with preamble like "Sure!" or "Great question".`;

// Per-tier prompts for providers that run several models (claude-code).
const DEEP_TAG = '[DEEP]';
const TIER_PROMPTS = {
  fast: `${SYSTEM_PROMPT}
- Speed matters most: you are the first, fastest responder.
- If the request genuinely needs deep reasoning (non-trivial code, math, debugging, multi-step logic, long analysis), begin your reply with the exact tag ${DEEP_TAG}, then still give a brief quick answer. A stronger model will follow up with the full solution. Don't use the tag for simple questions.`,
  balanced: SYSTEM_PROMPT,
  deep: `${SYSTEM_PROMPT}
- A faster model is already showing a quick answer. Give the complete, correct solution; don't repeat a short summary first.`,
};

const LIVE_PROMPT = `You help the user during a live conversation (a call, meeting, or interview). You receive a rolling transcript: "Them" is the other person or people, "Me" is the user. It comes from speech recognition, so expect small errors.
- Each message marks which lines are NEW. Judge only the NEW lines; earlier lines and your earlier replies are context. A follow-up question is a new question even if it is on the same topic.
- When Them, in the NEW lines, asks the user a question or says something the user clearly needs to respond to, reply with what the user could say.- Otherwise reply with exactly SKIP and nothing else.

Output format (nothing before it):
"<what the user says: natural first-person wording, 1-3 short sentences>"
- <optional: up to 3 terse facts the user could mention; omit for small talk>

Bullets are content for the user to say, never commentary about the conversation. Your very first character must be the opening quote mark (or the S of SKIP). Never describe the situation, explain your reasoning, or mention Them, Me, or the transcript.`;

// The user's knowledge-base files are appended to every prompt.
const withKnowledge = (prompt) => prompt + knowledge.promptBlock();
const tierPrompts = () => Object.fromEntries(Object.entries(TIER_PROMPTS).map(([k, v]) => [k, withKnowledge(v)]));
const livePrompt = () => withKnowledge(LIVE_PROMPT);

// After each interview, the transcript is turned into notes (one block per
// question) that are recalled when a similar question comes up later.
const LEARN_PROMPT = `You review interview transcripts so the user answers better next time. The transcript comes from speech recognition, so expect small errors: "Them" is the interviewer, "Me" is the user.

Start with one line: "Interview: <company, role and interviewer if mentioned, else unknown>".
Then, for every question the interviewer asked, one block, blocks separated by a blank line:
Q: <the question, cleaned up, on one line>
Topics: <comma-separated keywords: subject, skills, technologies>
I said: <one-line summary of the user's actual answer, or "(no answer)">
Better answer: <a strong first-person answer, 2-5 sentences, built on what the user said and the facts in their files; never invent experience>

If the transcript contains no interview questions, reply with exactly NONE.`;

const pastInterviews = (query) => {
  const notes = knowledge.recall(query);
  return notes.length
    ? `From the user's past interviews (similar questions, with better answers worked out afterwards; reuse them when they fit):\n${notes.join('\n\n')}`
    : '';
};

let provider = null;
let providerError = null; // setup problem shown in the overlay (missing key etc.)

let win = null;
let tray = null;
let stealth = process.env.GHOST_STEALTH !== '0'; // hidden from screenshots & screen sharing
let clickThrough = false;  // mouse passes through the overlay
let history = [];          // conversation for the session (see providers.js)
let currentAbort = null;   // AbortController for the in-flight answer

// Live audio
// Speech-to-text: the other person ("them") uses the fast model so suggestions
// stay quick; your mic ("me") uses the more accurate small.en when installed,
// since its speed doesn't hold up suggestions. Both share the CPU, so "them"
// runs at higher priority: the mic waits, the question never does.
const speechModels = () => {
  const them = process.env.WHISPER_MODEL_THEM || process.env.WHISPER_MODEL || 'base.en';
  const me = process.env.WHISPER_MODEL_ME || (hasModel('small.en') ? 'small.en' : them);
  return { them, me };
};
let transcribers;
function makeTranscribers() {
  const { them, me } = speechModels();
  const { PRIORITY_ABOVE_NORMAL, PRIORITY_BELOW_NORMAL } = require('os').constants.priority;
  transcribers = { them: createTranscriber({ log, model: them, threads: 6, priority: PRIORITY_ABOVE_NORMAL }) };
  transcribers.me = me === them ? transcribers.them
    : createTranscriber({ log, model: me, threads: 5, priority: PRIORITY_BELOW_NORMAL });
}
function stopTranscribers() {
  transcribers.them.stop();
  transcribers.me.stop();
}
makeTranscribers();
// Windows: capture computer audio natively (works with any output device,
// including 7.1 headsets where Chromium's capture fails).
const loopback = createLoopback({
  log,
  onPcm: (samples) => { if (listening) win.webContents.send('audio:pcm', samples); },
  onError: (err) => {
    if (!listening) return;
    log('native loopback error:', err.message);
    win.webContents.send('listen:state', { on: true, error: `Computer audio stopped: ${err.message}` });
  },
});
let listening = false;
let transcript = [];       // { who: 'them' | 'me', text, at }
const live = { pending: false, force: false, checkedUpTo: 0 };

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 520;
  win = new BrowserWindow({
    width,
    height: 460,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: !stealth, // resize edges show ↔ cursors, which recordings capture
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(stealth);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', pushState);
  win.webContents.on('render-process-gone', (_e, details) => {
    log('renderer gone:', details.reason, details.exitCode);
  });
  for (const ev of ['show', 'hide', 'close', 'closed', 'minimize', 'unresponsive']) {
    win.on(ev, () => log('window', ev));
  }
}

function pushState() {
  win?.webContents.send('state', {
    stealth,
    clickThrough,
    learn: learnOn(),
    brief: Boolean(knowledge.getBrief()),
    opacity: opacity(),
    model: provider?.model ? `${provider.label} · ${provider.model}` : '',
    error: providerError,
  });
  updateTrayMenu();
}

// Tray icon: the overlay has no taskbar button, so this is the always-available
// way to bring it back, toggle modes, or quit.
function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4); // BGRA
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d <= 7) buf.set([0xf1, 0x66, 0x63, 0xff], (y * size + x) * 4); // indigo dot
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Ghost Overlay');
  tray.on('click', showOverlay);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show overlay', click: showOverlay },
    { label: 'Hide overlay', click: () => win.hide() },
    { label: 'Reset position', click: resetPosition },
    { label: 'Open notes folder', click: () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); } },
    { type: 'separator' },
    { label: 'Stealth (hide from screen share)', type: 'checkbox', checked: stealth, click: (i) => setStealth(i.checked) },
    { label: 'Click-through', type: 'checkbox', checked: clickThrough, click: (i) => setClickThrough(i.checked) },
    { label: 'Listen to audio', type: 'checkbox', checked: listening, click: (i) => setListening(i.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// Click-through stays as it is: only Ctrl+Alt+X (or the tray) changes it.
function showOverlay() {
  win.show();
}

function resetPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const [width] = win.getSize();
  win.setPosition(workArea.x + workArea.width - width - 24, workArea.y + 24);
  showOverlay();
}

async function captureScreen() {
  // With stealth on, the overlay is already excluded from capture.
  // Otherwise hide it briefly so it doesn't appear in its own screenshot.
  const wasVisible = win.isVisible();
  if (!stealth && wasVisible) {
    win.hide();
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    // Every monitor: the question may be on a different screen than the
    // overlay (and the cursor, when the Screen button is clicked).
    // Cursor's display first, so a single-screen answer favours it.
    const displays = screen.getAllDisplays();
    const cursorId = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor))),
        height: Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor))),
      },
    });
    sources.sort((a, b) => (b.display_id === cursorId) - (a.display_id === cursorId));
    return sources.filter((s) => !s.thumbnail.isEmpty()).map((s) => {
      let img = s.thumbnail;
      // Downscale: larger images cost more tokens without helping the model.
      const { width, height } = img.getSize();
      const maxEdge = 1568;
      if (Math.max(width, height) > maxEdge) {
        img = img.resize(width >= height ? { width: maxEdge } : { height: maxEdge });
      }
      return img.toJPEG(85).toString('base64');
    });
  } finally {
    if (!stealth && wasVisible) win.showInactive();
  }
}

// Create and warm up the AI provider. `provider` is only set once it's ready,
// so nothing uses a half-started one; if another init starts meanwhile (e.g.
// two quick settings changes), the older one is discarded.
let initSeq = 0;
async function initProvider() {
  const seq = ++initSeq;
  provider = null;
  let p = null;
  try {
    p = createProvider();
    win?.webContents.send('status', `Connecting to ${p.label}…`);
    await p.init();
    if (seq !== initSeq) return p.shutdown?.();
    p.warm?.(tierPrompts());
    if (listening) for (const slot of ['live', 'live2']) p.prepare?.(slot, livePrompt());
    provider = p;
    providerError = null;
    log('provider ready:', p.name, p.model);
  } catch (err) {
    if (seq !== initSeq) return;
    p?.shutdown?.();
    providerError = err.message;
    log('provider error:', err.message);
  }
  pushState();
}

// Resolves once the AI is ready (or failed to start), waiting up to `ms`.
async function providerReady(ms) {
  const t0 = Date.now();
  while (!provider && !providerError && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return provider;
}

async function ask({ text, withScreen }) {
  // A question asked while the AI is still starting waits for it.
  if (!provider && !providerError) {
    win.webContents.send('status', 'Connecting…');
    await providerReady(15000);
  }
  if (providerError || !provider?.model) {
    log('ask skipped:', providerError || 'AI not ready after 15 s');
    win.webContents.send('answer:start', { question: text?.trim() || '(screen)', withScreen });
    win.webContents.send('answer:error', providerError || 'The AI is still starting. Try again in a moment.');
    return;
  }
  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;

  const turn = {
    role: 'user',
    text: text?.trim() || 'Look at my screen and help me with whatever I need right now.',
  };
  if (withScreen) {
    win.webContents.send('status', 'Capturing screen…');
    try {
      turn.image = await captureScreen(); // one JPEG per monitor
      if (!turn.image.length) throw new Error('no screen image');
      if (turn.image.length > 1) {
        turn.text += `\n\n(${turn.image.length} screenshots, one per monitor, the one under the mouse first. The question may be on any of them; ignore the others.)`;
      }
    } catch (err) {
      log('screen capture failed:', err.message);
      win.webContents.send('answer:start', { question: text?.trim() || '(screen)', withScreen });
      win.webContents.send('answer:error', `Couldn't capture the screen: ${err.message}`);
      if (currentAbort === abort) currentAbort = null;
      return;
    }
  }
  if (listening && transcript.length) {
    turn.text += `\n\nLive conversation transcript (most recent last):\n${formatTranscript(20)}`;
  }
  const past = pastInterviews(`${text || ''}\n${listening ? formatTranscript(4) : ''}`);
  if (past) turn.text += `\n\n${past}`;
  history.push(turn);
  log('ask:', withScreen ? `${turn.image.length} screen(s)` : 'text only');

  // Routing (multi-model providers only): screenshots go to the fast model,
  // which can flag hard problems for the deep model; typed questions go to
  // the balanced model.
  const routed = Boolean(provider.tiers);
  const tier = routed ? (withScreen ? 'fast' : 'balanced') : undefined;
  const t0 = Date.now();
  const send = (channel, data) => { if (!abort.signal.aborted) win.webContents.send(channel, data); };

  send('answer:start', {
    question: text?.trim() || '(screen)',
    withScreen,
    model: routed ? provider.tierName(tier) : provider.model,
  });
  send('status', routed ? `${provider.tierName(tier)} answering…` : 'Thinking…');

  let deepRun = null;
  const startDeep = () => {
    send('deep:start', { model: provider.tierName('deep') });
    send('status', `${provider.tierName('deep')} working on the full answer…`);
    let first = true;
    deepRun = provider.stream({
      tier: 'deep',
      history,
      signal: abort.signal,
      onText: (delta) => {
        if (first) { first = false; send('answer:timing', { which: 'deep', firstMs: Date.now() - t0 }); }
        send('deep:delta', delta);
      },
    }).then(
      (r) => { send('answer:timing', { which: 'deep', totalMs: Date.now() - t0 }); return r.text; },
      (err) => { if (!abort.signal.aborted) send('deep:error', provider.describeError(err)); return null; },
    );
  };

  // The fast model may open with DEEP_TAG; hold back the first few characters
  // until we know, then strip the tag and start the deep model in parallel.
  let pending = '';
  let decided = tier !== 'fast';
  let firstSent = false;
  const emit = (s) => {
    if (!s) return;
    if (!firstSent) { firstSent = true; send('answer:timing', { which: 'quick', firstMs: Date.now() - t0 }); }
    send('answer:delta', s);
  };
  const onText = (delta) => {
    if (decided) return emit(delta);
    pending += delta;
    const head = pending.trimStart();
    if (head.startsWith(DEEP_TAG)) {
      decided = true;
      startDeep();
      emit(head.slice(DEEP_TAG.length).trimStart());
    } else if (head.length >= DEEP_TAG.length || !DEEP_TAG.startsWith(head)) {
      decided = true;
      emit(pending);
    }
  };

  let quick = null;
  try {
    const result = await provider.stream({ tier, system: withKnowledge(SYSTEM_PROMPT), history, signal: abort.signal, onText });
    if (!decided) emit(pending);
    quick = { ...result, text: result.text.replace(/^\s*\[DEEP\]\s*/, '') };
    send('answer:timing', { which: 'quick', totalMs: Date.now() - t0 });
  } catch (err) {
    if (!abort.signal.aborted) {
      log('ask error:', err.stack || err.message);
      send('answer:error', provider.describeError(err));
    }
  }
  const deep = deepRun ? await deepRun : null;

  const index = history.indexOf(turn); // -1 if Clear emptied the history meanwhile
  if (abort.signal.aborted || (!quick && !deep)) {
    if (index >= 0) history.splice(index, 1); // drop the unanswered user turn
  } else if (index >= 0) {
    history.push({ role: 'assistant', text: deep || quick.text, raw: deep ? undefined : quick.raw });
    // Older screenshots are never sent again; free their memory.
    for (const t of history) {
      if (t.image && t !== turn) { t.image = undefined; t.hadImage = true; }
    }
    send('answer:done');
  }
  if (currentAbort === abort) currentAbort = null;
}

// ---------- Live audio ----------

const fmtLine = (l) => `${l.who === 'them' ? 'Them' : 'Me'}: ${l.text}`;

function formatTranscript(lines) {
  return transcript.slice(-lines).map(fmtLine).join('\n');
}

// ---------- Learning from interviews ----------

const PENDING = path.join(knowledge.DIR, 'pending-transcript.json'); // saved at quit, learned next start
let learnedUpTo = 0; // transcript lines up to this time are already learned
const learning = new Set(); // line arrays being summarized; saved as pending if the app quits first

const unlearned = () => transcript.filter((l) => l.at > learnedUpTo);
const learnOn = () => process.env.GHOST_LEARN !== '0'; // the Learn button

async function learn(lines) {
  if (lines.filter((l) => l.who === 'them').length < 3) return; // not a real conversation
  learnedUpTo = Math.max(learnedUpTo, lines[lines.length - 1].at);
  if (!learnOn()) return log('learn off: interview not saved');
  learning.add(lines);
  try {
    if (!(await providerReady(15000)) || providerError) throw new Error(providerError || 'AI not ready');
    const notes = (await provider.complete({ system: withKnowledge(LEARN_PROMPT), text: lines.map(fmtLine).join('\n') })).trim();
    const count = (notes.match(/^Q:/gm) || []).length;
    if (!count) return log('learn: no interview questions found');
    const when = new Date(lines[0].at);
    knowledge.addText(`Interview ${when.toISOString().slice(0, 16).replace('T', ' ')}`, 'interview', notes);
    log('learned', count, 'questions from interview');
    win?.webContents.send('status', `Learned ${count} questions from this interview`);
  } catch (err) {
    log('learn failed, will retry next start:', err.message);
    savePending(lines);
  } finally {
    learning.delete(lines);
  }
}

// ---------- Notes after a call ----------
// Readable notes for the user (Learn is for the AI), saved as Markdown in
// Documents\Ghostly Notes when listening stops or the session is cleared.

const NOTES_PROMPT = `You write notes for the user after a call, meeting or interview. The transcript comes from speech recognition, so expect small errors: "Them" is the other person or people, "Me" is the user.

Write Markdown in plain, everyday words:
# <short title, e.g. "Interview with Acme for AI Automation Specialist">
## Summary
2-4 bullets: what the call was about and how it went.
## Questions they asked
Each question in bold, then one line on what I answered, taken only from my own "Me" lines; if there are none for it, write "(my answer wasn't captured)". Never guess what I said from their reaction. Leave this section out if they asked me no questions.
## Next steps
Promises, deadlines, follow-ups, what happens next. Write "None mentioned" if there are none.
## Details to remember
Names, companies, dates, numbers, tools, salary or rates. Leave this section out if there are none.

Only use what is in the transcript; never invent anything. If it has no real conversation, reply with exactly NONE.`;

const NOTES_DIR = path.join(app.getPath('documents'), 'Ghostly Notes');
const notesOn = () => process.env.GHOST_NOTES !== '0';

async function takeNotes(lines) {
  if (!notesOn() || lines.filter((l) => l.who === 'them').length < 3) return;
  let notes;
  try {
    if (!(await providerReady(15000)) || providerError) throw new Error(providerError || 'AI not ready');
    notes = (await provider.complete({ system: NOTES_PROMPT, text: lines.map(fmtLine).join('\n') })).trim();
    if (notes === 'NONE') return log('notes: no conversation found');
  } catch (err) {
    log('notes failed, saving the transcript only:', err.message);
    notes = `# Call notes\n\n(The AI couldn't write notes: ${err.message})`;
  }
  const when = new Date(lines[0].at);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}-${pad(when.getMinutes())}`;
  const title = (notes.match(/^#\s+(.+)/m)?.[1] || 'Call notes').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60);
  const file = path.join(NOTES_DIR, `${stamp} ${title}.md`);
  const said = lines.map((l) => `**${l.who === 'them' ? 'Them' : 'Me'}:** ${l.text}`).join('\n\n');
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(file, `${notes}\n\n---\n\n## Transcript\n\n${said}\n`);
  log('notes saved:', path.basename(file));
  win?.webContents.send('status', 'Notes saved (tray → Open notes folder)');
}

function savePending(lines) {
  if (!lines.length) return;
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch {}
  fs.mkdirSync(knowledge.DIR, { recursive: true });
  fs.writeFileSync(PENDING, JSON.stringify([...saved, ...lines]));
}

function learnPending() {
  let lines;
  try { lines = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return; }
  fs.unlinkSync(PENDING);
  learn(lines);
}

function words(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean));
}

// With speakers (no headphones) the mic also hears the other person. A "me"
// line whose words mostly appear in what "them" said around the same time is
// an echo. Checked both ways, since either transcript can arrive first.
const ECHO_WINDOW_MS = 12000;

function isEchoOf(meLine, themLines) {
  const mine = words(meLine.text);
  const theirs = new Set();
  for (const l of themLines) {
    if (Math.abs(meLine.at - l.at) <= ECHO_WINDOW_MS) for (const w of words(l.text)) theirs.add(w);
  }
  if (!mine.size || !theirs.size) return false;
  let shared = 0;
  for (const w of mine) if (theirs.has(w)) shared++;
  return shared / mine.size > 0.6;
}

function sendCaptions() {
  win.webContents.send('transcript', { lines: transcript.slice(-3) });
}

// Bumped on every on/off, so a slow start that was superseded (switched off,
// or off and on again) stops instead of starting a second capture.
let listenSeq = 0;

async function setListening(on) {
  if (on === listening) return;
  listening = on;
  const seq = ++listenSeq;
  const superseded = () => seq !== listenSeq;
  updateTrayMenu();
  if (!on) {
    for (const spec of speculations.values()) spec.cancel();
    speculations.clear();
    loopback.stop();
    win.webContents.send('listen:stop');
    win.webContents.send('listen:state', { on: false });
    log('listening off');
    const lines = unlearned();
    learn(lines);
    takeNotes(lines);
    return;
  }
  win.webContents.send('listen:state', { on: true, status: 'Starting speech-to-text…' });
  try {
    await Promise.all([transcribers.them.ensureStarted(), transcribers.me.ensureStarted()]);
  } catch (err) {
    if (superseded()) return;
    listening = false;
    updateTrayMenu();
    win.webContents.send('listen:state', { on: false, error: err.message });
    log('listen error:', err.message);
    return;
  }
  if (superseded()) return;
  for (const slot of ['live', 'live2']) provider?.prepare?.(slot, livePrompt()); // warm the live models
  let nativeSystem = false;
  if (process.platform === 'win32') {
    try {
      await loopback.start();
      nativeSystem = true;
    } catch (err) {
      log('native loopback unavailable, using Chromium capture:', err.message);
    }
  }
  if (superseded()) {
    if (!listening) loopback.stop();
    return;
  }
  const [source] = await desktopCapturer.getSources({ types: ['screen'] });
  if (superseded()) return;
  win.webContents.send('listen:start', { sourceId: source?.id, nativeSystem, micHint: process.env.GHOST_MIC });
}

// Add a transcribed line to the transcript (echo-filtered) and refresh the
// captions. Returns false if the line was dropped as an echo.
function commitLine(line) {
  const theirs = () => transcript.filter((l) => l.who === 'them');
  if (line.who === 'me' && isEchoOf(line, theirs())) {
    log('dropped mic echo');
    return false;
  }
  transcript.push(line);
  if (transcript.length > 3000) transcript.shift(); // whole interview is kept for learning
  if (line.who === 'them') {
    // Remove mic lines that turned out to be echoes of this.
    const before = transcript.length;
    transcript = transcript.filter((l) => l.who !== 'me' || !isEchoOf(l, theirs()));
    if (transcript.length !== before) log('removed mic echo');
  }
  sendCaptions();
  return true;
}

async function transcribeLogged(who, samples, priority, label = '') {
  const t0 = Date.now();
  const text = await transcribers[who].transcribe(samples, { priority });
  const secs = (samples.length / 16000).toFixed(1);
  log(`transcribed ${label}${who} ${secs}s audio in ${Date.now() - t0}ms${DEBUG ? `: ${text}` : ` (${text.length} chars)`}`);
  return text;
}

// Early work started on a short pause, keyed by segment id. If the pause is
// confirmed, the transcript and suggestion are reused; if the person keeps
// talking, they're thrown away (never shown).
const speculations = new Map();

function speculate({ segId, samples, endedAt }) {
  const spec = {
    since: endedAt,
    cancelled: false,
    confirmed: false,
    started: false,     // a suggestion run picked this up
    buffered: [],       // suggestion events held back until confirmed
    checkedUpTo: 0,
  };
  // The other person's speech jumps the queue; early guesses go first of all.
  spec.textPromise = transcribeLogged('them', samples, 2, 'early ').catch(() => '');
  spec.cancel = () => {
    spec.cancelled = true;
    spec.buffered = [];
  };
  spec.confirm = () => {
    spec.confirmed = true;
    if (spec.checkedUpTo) live.checkedUpTo = Math.max(live.checkedUpTo, spec.checkedUpTo);    for (const [channel, data] of spec.buffered) {
      // Report when the suggestion actually appeared, not when it was drafted.
      if (channel === 'suggest:timing' && data.firstMs != null) data.firstMs = Date.now() - spec.since;
      win.webContents.send(channel, data);
    }
    spec.buffered = [];
    if (!spec.started) suggest({ since: spec.since }); // no free slot earlier: run it now
  };
  speculations.set(segId, spec);
  spec.textPromise.then((text) => {
    if (!text || spec.cancelled || !listening) return;
    suggest({ since: endedAt, extraLine: { who: 'them', text, at: endedAt }, gate: spec });
  });
}

async function onSegment(seg) {
  if (!listening) return;
  const { who, kind, segId } = seg;
  if (kind === 'cancel') {
    speculations.get(segId)?.cancel();
    speculations.delete(segId);
    return;
  }
  if (kind === 'tentative') {
    if (who === 'them') speculate(seg);
    return;
  }

  // Final: the utterance really ended.
  const spec = speculations.get(segId);
  speculations.delete(segId);
  try {
    if (spec) {
      const text = await spec.textPromise;
      if (!text || !listening) return spec.cancel();
      commitLine({ who, text, at: seg.endedAt });
      spec.confirm();
      return;
    }
    const text = await transcribeLogged(who, seg.samples, who === 'them' ? 1 : 0);
    if (!text || !listening) return;
    if (commitLine({ who, text, at: seg.endedAt }) && who === 'them') suggest({ since: seg.endedAt });
  } catch (err) {
    log('transcribe error:', err.message);
    win.webContents.send('listen:state', { on: listening, error: err.message });
  }
}

// Two warm live models, so an early guess that gets thrown away never holds
// up the real check.
const LIVE_SLOTS = ['live', 'live2'];
const slotBusy = {};
let suggestCounter = 0;

// Ask the live model whether the user needs to say something. It replies
// SKIP when nothing needs an answer; `force` (the "what should I say?"
// hotkey) always produces a suggestion. With `gate` (an early guess), output
// is held back until the gate is confirmed, and dropped if it's cancelled.
async function suggest({ force = false, since = Date.now(), extraLine = null, gate = null } = {}) {
  // The AI may be restarting (settings or knowledge change): wait for it,
  // except for early guesses, which are redone once the pause is confirmed.
  if (!provider && !providerError && !gate) await providerReady(15000);
  if (!provider || providerError) return;
  // Prefer a slot whose process isn't still starting up (it was just recycled).
  const slot = LIVE_SLOTS.find((s) => !slotBusy[s] && !provider.warming?.(s))
    || LIVE_SLOTS.find((s) => !slotBusy[s]);
  if (!slot) {
    if (gate) return; // skip the early guess; the confirmed pause runs a normal check
    live.pending = true;
    live.force = live.force || force;
    return;
  }
  const lines = extraLine ? [...transcript, extraLine] : transcript;
  if (!lines.length && !force) return;
  slotBusy[slot] = true;
  if (gate) gate.started = true;

  const id = ++suggestCounter;
  const send = (channel, data) => {
    if (gate?.cancelled) return;
    const msg = [channel, { id, ...data }];
    if (gate && !gate.confirmed) gate.buffered.push(msg);
    else win.webContents.send(...msg);
  };
  let buffer = '';
  let full = '';
  let decided = false;
  let skipped = false;
  let started = false;
  let firstMs = null;
  const emit = (s) => {
    if (skipped || !s) return;
    if (!started) {
      started = true;
      firstMs = Date.now() - since;
      send('suggest:start', { model: provider.tierName?.(slot) ?? provider.model });
      send('suggest:timing', { firstMs: Date.now() - since });
    }
    send('suggest:delta', { text: s });
  };
  const onText = (delta) => {
    full += delta;
    if (decided) return emit(delta);
    buffer += delta;
    const head = buffer.trimStart();
    if (head.length < 4 && 'SKIP'.startsWith(head)) return; // could still be SKIP
    decided = true;
    if (head.startsWith('SKIP')) skipped = true;
    else emit(buffer);
  };

  // Split the window into context and the lines that arrived since the last
  // check, so a follow-up question isn't mistaken for one already handled.
  const recent = lines.slice(-25);
  const older = recent.filter((l) => l.at <= live.checkedUpTo).map(fmtLine).join('\n');
  const fresh = recent.filter((l) => l.at > live.checkedUpTo).map(fmtLine).join('\n');
  const newest = recent.length ? recent[recent.length - 1].at : live.checkedUpTo;
  if (gate) gate.checkedUpTo = newest; // applied only if the guess is confirmed
  else live.checkedUpTo = newest;
  const text = [
    older && `Earlier (context only, already handled):\n${older}`,
    fresh && pastInterviews(fresh),
    `NEW since your last check (decide based on these):\n${fresh || '(nothing new)'}`,
    force && 'The user pressed "What should I say?". Do not reply SKIP: suggest the best thing to say or ask next.',
  ].filter(Boolean).join('\n\n');
  try {
    await provider.oneShot({ tier: slot, system: livePrompt(), text, onText });
    if (!decided && !buffer.trim().startsWith('SKIP')) emit(buffer);
    if (started) send('suggest:timing', { totalMs: Date.now() - since });
    const outcome = gate?.cancelled ? 'discarded (they kept talking)' : started ? 'shown' : 'skip';
    log(`suggest${gate ? ' (early)' : ''} [${slot}]: ${outcome} in ${Date.now() - since}ms${
      firstMs != null ? `, first words ${firstMs}ms` : ''}${
      DEBUG && started ? `: ${full.replace(/\n/g, ' | ').slice(0, 300)}` : ''}`);
  } catch (err) {
    // `stopped`: its model was restarted on purpose (Clear, settings change).
    if (!err.stopped) {
      log('suggest error:', err.message);
      if (!gate?.cancelled) win.webContents.send('listen:state', { on: listening, error: provider?.describeError(err) || err.message });
    }
  } finally {
    slotBusy[slot] = false;
    if (live.pending) {
      const f = live.force;
      live.pending = false;
      live.force = false;
      suggest({ force: f });
    }
  }
}

function toggleVisible() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  pushState();
}

// Overlay background opacity in percent (Settings slider, Ctrl+Alt+Up/Down).
const DEFAULT_OPACITY = 80;
const opacity = () => Number(process.env.GHOST_OPACITY) || DEFAULT_OPACITY;
function changeOpacity(delta) {
  const next = Math.min(100, Math.max(10, opacity() + delta));
  settings.save({ opacity: next === DEFAULT_OPACITY ? '' : String(next) });
  pushState();
}

function setStealth(on) {
  stealth = on;
  win.setContentProtection(on);
  win.setResizable(!on);
  pushState();
}

function resetSession() {
  currentAbort?.abort();
  provider?.reset?.();
  const lines = unlearned();
  learn(lines);
  takeNotes(lines);
  history = [];
  transcript = [];
  win.webContents.send('reset');
}

function moveBy(dx, dy) {
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

// Shown in the Keys panel, with whether each one registered (another app
// may already own it).
let hotkeys = [];

function registerShortcuts() {
  const step = 60;
  const defs = [
    ['Ctrl+Shift+Enter', 'Ask about your screen', { 'CommandOrControl+Shift+Enter': () => { win.showInactive(); ask({ withScreen: true }); } }],
    ['Ctrl+Shift+L', 'Start / stop listening to the call', { 'CommandOrControl+Shift+L': () => setListening(!listening) }],
    ['Ctrl+Shift+Space', 'What should I say? (suggest a reply now)', { 'CommandOrControl+Shift+Space': () => { win.showInactive(); suggest({ force: true }); } }],
    ['Ctrl+\\', 'Show / hide the overlay', { 'CommandOrControl+\\': toggleVisible }],
    ['Ctrl+Shift+Arrows', 'Move the overlay', {
      'CommandOrControl+Shift+Up': () => moveBy(0, -step),
      'CommandOrControl+Shift+Down': () => moveBy(0, step),
      'CommandOrControl+Shift+Left': () => moveBy(-step, 0),
      'CommandOrControl+Shift+Right': () => moveBy(step, 0),
    }],
    ['Ctrl+Alt+X', 'Click-through (mouse passes through)', { 'CommandOrControl+Alt+X': () => setClickThrough(!clickThrough) }],
    ['Ctrl+Alt+↑↓', 'Background more solid / more transparent', {
      'CommandOrControl+Alt+Up': () => changeOpacity(10),
      'CommandOrControl+Alt+Down': () => changeOpacity(-10),
    }],
    ['Ctrl+Shift+R', 'New session (clear history and transcript)', { 'CommandOrControl+Shift+R': resetSession }],
  ];
  hotkeys = defs.map(([keys, action, accels]) => {
    let ok = true;
    for (const [accel, fn] of Object.entries(accels)) {
      if (!globalShortcut.register(accel, fn)) { ok = false; log(`Could not register hotkey ${accel}`); }
    }
    return { keys, action, ok };
  });
}

ipcMain.handle('hotkeys:get', () => hotkeys);

ipcMain.handle('ask', (_e, payload) => ask(payload));
ipcMain.on('set-stealth', (_e, on) => setStealth(on));
ipcMain.on('set-learn', (_e, on) => { settings.save({ learn: on ? '' : '0' }); pushState(); });
ipcMain.on('set-click-through', (_e, on) => setClickThrough(on));
ipcMain.on('reset', resetSession);
ipcMain.on('hide', () => win.hide());

// ---------- Settings screen ----------

ipcMain.handle('settings:get', () => ({
  values: settings.current(),
  defaults: { provider: 'claude-code', ...DEFAULT_MODELS, ...speechModels() },
  speechModels: listModels(),
  file: settings.FILE,
}));

ipcMain.handle('settings:save', async (_e, values) => {
  const before = settings.current();
  settings.save(values);
  const after = settings.current();
  const changed = (...keys) => keys.some((k) => before[k] !== after[k]);
  log('settings saved:', Object.keys(after).filter((k) => before[k] !== after[k]).join(', ') || 'no changes');

  if (changed('provider', 'geminiKey', 'groqKey', 'anthropicKey', 'fastModel', 'balancedModel', 'deepModel', 'liveModel')) {
    currentAbort?.abort();
    provider?.shutdown?.();
    provider = null;
    await initProvider();
  }
  if (changed('meSpeech', 'themSpeech')) {
    stopTranscribers();
    makeTranscribers();
    if (listening) {
      try {
        await Promise.all([transcribers.them.ensureStarted(), transcribers.me.ensureStarted()]);
      } catch (err) {
        return { ok: false, message: err.message };
      }
    }
  }
  if (listening && changed('mic')) {
    await setListening(false);
    await setListening(true);
  }
  if (changed('stealth')) setStealth(after.stealth !== '0');
  else if (changed('opacity')) pushState();
  return providerError ? { ok: false, message: providerError } : { ok: true };
});

// ---------- Knowledge base ----------

const IMAGE_TO_TEXT = 'Transcribe all the text in this image exactly, keeping its structure (headings, bullet points, dates). If it is a photo of a document such as a resume, transcribe the document. Output only the transcription.';

// Restart the AI so its instructions include the current files.
async function reloadKnowledge() {
  currentAbort?.abort();
  provider?.shutdown?.();
  await initProvider();
}

ipcMain.handle('knowledge:list', () => knowledge.list());

// paths: files dropped onto the list; without them, show a file picker.
ipcMain.handle('knowledge:add', async (_e, paths) => {
  let filePaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!filePaths.length) {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Add to knowledge base',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents and images', extensions: knowledge.EXTENSIONS }],
    });
    filePaths = picked.canceled ? [] : picked.filePaths;
  }
  if (!filePaths.length) return { items: knowledge.list(), errors: [] };
  const errors = [];
  for (const file of filePaths) {
    try {
      const entry = await knowledge.add(file, {
        readImage: (image) => {
          if (!provider || providerError) throw new Error('The AI is not connected, so images can\'t be read.');
          return provider.readImage({ image, text: IMAGE_TO_TEXT });
        },
      });
      log('knowledge added:', entry.kind, entry.chars, 'chars');
    } catch (err) {
      log('knowledge add failed:', err.message);
      errors.push(err.message);
    }
  }
  if (errors.length < filePaths.length) await reloadKnowledge();
  return { items: knowledge.list(), errors };
});

ipcMain.handle('knowledge:remove', async (_e, id) => {
  knowledge.remove(id);
  await reloadKnowledge();
  return knowledge.list();
});

ipcMain.handle('brief:get', () => ({ text: knowledge.getBrief(), max: knowledge.MAX_BRIEF }));
ipcMain.handle('brief:set', async (_e, text) => {
  if (text.trim() === knowledge.getBrief().trim()) return { ok: true };
  const saved = knowledge.setBrief(text);
  log('brief', saved ? `set: ${saved.length} chars` : 'cleared');
  await reloadKnowledge();
  return providerError ? { ok: false, message: providerError } : { ok: true };
});

ipcMain.on('listen:toggle', () => setListening(!listening));
ipcMain.on('suggest', () => suggest({ force: true }));
ipcMain.on('audio:segment', (_e, segment) => onSegment(segment));
ipcMain.on('listen:started', (_e, { ok, failed }) => {
  if (!listening) return win.webContents.send('listen:stop'); // switched off while it was starting
  log('listening:', ok.join(' + '), failed.length ? `| FAILED: ${failed.join(' || ')}` : '');
  const missing = failed.map((f) => f.split(':')[0]);
  win.webContents.send('listen:state', missing.length
    ? { on: true, error: `Listening without ${missing.join(' and ')} (couldn't open it, see ghost.log)` }
    : { on: true, status: 'Listening · computer audio + mic' });
});
ipcMain.on('audio:stats', (_e, stats) => log('audio:', JSON.stringify(stats)));
ipcMain.on('listen:failed', (_e, message) => {
  log('audio capture failed:', message);
  listening = false;
  loopback.stop();
  updateTrayMenu();
  win.webContents.send('listen:state', { on: false, error: `Audio capture failed: ${message}` });
});

// If the app was force-closed (e.g. from Task Manager), its helper processes
// keep running. Stop leftovers from earlier runs: speech servers and audio
// helpers started from this folder, and Claude processes started with this
// app's instructions.
function cleanupOrphans() {
  if (process.platform !== 'win32') return;
  const root = path.join(__dirname, '..').replace(/'/g, "''");
  // Skips this run's own children (parent = this process), which may already be starting.
  const script = `
    $root = '${root}'
    $me = ${process.pid}
    $n = 0
    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -ne $me } | Where-Object {
      ($_.Name -in @('whisper-server.exe', 'loopback.exe') -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase')) -or
      ($_.Name -eq 'claude.exe' -and $_.CommandLine -match 'small overlay on the user|live conversation \\(a call|You transcribe documents accurately|You review interview transcripts')
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    $n`;
  const { execFile } = require('child_process');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
    const n = Number(String(stdout).trim());
    if (err) log('orphan cleanup failed:', err.message);
    else if (n) log('stopped', n, 'leftover helper process(es) from an earlier run');
  });
}

// One Ghostly at a time: a second launch shows the running overlay and exits.
if (!app.requestSingleInstanceLock()) {
  log('already running: showing the open overlay');
  app.exit(0);
}
app.on('second-instance', () => {
  if (win) showOverlay();
});

app.on('child-process-gone', (_e, d) => log('child process gone:', d.type, d.reason, d.exitCode));
app.on('before-quit', () => log('app before-quit'));

app.whenReady().then(() => {
  log('app ready');
  cleanupOrphans();
  // System audio: answer the overlay's getDisplayMedia() with Windows loopback
  // audio, and allow microphone access.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(([source]) => callback({ video: source, audio: 'loopback' }))
      .catch(() => callback({}));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture'].includes(permission));
  });
  createWindow();
  createTray();
  registerShortcuts();
  initProvider().then(learnPending);
});

app.on('will-quit', () => {
  // Learned on next start (too slow to do while quitting).
  for (const lines of learning) savePending(lines);
  if (learnOn()) savePending(unlearned());
  globalShortcut.unregisterAll();
  provider?.shutdown?.(); // stop claude-code child processes
  stopTranscribers();
  loopback.stop();
});
app.on('window-all-closed', () => app.quit());
