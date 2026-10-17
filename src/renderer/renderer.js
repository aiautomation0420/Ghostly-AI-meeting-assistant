const $ = (id) => document.getElementById(id);
const feed = $('feed');
const statusEl = $('status');
const dot = $('dot');
const input = $('input');
const withScreen = $('with-screen');
const stealthBtn = $('btn-stealth');

let state = { stealth: true, model: '', error: null };

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  dot.className = `dot ${kind}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal markdown: fenced code, inline code, bold, headings, bullet lists.
function renderMarkdown(md) {
  const parts = md.split(/```[\w-]*\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
    const inline = (s) => escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    let html = '';
    let inList = false;
    for (const line of part.split('\n')) {
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (bullet) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(bullet[1])}</li>`;
        continue;
      }
      if (inList) { html += '</ul>'; inList = false; }
      const heading = line.match(/^#{1,6}\s+(.*)/);
      if (heading) html += `<h4>${inline(heading[1])}</h4>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }).join('');
}

function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
}

function send() {
  const text = input.value;
  if (!text.trim() && !withScreen.classList.contains('on')) return;
  input.value = '';
  // "brief: …" sets the Brief instead of asking ("brief:" alone clears it).
  const brief = text.match(/^\s*\/?brief\s*:\s*([\s\S]*)$/i);
  if (brief) return saveBrief(brief[1]);
  window.ghost.ask({ text, withScreen: withScreen.classList.contains('on') });
}

withScreen.addEventListener('click', () => withScreen.classList.toggle('on'));
$('btn-learn').addEventListener('click', () => window.ghost.setLearn(!state.learn));

$('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('btn-screen').addEventListener('click', () => window.ghost.ask({ text: input.value, withScreen: true }).then(() => {}));
$('btn-clear').addEventListener('click', () => window.ghost.reset());
$('btn-hide').addEventListener('click', () => window.ghost.hide());
stealthBtn.addEventListener('click', () => window.ghost.setStealth(!state.stealth));

// Idle status. Green "Ready" only when a provider is actually connected.
function showIdle(prefix = 'Ready') {
  statusEl.title = state.error || '';
  if (state.error) setStatus(state.error, 'err');
  else if (state.clickThrough) setStatus('Click-through on (Ctrl+Alt+X to exit)');
  else if (state.model) setStatus(`${prefix} · ${state.model}`);
  else setStatus('Connecting…', 'busy');
}

window.ghost.onState((s) => {
  state = s;
  stealthBtn.classList.toggle('on', s.stealth);
  document.body.classList.toggle('stealth', s.stealth);
  $('btn-learn').classList.toggle('on', s.learn);
  $('btn-brief').classList.toggle('on', s.brief);
  showIdle();
});

// ---------- Brief ----------

const briefForm = $('brief');
const briefMsg = $('brief-msg');

async function openBrief() {
  if (!settingsForm.hidden) closeSettings();
  const { text, max } = await window.ghost.getBrief();
  briefForm.elements.text.value = text;
  briefForm.elements.text.maxLength = max;
  briefMsg.textContent = '';
  briefMsg.className = 'settings-msg';
  panelEl.classList.add('in-settings');
  briefForm.hidden = false;
  briefForm.elements.text.focus();
}

function closeBrief() {
  panelEl.classList.remove('in-settings');
  briefForm.hidden = true;
}

// Saving restarts the AI with the new brief (a second or two).
async function saveBrief(text) {
  setStatus(text.trim() ? 'Saving brief…' : 'Clearing brief…', 'busy');
  const result = await window.ghost.setBrief(text);
  if (!result.ok) return setStatus(result.message, 'err');
  setStatus(text.trim() ? 'Brief saved: answers will follow it' : 'Brief cleared');
  setTimeout(() => showIdle(), 2500);
}

$('btn-brief').addEventListener('click', () => (briefForm.hidden ? openBrief() : closeBrief()));
$('brief-cancel').addEventListener('click', closeBrief);
$('brief-clear').addEventListener('click', () => { briefForm.elements.text.value = ''; briefForm.elements.text.focus(); });
briefForm.elements.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); briefForm.requestSubmit(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !briefForm.hidden) closeBrief(); });
briefForm.addEventListener('submit', (e) => {
  e.preventDefault();
  closeBrief();
  saveBrief(briefForm.elements.text.value);
});

window.ghost.onStatus((text) => setStatus(text, 'busy'));

// An answer block: a small header (model · timing) above the streamed text.
function createBlock(model, extraClass = '') {
  const block = document.createElement('div');
  block.className = `block ${extraClass}`;
  const tag = document.createElement('div');
  tag.className = 'tag';
  const body = document.createElement('div');
  body.className = 'a';
  block.append(tag, body);
  feed.append(block);
  const b = { block, tag, body, text: '', model, firstMs: null, totalMs: null };
  renderTag(b);
  return b;
}

function renderTag(b) {
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [b.model];
  if (b.totalMs != null) parts.push(`done in ${secs(b.totalMs)}`);
  else if (b.firstMs != null) parts.push(`first words ${secs(b.firstMs)}`);
  else parts.push('…');
  if (b.totalMs != null && b.firstMs != null) parts.push(`first words ${secs(b.firstMs)}`);
  if (b.note && (b.firstMs != null || b.totalMs != null)) parts.push(b.note);
  b.tag.textContent = parts.filter(Boolean).join(' · ');
}

function appendText(b, delta) {
  if (!b) return;
  b.text += delta;
  b.body.innerHTML = renderMarkdown(b.text);
  scrollToBottom();
}

function showError(b, msg) {
  if (!b) return;
  b.body.classList.add('error');
  b.body.textContent = msg;
}

let quick = null; // the fast/first answer block
let deep = null;  // the follow-up deep answer block

window.ghost.onStart(({ question, withScreen: ws, model }) => {
  $('empty')?.remove();
  const q = document.createElement('div');
  q.className = 'q';
  q.textContent = `${ws ? '📸 ' : ''}${question}`;
  feed.append(q);
  quick = createBlock(model);
  deep = null;
  scrollToBottom();
});

window.ghost.onDelta((delta) => appendText(quick, delta));

window.ghost.onDeepStart(({ model }) => {
  deep = createBlock(model, 'deep');
  scrollToBottom();
});

window.ghost.onDeepDelta((delta) => {
  if (deep && !deep.text) quick?.block.classList.add('superseded');
  appendText(deep, delta);
});

window.ghost.onTiming(({ which, firstMs, totalMs }) => {
  const b = which === 'deep' ? deep : quick;
  if (!b) return;
  if (firstMs != null) b.firstMs = firstMs;
  if (totalMs != null) b.totalMs = totalMs;
  renderTag(b);
});

window.ghost.onDone(() => {
  showIdle();
  quick = deep = null;
});

window.ghost.onError((msg) => {
  setStatus('Error', 'err');
  showError(quick, msg);
});

window.ghost.onDeepError((msg) => {
  quick?.block.classList.remove('superseded');
  showError(deep, msg);
});

// ---------- Live audio ----------

const listenBtn = $('btn-listen');
const liveBar = $('live');
const liveLines = $('live-lines');

listenBtn.addEventListener('click', () => window.ghost.toggleListen());

function showLiveHint(text) {
  liveLines.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'hint';
  d.textContent = text;
  liveLines.append(d);
}

let statsTimer = null;
let capturing = false; // false once listening is switched off

async function startCapture(opts) {
  if (!capturing) return;
  try {
    const result = await window.audioCapture.start({
      ...opts,
      onSegment: (segment) => window.ghost.sendSegment(segment),
      // A track ended (e.g. headphones plugged in): restart capture.
      onEnded: (who) => {
        window.ghost.audioStats({ event: `${who} audio track ended, restarting` });
        window.audioCapture.stop();
        setTimeout(() => startCapture(opts), 500);
      },
    });
    if (!capturing) { // switched off while starting
      window.audioCapture.stop();
      return;
    }
    window.ghost.listenStarted(result);
    clearInterval(statsTimer);
    statsTimer = setInterval(() => window.ghost.audioStats({ sources: window.audioCapture.takeStats() }), 30000);
  } catch (err) {
    window.audioCapture.stop();
    window.ghost.listenFailed(err.message || String(err));
  }
}

window.ghost.onListenStart((opts) => {
  window.audioCapture.stop(); // never two captures at once
  capturing = true;
  startCapture(opts);
});
window.ghost.onPcm((samples) => window.audioCapture.pushExternal('them', samples));

window.ghost.onListenStop(() => {
  capturing = false;
  clearInterval(statsTimer);
  window.audioCapture.stop();
});

window.ghost.onListenState(({ on, status, error }) => {
  listenBtn.classList.toggle('on', on);
  liveBar.hidden = !on;
  if (error) setStatus(error, 'err');
  else if (status) setStatus(status, on ? '' : 'busy');
  else showIdle();
  if (on && !liveLines.children.length) showLiveHint('Listening… captions appear here.');
});

// Captions: main sends the latest few lines (echo-filtered).
window.ghost.onTranscript(({ lines }) => {
  liveLines.innerHTML = '';
  for (const { who, text } of lines) {
    const line = document.createElement('div');
    line.className = who;
    const label = document.createElement('b');
    label.textContent = who === 'them' ? 'Them: ' : 'You: ';
    line.append(label, text);
    liveLines.append(line);
  }
});

// Suggestions can overlap (two live models), so each has its own block by id.
const suggestions = new Map();

window.ghost.onSuggestStart(({ id, model }) => {
  $('empty')?.remove();
  const block = createBlock(`💬 Suggested reply · ${model}`, 'suggest');
  block.note = 'after they stopped talking';
  suggestions.set(id, block);
  while (suggestions.size > 20) suggestions.delete(suggestions.keys().next().value);
  scrollToBottom();
});

window.ghost.onSuggestDelta(({ id, text }) => appendText(suggestions.get(id), text));

window.ghost.onSuggestTiming(({ id, firstMs, totalMs }) => {
  const block = suggestions.get(id);
  if (!block) return;
  if (firstMs != null) block.firstMs = firstMs;
  if (totalMs != null) block.totalMs = totalMs;
  renderTag(block);
});

window.ghost.onReset(() => {
  feed.innerHTML = '';
  quick = deep = null;
  suggestions.clear();
  if (!liveBar.hidden) showLiveHint('Listening… captions appear here.');
  showIdle('New session');
});

// ---------- Settings ----------

const panelEl = document.querySelector('.panel');
const settingsForm = $('settings');
const settingsMsg = $('settings-msg');
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'];
let settingsDefaults = {};

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

function fillSelect(select, options, value) {
  select.innerHTML = '';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.append(o);
  }
  select.value = value;
  if (select.value !== value && options.length) select.value = options[0][0];
}

// Microphone names (Windows only reveals them after mic access is granted once).
async function listMics() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {}
  }
  return devices
    .filter((d) => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId))
    .map((d) => d.label)
    .filter(Boolean);
}

function showProviderFields() {
  const provider = settingsForm.elements.provider.value;
  settingsForm.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== provider; });
}

async function openSettings() {
  if (!briefForm.hidden) closeBrief();
  const { values, defaults, speechModels } = await window.ghost.getSettings();
  settingsDefaults = defaults;
  const f = settingsForm.elements;

  f.provider.value = values.provider || defaults.provider;
  for (const key of ['geminiKey', 'groqKey', 'anthropicKey', 'vocab']) f[key].value = values[key];

  for (const select of settingsForm.querySelectorAll('[data-models]')) {
    const tier = select.name.replace('Model', '');
    const options = CLAUDE_MODELS.map((m) => [m, `${capitalize(m)}${m === defaults[tier] ? ' (default)' : ''}`]);
    fillSelect(select, options, values[select.name] || defaults[tier]);
  }

  const speech = speechModels.length ? speechModels : ['base.en'];
  fillSelect(f.meSpeech, speech.map((m) => [m, m === 'small.en' ? `${m} (more accurate)` : m]), values.meSpeech || defaults.me);
  fillSelect(f.themSpeech, speech.map((m) => [m, m === 'base.en' ? `${m} (fastest)` : m]), values.themSpeech || defaults.them);

  const mics = await listMics();
  const micOptions = [['', 'Auto: headset mic, else Windows default'], ...mics.map((m) => [m, m])];
  if (values.mic && !mics.includes(values.mic)) micOptions.push([values.mic, `${values.mic} (not connected)`]);
  fillSelect(f.mic, micOptions, values.mic);

  f.stealth.checked = values.stealth !== '0';
  renderKnowledge(await window.ghost.listKnowledge());
  setKbBusy('');
  showProviderFields();
  settingsMsg.textContent = '';
  settingsMsg.className = 'settings-msg';
  panelEl.classList.add('in-settings');
  settingsForm.hidden = false;
}

function closeSettings() {
  panelEl.classList.remove('in-settings');
  settingsForm.hidden = true;
}

$('btn-settings').addEventListener('click', () => (settingsForm.hidden ? openSettings() : closeSettings()));
$('settings-cancel').addEventListener('click', closeSettings);
settingsForm.elements.provider.addEventListener('change', showProviderFields);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsForm.hidden) closeSettings(); });

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = settingsForm.elements;
  const d = settingsDefaults;
  // Store '' for "default" so future default changes still apply.
  const orDefault = (value, def) => (value === def ? '' : value);
  const values = {
    provider: orDefault(f.provider.value, d.provider),
    geminiKey: f.geminiKey.value,
    groqKey: f.groqKey.value,
    anthropicKey: f.anthropicKey.value,
    fastModel: orDefault(f.fastModel.value, d.fast),
    balancedModel: orDefault(f.balancedModel.value, d.balanced),
    deepModel: orDefault(f.deepModel.value, d.deep),
    liveModel: orDefault(f.liveModel.value, d.live),
    mic: f.mic.value,
    meSpeech: f.meSpeech.value,
    themSpeech: f.themSpeech.value,
    vocab: f.vocab.value,
    stealth: f.stealth.checked ? '' : '0',
  };
  settingsMsg.className = 'settings-msg';
  settingsMsg.textContent = 'Saving…';
  const result = await window.ghost.saveSettings(values);
  if (result.ok) {
    closeSettings();
  } else {
    settingsMsg.className = 'settings-msg err';
    settingsMsg.textContent = result.message;
  }
});

// ---------- Knowledge base (in Settings) ----------

const kbList = $('kb-list');
const kbMsg = $('kb-msg');
const kbAdd = $('kb-add');
const KIND_ICON = { pdf: '📄', text: '📝', image: '🖼️', interview: '🎙️' };

function renderKnowledge(items) {
  kbList.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'kb-empty';
    li.textContent = 'No files yet.';
    kbList.append(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'kb-name';
    name.textContent = `${KIND_ICON[item.kind] || '📄'} ${item.name}`;
    name.title = item.name;
    const size = document.createElement('span');
    size.className = 'kb-size';
    size.textContent = `${item.chars.toLocaleString()} chars`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.addEventListener('click', async () => {
      setKbBusy(`Removing ${item.name}…`);
      renderKnowledge(await window.ghost.removeKnowledge(item.id));
      setKbBusy('');
    });
    li.append(name, size, remove);
    kbList.append(li);
  }
}

function setKbBusy(message, isError = false) {
  kbMsg.textContent = message;
  kbMsg.className = `settings-msg${isError ? ' err' : ''}`;
  kbAdd.disabled = Boolean(message) && !isError;
}

async function addKnowledge(paths) {
  setKbBusy('Reading files… (images take a few seconds)');
  const { items, errors } = await window.ghost.addKnowledge(paths);
  renderKnowledge(items);
  setKbBusy(errors.join(' '), errors.length > 0);
}

kbAdd.addEventListener('click', () => addKnowledge());

// A file dropped anywhere else must not replace the overlay page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Drag files from Explorer onto the knowledge list.
kbList.addEventListener('dragover', (e) => {
  e.preventDefault();
  kbList.classList.add('drop');
});
kbList.addEventListener('dragleave', () => kbList.classList.remove('drop'));
kbList.addEventListener('drop', (e) => {
  e.preventDefault();
  kbList.classList.remove('drop');
  const paths = [...e.dataTransfer.files].map((f) => window.ghost.pathForFile(f));
  if (paths.length) addKnowledge(paths);
});
