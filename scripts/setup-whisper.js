// Downloads whisper.cpp (local, free speech-to-text) and a speech model into ./whisper.
// Usage: npm run setup-whisper            (default model: base.en)
//        WHISPER_MODEL=small.en npm run setup-whisper
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RELEASE = 'b5454';
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-x64.zip`;
const MODEL = process.env.WHISPER_MODEL || 'base.en';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin`;
// Silero voice-activity model: skips non-speech so Whisper doesn't invent words from noise.
const VAD_FILE = 'ggml-silero-v6.2.0.bin';
const VAD_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_FILE}`;

const dir = path.join(__dirname, '..', 'whisper');
fs.mkdirSync(dir, { recursive: true });

async function download(url, dest) {
  if (fs.existsSync(dest)) {
    console.log(`✓ ${path.basename(dest)} already downloaded`);
    return;
  }
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== lastPct && pct % 10 === 0) { process.stdout.write(` ${pct}%`); lastPct = pct; }
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, dest);
  console.log(`\n✓ saved ${path.basename(dest)} (${(got / 1e6).toFixed(1)} MB)`);
}

function findServer(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findServer(p);
      if (found) return found;
    } else if (entry.name.toLowerCase() === 'whisper-server.exe') {
      return p;
    }
  }
  return null;
}

(async () => {
  const zip = path.join(dir, `whisper-bin-x64-${RELEASE}.zip`);
  await download(BIN_URL, zip);
  const binDir = path.join(dir, 'bin');
  if (!findServer(dir)) {
    fs.mkdirSync(binDir, { recursive: true });
    // Windows' own bsdtar handles .zip (Git Bash's GNU tar would read "D:" as a host).
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip, '-C', binDir]);
  }
  const server = findServer(dir);
  if (!server) throw new Error('whisper-server.exe not found in the download.');
  console.log(`✓ whisper-server: ${path.relative(process.cwd(), server)}`);

  await download(MODEL_URL, path.join(dir, `ggml-${MODEL}.bin`));
  await download(VAD_URL, path.join(dir, VAD_FILE));
  console.log('\nDone. Start the app with: npm start');
})().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
