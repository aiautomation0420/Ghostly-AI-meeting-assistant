// Local speech-to-text with whisper.cpp's server (free, offline, private).
// The model is loaded once; each speech segment is POSTed as a 16 kHz WAV.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const net = require('net');

const WHISPER_DIR = path.join(__dirname, '..', 'whisper');
const SAMPLE_RATE = 16000;

// A fresh free port each start, so a leftover server from a crashed run
// can't answer in place of ours.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Whisper's typical output on silence or noise.
const JUNK = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|thank you\.?|thanks for watching!?|you|\.+|bye\.?)\s*$/i;

function findFile(root, test) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, test);
      if (found) return found;
    } else if (test(entry.name)) {
      return p;
    }
  }
  return null;
}

function toWav(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Is this speech model downloaded? (e.g. 'small.en')
function hasModel(name) {
  return Boolean(findFile(WHISPER_DIR, (n) => n === `ggml-${name}.bin`));
}

// Names of the downloaded speech models, e.g. ['base.en', 'small.en'].
function listModels() {
  if (!fs.existsSync(WHISPER_DIR)) return [];
  return fs.readdirSync(WHISPER_DIR)
    .map((n) => (n.match(/^ggml-(?!silero)(.+)\.bin$/) || [])[1])
    .filter(Boolean);
}

// model: e.g. 'base.en' (default: the first model found). threads: CPU
// threads for this server (default: all but two).
function createTranscriber({ log = () => {}, model: modelName, threads: threadCount } = {}) {
  let proc = null;
  let ready = null;
  let port = 0;
  const jobs = [];   // pending { samples, priority, resolve, reject }
  let running = false;

  async function start() {
    port = await freePort();
    const server = findFile(WHISPER_DIR, (n) => n.toLowerCase() === 'whisper-server.exe' || n === 'whisper-server');
    const model = findFile(WHISPER_DIR, (n) => (modelName ? n === `ggml-${modelName}.bin` : /^ggml-(?!silero).*\.bin$/.test(n)));
    const vad = findFile(WHISPER_DIR, (n) => /^ggml-silero.*\.bin$/.test(n));
    if (!server || !model) {
      return Promise.reject(new Error(modelName && server
        ? `Speech model ${modelName} not installed. Run: WHISPER_MODEL=${modelName} npm run setup-whisper`
        : 'Speech-to-text not installed. Run: npm run setup-whisper'));
    }
    const threads = String(threadCount || Math.max(2, Math.min(8, os.cpus().length - 2)));
    const args = [
      '-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', threads, '-nt',
      // Whisper normally encodes a full 30 s window even for a 2 s phrase. A
      // ~15 s window (768 × 20 ms) covers our longest segment (12 s) and
      // roughly halves transcription time.
      '-ac', '768',
    ];
    // Voice-activity detection: Whisper skips non-speech instead of inventing words from noise.
    if (vad) args.push('--vad', '-vm', vad);
    if (process.env.WHISPER_ARGS) args.push(...process.env.WHISPER_ARGS.split(/\s+/).filter(Boolean));
    const p = spawn(server, args, { cwd: path.dirname(server), windowsHide: true });
    proc = p;
    let output = '';
    p.stdout.on('data', (d) => { output += d; });
    p.stderr.on('data', (d) => { output += d; });
    p.on('exit', (code) => {
      log('whisper-server exited:', code, output.trim().split('\n').slice(-3).join(' | '));
      if (proc !== p) return; // an old server, already replaced
      proc = null;
      ready = null; // the next request starts a new one
    });
    log('whisper-server starting:', path.basename(model), 'threads', threads, vad ? '+ VAD' : '(no VAD)');

    // Poll until the HTTP server answers (model load takes a second or two).
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = async () => {
        if (!proc) return reject(new Error(`Speech-to-text failed to start: ${output.trim().slice(-300)}`));
        try {
          await fetch(`http://127.0.0.1:${port}/`);
          log('whisper-server ready in', Date.now() - t0, 'ms');
          return resolve();
        } catch {}
        if (Date.now() - t0 > 30000) return reject(new Error('Speech-to-text took too long to start.'));
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  async function request(samples) {
    const form = new FormData();
    form.append('file', new Blob([toWav(samples)], { type: 'audio/wav' }), 'audio.wav');
    form.append('temperature', '0.0');
    // Optional words Whisper should expect (names, jargon), e.g. "display, overlay, Electron".
    if (process.env.GHOST_VOCAB) form.append('prompt', process.env.GHOST_VOCAB);
    form.append('response_format', 'json');
    // A stuck server must not block every later phrase.
    const res = await fetch(`http://127.0.0.1:${port}/inference`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
    const { text = '' } = await res.json();
    const clean = text.replace(/\s+/g, ' ').trim();
    return JUNK.test(clean) ? '' : clean;
  }

  return {
    ensureStarted() {
      if (!ready) ready = start().catch((err) => { ready = null; throw err; });
      return ready;
    },

    // Float32Array of 16 kHz mono samples → text ('' for silence/noise).
    // One request at a time (the server is single-threaded per request);
    // higher-priority jobs jump the queue.
    transcribe(samples, { priority = 0 } = {}) {
      return new Promise((resolve, reject) => {
        jobs.push({ samples, priority, resolve, reject });
        jobs.sort((a, b) => b.priority - a.priority);
        this.drain();
      });
    },

    async drain() {
      if (running) return;
      running = true;
      while (jobs.length) {
        const job = jobs.shift();
        try {
          await this.ensureStarted();
          job.resolve(await request(job.samples));
        } catch (err) {
          // Timed out or crashed: restart the server so the next phrase works.
          if (err.name === 'TimeoutError' || err.name === 'TypeError') this.stop();
          job.reject(err);
        }
      }
      running = false;
    },

    stop() {
      proc?.kill();
      proc = null;
      ready = null;
    },
  };
}

module.exports = { createTranscriber, hasModel, listModels, SAMPLE_RATE };
