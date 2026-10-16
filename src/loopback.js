// Native system-audio capture for Windows: runs native/loopback.exe, which
// records the default playback device and, if different, the default
// communication device that call apps use (any channel layout), mixes them
// and streams 16 kHz mono float32 PCM on stdout. Compiled on first use with the C#
// compiler that ships with Windows (.NET Framework 4).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NATIVE_DIR = path.join(__dirname, '..', 'native');
const SOURCE = path.join(NATIVE_DIR, 'loopback.cs');
const EXE = path.join(NATIVE_DIR, 'loopback.exe');
const CSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function ensureBuilt(log) {
  if (process.platform !== 'win32') throw new Error('Native loopback is Windows-only.');
  const exists = fs.existsSync(EXE);
  if (exists && fs.statSync(EXE).mtimeMs >= fs.statSync(SOURCE).mtimeMs) return;
  if (!fs.existsSync(CSC)) {
    if (exists) return;
    throw new Error('C# compiler (.NET Framework 4) not found.');
  }
  // Build next to the old exe, then swap: the old one may still be running.
  const tmp = `${EXE}.new`;
  execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', `/out:${tmp}`, SOURCE], { windowsHide: true });
  try {
    fs.renameSync(tmp, EXE);
    log('native loopback rebuilt');
  } catch (err) {
    if (!exists) throw err;
    log('native loopback: kept the previous build (in use):', err.code);
  }
}

function createLoopback({ log = () => {}, onPcm, onError }) {
  let proc = null;
  let stopped = true;
  let leftover = Buffer.alloc(0);
  let crashes = 0; // unexpected exits in a row

  function spawnHelper() {
    return new Promise((resolve, reject) => {
      const p = spawn(EXE, process.env.GHOST_LOOPBACK_TEST_DUAL ? ['--test-dual'] : [], { windowsHide: true });
      proc = p;
      leftover = Buffer.alloc(0);
      let started = false;
      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += d;
        const m = stderr.match(/format: ([^\r\n]+)/);
        if (m && !started) {
          started = true;
          log('native loopback started:', m[1]);
          resolve();
          setTimeout(() => { if (proc === p) crashes = 0; }, 10000); // ran fine: reset the crash count
        }
      });
      p.stdout.on('data', (chunk) => {
        // Re-align to whole float32 samples across chunk boundaries.
        const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
        const usable = buf.length - (buf.length % 4);
        leftover = buf.subarray(usable);
        if (usable) {
          const copy = Buffer.from(buf.subarray(0, usable)); // aligned copy
          onPcm(new Float32Array(copy.buffer, copy.byteOffset, usable / 4));
        }
      });
      p.on('error', (err) => { if (!started) reject(err); });
      p.on('exit', (code) => {
        const current = proc === p; // false if stopped or replaced by a newer helper
        if (current) proc = null;
        const why = stderr.trim().split(/\r?\n/).pop() || `exit ${code}`;
        if (!started) return reject(new Error(why));
        if (!current || stopped) return;
        const restart = (delay) => setTimeout(() => {
          if (!stopped && !proc) spawnHelper().catch((err) => onError(err));
        }, delay);
        if (code === 3) {
          // Default output device changed (e.g. headset switched on): follow it.
          log('native loopback: default device changed, restarting');
          restart(300);
        } else if (++crashes <= 3) {
          log(`native loopback stopped (${why}), retrying (${crashes}/3)`);
          restart(1000);
        } else {
          log('native loopback stopped:', why);
          onError(new Error(why));
        }
      });
    });
  }

  return {
    async start() {
      if (proc && !stopped) return; // already running
      ensureBuilt(log);
      stopped = false;
      crashes = 0;
      try {
        await spawnHelper();
      } catch (err) {
        stopped = true;
        throw err;
      }
    },
    stop() {
      stopped = true;
      proc?.kill();
      proc = null;
    },
  };
}

module.exports = { createLoopback };
