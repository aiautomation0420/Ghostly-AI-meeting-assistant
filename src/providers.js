// AI backends. Each provider takes the same neutral history format:
//   { role: 'user', text, image }   (image = base64 JPEG or undefined)
//   { role: 'assistant', text, raw } (raw = provider-native content, optional)
// and streams text back through onText().

const { OpenAI } = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');

// OpenAI-compatible services. All have free options.
const PRESETS = {
  gemini: {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyVar: 'GEMINI_API_KEY',
    keyHelp: 'Get a free key at https://aistudio.google.com/apikey',
    // Newest stable "Flash" model (free tier); skip lite/image/audio variants.
    pickModel: (ids) => newest(ids.filter((id) => /^gemini-[\d.]+-flash(-preview)?$/.test(id))),
  },
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    keyVar: 'GROQ_API_KEY',
    keyHelp: 'Get a free key at https://console.groq.com/keys',
    // Needs a vision-capable model for screenshots.
    pickModel: (ids) => newest(ids.filter((id) => /llama-4|vision/i.test(id))),
  },
  ollama: {
    label: 'Ollama (local)',
    baseURL: (process.env.OLLAMA_HOST || 'http://localhost:11434') + '/v1',
    keyVar: null,
    keyHelp: 'Install Ollama from https://ollama.com, then run: ollama pull gemma3',
    pickModel: (ids) => ids.find((id) => /gemma3|vl|vision|llava|minicpm-v/i.test(id)) || ids[0],
  },
};

// Sort model ids by the version number in their name, newest first;
// stable models win over -preview ones of the same version.
function newest(ids) {
  const version = (id) => parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  return [...ids].sort((a, b) =>
    version(b) - version(a) || a.includes('preview') - b.includes('preview'))[0];
}

class ProviderError extends Error {}

// Error for a request cut off because its model was stopped on purpose
// (Clear, a settings change, quitting). Callers ignore it quietly.
function stoppedError() {
  const err = new ProviderError('stopped');
  err.stopped = true;
  return err;
}

// For services that resend the whole conversation each time: only the last
// few turns, and only the newest screenshot (older ones cost a lot and some
// services cap images per request). Starts on a user turn.
const MAX_TURNS = 11;
function recentTurns(history) {
  let start = Math.max(0, history.length - MAX_TURNS);
  if (history[start]?.role === 'assistant') start++;
  const turns = history.slice(start);
  const lastUser = turns.length - 1;
  return turns.map((t, i) => ((t.image && i !== lastUser) || t.hadImage
    ? { ...t, image: undefined, text: `[screenshot] ${t.text}` }
    : t));
}

function createOpenAICompatible(name, preset) {
  const apiKey = preset.keyVar ? process.env[preset.keyVar] : 'ollama';
  if (!apiKey) throw new ProviderError(`${preset.label} needs an API key: add it in Settings (⚙). ${preset.keyHelp}`);
  const client = new OpenAI({ apiKey, baseURL: preset.baseURL });
  let model = process.env.GHOST_MODEL;

  return {
    name,
    label: preset.label,
    get model() { return model; },

    async init() {
      if (model) return;
      try {
        const ids = [];
        for await (const m of client.models.list()) ids.push(m.id.replace(/^models\//, ''));
        model = preset.pickModel(ids);
      } catch (err) {
        throw new ProviderError(`Could not reach ${preset.label}: ${err.message}. ${preset.keyHelp}`);
      }
      if (!model) throw new ProviderError(`No suitable model found on ${preset.label}. Set GHOST_MODEL in .env to pick one.`);
    },

    async stream({ system, history, onText, signal }) {
      const messages = [{ role: 'system', content: system }];
      for (const turn of recentTurns(history)) {
        if (turn.role === 'assistant') {
          messages.push({ role: 'assistant', content: turn.text });
          continue;
        }
        const content = [];
        for (const image of [].concat(turn.image || [])) {
          content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } });
        }
        content.push({ type: 'text', text: turn.text });
        messages.push({ role: 'user', content });
      }

      const stream = await client.chat.completions.create(
        { model, messages, stream: true },
        { signal },
      );
      let text = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(delta);
        }
      }
      return { text };
    },

    // Read all text from an image (a photo or screenshot of a document).
    async readImage({ image, text }) {
      const r = await this.stream({
        system: 'You transcribe documents accurately.',
        history: [{ role: 'user', text, image }],
        onText() {},
        signal: new AbortController().signal,
      });
      return r.text;
    },

    oneShot({ system, text, onText, signal }) {
      return this.stream({ system, history: [{ role: 'user', text }], onText, signal });
    },

    async complete({ system, text }) {
      return (await this.oneShot({ system, text, onText() {}, signal: new AbortController().signal })).text;
    },

    describeError(err) {
      if (err instanceof OpenAI.AuthenticationError || err?.status === 400 && /api key/i.test(err.message)) {
        return `Invalid ${preset.keyVar}. ${preset.keyHelp}`;
      }
      if (err instanceof OpenAI.RateLimitError) return 'Free-tier rate limit hit. Wait a minute and try again.';
      if (err instanceof OpenAI.APIConnectionError) return `Can't reach ${preset.label}. Check your connection${name === 'ollama' ? ' and that Ollama is running' : ''}.`;
      return err.message;
    },
  };
}

function createAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ProviderError('The Claude API needs an API key: add it in Settings (⚙). Get one at https://console.anthropic.com');
  }
  const client = new Anthropic();
  const model = process.env.GHOST_MODEL || 'claude-opus-5-5';
  // Low effort keeps answers fast enough for live conversations.
  const effort = process.env.GHOST_EFFORT || 'low';

  return {
    name: 'anthropic',
    label: 'Claude',
    model,
    async init() {},

    async stream({ system, history, onText, signal }) {
      const messages = recentTurns(history).map((turn) => {
        if (turn.role === 'assistant') return { role: 'assistant', content: turn.raw ?? turn.text };
        const content = [];
        for (const image of [].concat(turn.image || [])) {
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
        }
        content.push({ type: 'text', text: turn.text });
        return { role: 'user', content };
      });

      const stream = client.beta.messages.stream({
        model,
        max_tokens: 16000,
        system,
        output_config: { effort },
        // Server-side fallback: if the model declines for policy reasons, the
        // API retries on a default substitute model instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages,
      }, { signal });
      stream.on('text', (delta) => onText(delta));
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new ProviderError('The model declined this request.');
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      // Keep the full content (not just text) so the history stays valid.
      return { text, raw: message.content };
    },

    // Read all text from an image (a photo or screenshot of a document).
    async readImage({ image, text }) {
      const r = await this.stream({
        system: 'You transcribe documents accurately.',
        history: [{ role: 'user', text, image }],
        onText() {},
        signal: new AbortController().signal,
      });
      return r.text;
    },

    oneShot({ system, text, onText, signal }) {
      return this.stream({ system, history: [{ role: 'user', text }], onText, signal });
    },

    async complete({ system, text }) {
      return (await this.oneShot({ system, text, onText() {}, signal: new AbortController().signal })).text;
    },

    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return 'Invalid ANTHROPIC_API_KEY.';
      if (err instanceof Anthropic.RateLimitError) return 'Rate limited. Try again in a moment.';
      if (err instanceof Anthropic.APIConnectionError) return 'Network error reaching the Claude API.';
      return err.message;
    },
  };
}

// Uses the locally installed Claude Code CLI, which runs on the user's own
// Claude subscription (no API key). Keeps one warm `claude -p` process per
// tier so switching models is instant:
//   fast     → quick screen reads (and flags hard problems for "deep")
//   balanced → typed follow-ups
//   deep     → full solutions for hard problems
//   live     → reply suggestions while listening to audio
// Read when the provider is created, so changes in Settings apply on restart.
const DEFAULT_MODELS = { live: 'haiku', fast: 'haiku', balanced: 'sonnet', deep: 'opus' };

function readTiers() {
  const tier = (envVar, fallback, effort) => {
    const model = process.env[envVar] || fallback;
    return { model, effort, name: model[0].toUpperCase() + model.slice(1) };
  };
  return {
    live: tier('GHOST_LIVE_MODEL', DEFAULT_MODELS.live, 'low'),
    live2: tier('GHOST_LIVE_MODEL', DEFAULT_MODELS.live, 'low'), // second live slot
    fast: tier('GHOST_FAST_MODEL', DEFAULT_MODELS.fast, 'low'),
    balanced: tier('GHOST_BALANCED_MODEL', DEFAULT_MODELS.balanced, 'low'),
    deep: tier('GHOST_DEEP_MODEL', DEFAULT_MODELS.deep, 'medium'),
    util: tier('GHOST_UTIL_MODEL', 'sonnet', 'low'), // one-off jobs, e.g. reading text from an image
  };
}

function createClaudeCode() {
  const TIERS = readTiers();
  const { spawn } = require('child_process');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const readline = require('readline');

  const bin = process.env.CLAUDE_PATH || 'claude';
  const cwd = path.join(os.tmpdir(), 'ghost-overlay'); // neutral dir: no project files/context
  fs.mkdirSync(cwd, { recursive: true });
  const CLI_MISSING = 'Claude Code CLI not found. Install it from https://claude.com/claude-code and run `claude` once to log in.';

  function cleanEnv() {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  // One long-lived CLI process for one model. The CLI keeps its own
  // conversation; `seen` counts how much of the shared history it has, so
  // turns answered by other models can be passed along as text.
  class Worker {
    // warm: send the startup message (skipped for one-off requests).
    constructor(tier, system, { warm = true } = {}) {
      this.tier = tier;
      this.system = system;
      this.warm = warm;
      this.modelId = null;
      this.start();
    }

    start() {
      const { model, effort } = TIERS[this.tier];
      const args = [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--include-partial-messages',
        '--tools', '', '--setting-sources', '', '--strict-mcp-config',
        '--disable-slash-commands', '--no-session-persistence',
        '--model', model, '--effort', process.env.GHOST_EFFORT || effort,
        '--system-prompt', this.system,
      ];
      this.seen = 0;
      this.calls = 0;
      this.turn = null;
      this.stderr = '';
      const proc = spawn(bin, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = proc;
      proc.stdin.on('error', () => {}); // process died mid-write; 'exit' reports it
      proc.stderr.on('data', (d) => { this.stderr += d; });
      proc.on('error', (err) => this.fail(new ProviderError(err.code === 'ENOENT' ? CLI_MISSING : err.message)));
      proc.on('exit', (code) => this.fail(new ProviderError(`Claude Code exited (${code}). ${this.stderr.trim().slice(-300)}`)));
      readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
      // The CLI only finishes starting up on its first message (~2-3 s), so
      // send a throwaway one now; real requests wait for it (see send).
      if (!this.warm) return;
      const warming =this.write([{ type: 'text', text: 'Connection check: reply with just OK.' }], () => {})
        .catch(() => {})
        .finally(() => { if (this.warming === warming) this.warming = null; });
      this.warming = warming;
    }

    fail(err) {
      const t = this.turn;
      this.turn = null;
      this.proc = null;
      this.lastError = err;
      t?.reject(err);
    }

    stop() {
      // Settle any request in flight, or its caller would wait forever.
      const t = this.turn;
      this.turn = null;
      t?.reject(stoppedError());
      this.warming = null;
      if (!this.proc) return;
      this.proc.removeAllListeners('exit');
      this.proc.kill();
      this.proc = null;
    }

    restart() {
      this.stop();
      this.start();
    }

    onLine(line) {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'system' && msg.model) this.modelId = msg.model;
      const t = this.turn;
      if (!t) return;
      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta'
          && msg.event.delta?.type === 'text_delta') {
        t.text += msg.event.delta.text;
        t.onText(msg.event.delta.text);
      } else if (msg.type === 'result') {
        this.turn = null;
        if (msg.is_error || msg.subtype !== 'success') {
          t.reject(new ProviderError(msg.result || `Claude Code error: ${msg.subtype}`));
        } else {
          t.resolve({ text: t.text || msg.result || '' });
        }
      }
    }

    async send(content, onText) {
      if (!this.proc) this.start();
      while (this.warming) await this.warming; // loops if it restarted meanwhile
      if (!this.proc) { this.start(); while (this.warming) await this.warming; } // died while starting: one retry
      if (!this.proc) throw this.lastError || new ProviderError('Claude Code failed to start.');
      return this.write(content, onText);
    }

    write(content, onText) {
      return new Promise((resolve, reject) => {
        this.turn = { onText, resolve, reject, text: '' };
        this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      });
    }
  }

  const workers = {};

  function prettyName(tier) {
    const id = workers[tier]?.modelId; // e.g. claude-haiku-5-5
    const m = id && id.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/);
    if (!m) return TIERS[tier].name;
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  }

  return {
    name: 'claude-code',
    label: 'Claude',
    tiers: true,
    get model() { return `${prettyName('fast')} → ${prettyName('deep')} · ${prettyName('balanced')}`; },
    tierName: prettyName,

    async init() {
      // Fail fast if the CLI is missing.
      await new Promise((resolve, reject) => {
        const p = spawn(bin, ['--version'], { env: cleanEnv(), windowsHide: true });
        p.on('error', () => reject(new ProviderError(CLI_MISSING)));
        p.on('exit', resolve);
      });
    },

    // Start these tiers' processes now so the first question doesn't pay startup.
    warm(systemByTier) {
      for (const [tier, system] of Object.entries(systemByTier)) {
        workers[tier]?.stop();
        workers[tier] = new Worker(tier, system);
      }
    },

    // True while a tier's process is still starting up; a request sent then
    // waits for it (~3 s to first words instead of ~1 s).
    warming(tier) {
      return Boolean(workers[tier]?.warming);
    },

    // Start one tier's process if it isn't running yet.
    prepare(tier, system) {
      if (!workers[tier]) workers[tier] = new Worker(tier, system);
    },

    // A standalone request: the caller sends all the context it needs in
    // `text`. The process is recycled every few calls so its own growing
    // conversation doesn't slow it down.
    async oneShot({ tier, system, text, onText, signal }) {
      this.prepare(tier, system);
      const worker = workers[tier];
      const onAbort = () => {
        const t = worker.turn;
        worker.turn = null;
        worker.restart();
        t?.reject(new ProviderError('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await worker.send([{ type: 'text', text }], onText);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (++worker.calls >= 10) worker.restart();
      }
    },

    async stream({ tier = 'balanced', history, onText, signal }) {
      const worker = workers[tier];
      if (!worker) throw new ProviderError('Still connecting, try again in a second.');
      if (!worker.proc) worker.restart(); // it crashed or was stopped
      const content = [];
      // Pass along turns this model hasn't seen (answered by other models,
      // or lost when the process restarted), as text: up to the last 40
      // (about 20 questions and answers).
      const from = Math.max(worker.seen, history.length - 41);
      const missed = history.slice(from, -1)
        .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.image || t.hadImage ? '[screenshot] ' : ''}${t.text}`)
        .join('\n\n');
      if (missed) content.push({ type: 'text', text: `Earlier in this conversation:\n\n${missed}` });
      const last = history[history.length - 1];
      for (const image of [].concat(last.image || [])) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
      }
      content.push({ type: 'text', text: last.text });

      const onAbort = () => {
        // The CLI can't cancel mid-turn over stdin; restart it warm.
        const t = worker.turn;
        worker.turn = null;
        worker.restart();
        t?.reject(new ProviderError('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await worker.send(content, onText);
        worker.seen = history.length + 1; // the answer main is about to append
        // The CLI keeps every turn (screenshots included), so a long session
        // gets slower: start fresh every 12 questions, ready for the next one.
        // Recent turns are then replayed as text (see `missed` above).
        if (++worker.calls >= 12) worker.restart();
        return result;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },

    reset() {
      for (const w of Object.values(workers)) w.restart();
    },

    // Read all text from an image, using a temporary worker that's stopped afterwards.
    async readImage({ image, text }) {
      const worker = new Worker('util', 'You transcribe documents accurately.', { warm: false });
      const timeout = setTimeout(() => worker.fail(new ProviderError('Reading the image took too long.')), 120000);
      try {
        const r = await worker.send([
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text },
        ], () => {});
        return r.text;
      } finally {
        clearTimeout(timeout);
        worker.stop();
      }
    },

    // One-off text job on a temporary worker, so the warm ones aren't disturbed.
    async complete({ system, text }) {
      const worker = new Worker('util', system, { warm: false });
      const timeout = setTimeout(() => worker.fail(new ProviderError('The AI took too long.')), 300000);
      try {
        return (await worker.send([{ type: 'text', text }], () => {})).text;
      } finally {
        clearTimeout(timeout);
        worker.stop();
      }
    },

    shutdown() {
      for (const w of Object.values(workers)) w.stop();
    },

    describeError(err) { return err.message; },
  };
}

function createProvider() {
  const name = (process.env.AI_PROVIDER || 'claude-code').toLowerCase();
  if (name === 'claude-code' || name === 'subscription') return createClaudeCode();
  if (name === 'anthropic' || name === 'claude') return createAnthropic();
  const preset = PRESETS[name];
  if (!preset) throw new ProviderError(`Unknown AI_PROVIDER "${name}". Use claude-code, gemini, groq, ollama, or anthropic.`);
  return createOpenAICompatible(name, preset);
}

module.exports = { createProvider, ProviderError, DEFAULT_MODELS };
