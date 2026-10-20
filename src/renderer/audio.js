// Live audio capture: system audio ("them": the other people on a call) and
// the microphone ("me"), resampled to 16 kHz mono and cut into utterances
// at pauses. Each utterance is handed to onSegment for transcription.
//
// onSegment receives { who, kind, segId, samples, endedAt }:
//   kind 'tentative' — a short pause (250 ms): speech has probably ended, so
//                      work can start early
//   kind 'cancel'    — speech resumed after a tentative; discard that work
//   kind 'final'     — the utterance really ended (600 ms pause; ended: true)
//                      or hit the length limit mid-speech (ended: false: a
//                      piece of a long monologue, transcribed but not answered);
//                      same segId as its tentative, if any
//   kind 'ended'     — a long monologue ended with too little speech after
//                      its last piece to transcribe: time to answer it
// endedAt is when the speech itself stopped (not when the pause was confirmed).
window.audioCapture = (() => {
  const SAMPLE_RATE = 16000;
  const FRAME_MS = (128 / SAMPLE_RATE) * 1000; // one worklet frame = 8 ms
  const PREROLL_MS = 300;    // keep a little audio from before speech started
  const TENTATIVE_SILENCE_MS = 250; // pause that probably ends an utterance
  const END_SILENCE_MS = 600; // pause that ends an utterance
  const MAX_SEGMENT_MS = 12000; // Whisper's window is ~15 s; longer talk is sent in pieces
  const MIN_SPEECH_MS = 300;
  let segCounter = 0;

  let ctx = null;
  let streams = [];

  const FLOOR_WINDOW_MS = 1500;

  // Energy-based voice activity detection. The noise floor is the quietest
  // frame in the last 1.5 s: real speech always has short gaps between words,
  // so the floor tracks background noise and can't creep up to speech level
  // during long, continuous talking.
  class Segmenter {
    constructor(who, onSegment) {
      this.who = who;
      this.onSegment = onSegment;
      this.levels = new Float32Array(Math.round(FLOOR_WINDOW_MS / FRAME_MS)).fill(0.003);
      this.levelIndex = 0;
      this.preroll = [];
      this.frames = [];
      this.inSpeech = false;
      this.silenceMs = 0;
      this.speechMs = 0;
      this.segId = null;
      this.tentativeSent = false;
      this.pieceSent = false; // the current utterance already sent a length-limit piece
      this.stats = { frames: 0, segments: 0, floor: 0 };
    }

    samplesSoFar() {
      const samples = new Float32Array(this.frames.length * 128);
      this.frames.forEach((f, i) => samples.set(f, i * 128));
      return samples;
    }

    push(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      this.levels[this.levelIndex] = rms;
      this.levelIndex = (this.levelIndex + 1) % this.levels.length;
      let floor = Infinity;
      for (let i = 0; i < this.levels.length; i++) if (this.levels[i] < floor) floor = this.levels[i];
      floor = Math.min(floor, 0.05);
      const speech = rms > Math.max(0.006, floor * 2.5);
      this.stats.frames++;
      this.stats.floor = floor;

      if (!this.inSpeech) {
        this.preroll.push(frame);
        if (this.preroll.length * FRAME_MS > PREROLL_MS) this.preroll.shift();
        if (speech) {
          this.inSpeech = true;
          this.frames = this.preroll;
          this.preroll = [];
          this.silenceMs = 0;
          this.speechMs = FRAME_MS;
          this.segId = `${this.who}-${++segCounter}`;
          this.tentativeSent = false;
        }
        return;
      }

      this.frames.push(frame);
      if (speech) {
        this.speechMs += FRAME_MS;
        this.silenceMs = 0;
        if (this.tentativeSent) {
          // They kept talking: drop the early guess, start a fresh one later.
          this.onSegment({ who: this.who, kind: 'cancel', segId: this.segId });
          this.segId = `${this.who}-${++segCounter}`;
          this.tentativeSent = false;
        }
      } else {
        this.silenceMs += FRAME_MS;
      }
      const lengthMs = this.frames.length * FRAME_MS;
      if (this.silenceMs >= END_SILENCE_MS) {
        this.flush(true);
      } else if (lengthMs >= MAX_SEGMENT_MS && this.silenceMs === 0) {
        // Long monologue: send a piece, cut mid-speech so a pause still decides the end.
        this.flush(false);
      } else if (!this.tentativeSent && this.silenceMs >= TENTATIVE_SILENCE_MS && this.speechMs >= MIN_SPEECH_MS) {
        this.tentativeSent = true;
        this.onSegment({
          who: this.who, kind: 'tentative', segId: this.segId,
          samples: this.samplesSoFar(), endedAt: Date.now() - this.silenceMs,
        });
      }
    }

    flush(ended) {
      const samples = this.samplesSoFar();
      const speechMs = this.speechMs;
      const segId = this.segId;
      const endedAt = Date.now() - this.silenceMs;
      this.frames = [];
      this.speechMs = 0;
      this.silenceMs = 0;
      this.tentativeSent = false;
      this.segId = `${this.who}-${++segCounter}`; // a long monologue continues as a new segment
      const afterPiece = this.pieceSent;
      this.pieceSent = !ended;
      if (ended) this.inSpeech = false;
      if (speechMs < MIN_SPEECH_MS) {
        this.onSegment({ who: this.who, kind: 'cancel', segId });
        if (ended && afterPiece) this.onSegment({ who: this.who, kind: 'ended', endedAt });
        return;
      }
      this.stats.segments++;
      this.onSegment({ who: this.who, kind: 'final', ended, afterPiece, segId, samples, endedAt });
    }
  }

  async function getSystemAudio(sourceId) {
    const errors = [];
    // Preferred: getDisplayMedia, answered by main's display-media handler
    // with Windows loopback audio.
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      s.getVideoTracks().forEach((t) => t.stop());
      if (s.getAudioTracks().length) return { stream: s, via: 'displayMedia' };
      errors.push('displayMedia: no audio track');
    } catch (err) {
      errors.push(`displayMedia: ${err.name}: ${err.message}`);
    }
    // Fallback: Chromium's desktop-capture constraints (no user gesture needed).
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
      });
      s.getVideoTracks().forEach((t) => t.stop());
      return { stream: s, via: 'desktop' };
    } catch (err) {
      errors.push(`desktop: ${err.name}: ${err.message}`);
    }
    throw new Error(errors.join(' | '));
  }

  // Pick the microphone, in order of preference:
  //   1. one whose name contains micHint (GHOST_MIC setting)
  //   2. the mic of the headset you're listening on (same device name as the
  //      default output, e.g. "Mic (MCHOSE V9 PRO)" for "Speakers (MCHOSE V9 PRO)")
  //      — much clearer than a webcam or room mic
  //   3. the Windows default mic, then any other mic
  async function getMicrophone(micHint) {
    const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const open = (deviceId) => navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
    });
    const errors = [];

    // Open the default first: device names are only visible once mic access is granted.
    let fallback = null;
    try {
      fallback = await open(null);
    } catch (err) {
      errors.push(`default: ${err.name}: ${err.message}`);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId));
    const output = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')?.label || '';
    const outputName = (output.match(/\(([^()]+)\)\s*$/) || [])[1]; // "Speakers (X)" → "X"
    const lower = (s) => (s || '').toLowerCase();
    const preferred = [
      micHint && mics.find((m) => lower(m.label).includes(lower(micHint))),
      outputName && mics.find((m) => lower(m.label).includes(lower(outputName))),
    ].filter(Boolean);

    for (const mic of preferred) {
      try {
        const s = await open(mic.deviceId);
        fallback?.getTracks().forEach((t) => t.stop());
        return { stream: s, label: mic.label };
      } catch (err) {
        errors.push(`${mic.label}: ${err.name}`);
      }
    }
    if (fallback) return { stream: fallback, label: fallback.getAudioTracks()[0]?.label || 'default' };

    for (const mic of mics) {
      try {
        return { stream: await open(mic.deviceId), label: mic.label || mic.deviceId };
      } catch (err) {
        errors.push(`${mic.label || mic.deviceId}: ${err.name}`);
      }
    }
    throw new Error(errors.join(' | '));
  }

  let segmenters = [];
  const external = {}; // who → { segmenter, carry } for audio streamed in from main

  // Audio captured outside the page (the native Windows helper) arrives in
  // arbitrary-size chunks; cut it into the 128-sample frames the segmenter uses.
  function pushExternal(who, samples) {
    const ext = external[who];
    if (!ext) return;
    let data = samples;
    if (ext.carry.length) {
      data = new Float32Array(ext.carry.length + samples.length);
      data.set(ext.carry);
      data.set(samples, ext.carry.length);
    }
    let i = 0;
    for (; i + 128 <= data.length; i += 128) ext.segmenter.push(data.subarray(i, i + 128));
    ext.carry = data.slice(i);
  }

  async function attach(stream, who, onSegment, onEnded) {
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'capture', {
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const segmenter = new Segmenter(who, onSegment);
    segmenters.push(segmenter);
    node.port.onmessage = (e) => segmenter.push(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph running without playing anything
    source.connect(node).connect(mute).connect(ctx.destination);
    // e.g. the output device changed: let the caller restart capture.
    stream.getAudioTracks().forEach((t) => { t.onended = () => onEnded?.(who); });
  }

  return {
    Segmenter, // exposed for tests
    pushExternal,

    // Per-source counters since the last call (frames received, utterances, noise floor).
    takeStats() {
      const out = segmenters.map((s) => ({ who: s.who, ...s.stats, floor: Number(s.stats.floor.toFixed(4)) }));
      segmenters.forEach((s) => { s.stats.frames = 0; s.stats.segments = 0; });
      return out;
    },

    // nativeSystem: computer audio is captured by main's native helper and
    // streamed in via pushExternal, so skip capturing it here.
    async start({ sourceId, onSegment, onEnded, nativeSystem, micHint }) {
      segmenters = [];
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await ctx.audioWorklet.addModule('capture-worklet.js');
      // Each source is optional: one failing doesn't stop the other.
      const ok = [];
      const failed = [];
      if (nativeSystem) {
        const segmenter = new Segmenter('them', onSegment);
        segmenters.push(segmenter);
        external.them = { segmenter, carry: new Float32Array(0) };
        ok.push('computer audio (native)');
      } else {
        try {
          const system = await getSystemAudio(sourceId);
          streams.push(system.stream);
          await attach(system.stream, 'them', onSegment, onEnded);
          ok.push(`computer audio (${system.via})`);
        } catch (err) {
          failed.push(`computer audio: ${err.message}`);
        }
      }
      try {
        const mic = await getMicrophone(micHint);
        streams.push(mic.stream);
        await attach(mic.stream, 'me', onSegment, onEnded);
        ok.push(`mic: ${mic.label}`);
      } catch (err) {
        failed.push(`microphone: ${err.message}`);
      }
      if (!ok.length) throw new Error(failed.join(' || '));
      return { ok, failed };
    },

    stop() {
      streams.forEach((s) => s.getTracks().forEach((t) => { t.onended = null; t.stop(); }));
      streams = [];
      segmenters = [];
      delete external.them;
      ctx?.close();
      ctx = null;
    },
  };
})();
