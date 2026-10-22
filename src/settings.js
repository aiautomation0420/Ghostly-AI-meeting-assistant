// User settings from the in-app settings screen, saved as JSON in the app's
// data folder (%APPDATA%\ghost-overlay\settings.json on Windows).
//
// Every setting maps to the environment variable the rest of the app reads,
// so saved settings simply override .env. An empty value means "default".
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ENV = {
  provider: 'AI_PROVIDER',
  geminiKey: 'GEMINI_API_KEY',
  groqKey: 'GROQ_API_KEY',
  anthropicKey: 'ANTHROPIC_API_KEY',
  fastModel: 'GHOST_FAST_MODEL',
  balancedModel: 'GHOST_BALANCED_MODEL',
  deepModel: 'GHOST_DEEP_MODEL',
  liveModel: 'GHOST_LIVE_MODEL',
  mic: 'GHOST_MIC',
  vocab: 'GHOST_VOCAB',
  meSpeech: 'WHISPER_MODEL_ME',
  themSpeech: 'WHISPER_MODEL_THEM',
  pause: 'GHOST_PAUSE_MS', // how long the other person must pause before Ghostly answers
  stealth: 'GHOST_STEALTH',
  opacity: 'GHOST_OPACITY', // overlay background opacity in percent (text stays solid)
  learn: 'GHOST_LEARN', // '0' = don't save interviews to the knowledge base
  notes: 'GHOST_NOTES', // '0' = don't save notes after a call
};

const FILE = path.join(app.getPath('userData'), 'settings.json');
let saved = {};

function applyToEnv() {
  for (const [key, envVar] of Object.entries(ENV)) {
    if (!(key in saved)) continue; // never set in the app: keep .env's value
    const value = saved[key];
    if (value === '' || value == null) delete process.env[envVar];
    else process.env[envVar] = String(value);
  }
}

function load() {
  try {
    saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    saved = {};
  }
  applyToEnv();
}

// Effective values (saved settings, else .env, else '' for default).
function current() {
  const out = {};
  for (const [key, envVar] of Object.entries(ENV)) out[key] = process.env[envVar] || '';
  return out;
}

function save(values) {
  for (const key of Object.keys(ENV)) {
    if (key in values) saved[key] = typeof values[key] === 'string' ? values[key].trim() : values[key];
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(saved, null, 2));
  applyToEnv();
}

module.exports = { load, current, save, FILE };
