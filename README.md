# Ghostly-AI meeting assistant

A Cluely-style AI meeting assistant for Windows: a translucent, always-on-top overlay that sees your screen, listens to your calls (Zoom, Google Meet, Teams, Skype, Discord), and suggests answers in real time — drawing on your own resume and notes.

## Setup

```bash
npm install
npm run setup-whisper   # one-time: local speech-to-text (~160 MB)
npm start
```

By default it uses your Claude subscription through the installed Claude Code CLI (`claude`), so no API key is needed.

## Settings

Click **⚙** on the overlay to choose the AI service (and its key), which Claude model handles each job, the microphone, speech models, hint words, the knowledge base, and stealth.

**Knowledge base:** add your resume, notes or docs (PDF, TXT, MD, PNG, JPG) with **+ Add file** or by dragging files onto the list. Text is extracted once (PDF/TXT locally; images are read by the AI) and stored in `%APPDATA%\ghost-overlay\knowledge`. It's included with every request, so answers draw on it, e.g. live suggestions reply with your real experience. Scanned PDFs have no text layer: add a screenshot/photo of them instead. Up to 60,000 characters are used. Changes apply immediately and are saved to `%APPDATA%\ghost-overlay\settings.json`, overriding `.env` (which still works for anything not set in the app).

## Hotkeys

| Keys | Action |
|---|---|
| `Ctrl+Shift+Enter` | Screenshot the current screen and ask about it |
| `Ctrl+Shift+L` | Start / stop listening to audio |
| `Ctrl+Shift+Space` | "What should I say?" — suggest a reply now |
| `Ctrl+\` | Show / hide overlay |
| `Ctrl+Shift+Arrows` | Move overlay |
| `Ctrl+Alt+X` | Toggle click-through (mouse passes through) |
| `Ctrl+Shift+R` | New session (clear history and transcript) |

Type in the box at the bottom for follow-ups; untick **screen** to ask without a screenshot.

The overlay has no taskbar button. Use the **tray icon** (indigo dot, bottom-right; may be under the `^` arrow) to show it, reset its position, toggle modes, or quit.

**Stealth** (on by default) hides the overlay from screenshots and screen sharing via Electron's `setContentProtection` (Windows 10 2004+ / macOS).

## Live audio

**Listen** captures system audio (the other people on a call, labelled "Them") and your microphone ("You"). Speech is transcribed locally by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with a Silero voice-activity model, so audio never leaves your PC. When Them pauses for 0.25 s, transcription and a draft suggestion start early; the draft is shown only once the pause reaches 0.6 s (they really stopped), and is discarded if they keep talking. A second warm live model ensures a discarded draft never delays the real one. While listening, screen and typed questions also include the recent transcript.

On Windows, computer audio is captured by a small native helper (`native/loopback.cs`, compiled automatically on first use with the C# compiler built into Windows). It records whatever the default output device plays — stereo speakers, 7.1 gaming headsets, Bluetooth — plus the default *communication* device that call apps (Zoom, Teams, Skype, Discord) often use, mixing both when they differ. It follows you when you switch devices mid-call. If it can't run, the app falls back to Chromium's built-in capture.

Use headphones if you can: with speakers the mic also hears the other person. Echoed lines are filtered out, but headphones give cleaner captions.

Speech-to-text uses two models: the fast `base.en` for the other person (keeps suggestions quick) and the more accurate `small.en` for your own mic, if installed (`WHISPER_MODEL=small.en npm run setup-whisper`). Override with `WHISPER_MODEL_THEM` / `WHISPER_MODEL_ME`. The mic defaults to your headset's mic (matched by name to the default output device), else the Windows default; set `GHOST_MIC` to pick one by name. `GHOST_VOCAB` lists words speech-to-text should expect (names, jargon).

## Models (claude-code provider)

Each role keeps a warm `claude` process so switching is instant:

| Role | Default | Used for |
|---|---|---|
| fast | Haiku | Screenshot questions; flags hard problems |
| deep | Opus | Full answer when the fast model flags a hard problem |
| balanced | Sonnet | Typed questions |
| live | Haiku | Reply suggestions while listening |

Override with `GHOST_FAST_MODEL`, `GHOST_DEEP_MODEL`, `GHOST_BALANCED_MODEL`, `GHOST_LIVE_MODEL`.

## Other AI providers

| Provider | Cost | Key |
|---|---|---|
| `claude-code` (default) | Your Claude plan's usage | none — needs `claude` installed and logged in |
| `gemini` | Free tier | `GEMINI_API_KEY` from https://aistudio.google.com/apikey |
| `groq` | Free tier | `GROQ_API_KEY` from https://console.groq.com/keys |
| `ollama` | Free, runs locally | none — install Ollama, `ollama pull gemma3` |
| `anthropic` | Paid | `ANTHROPIC_API_KEY` |

With these, one model handles everything (no fast/deep routing); the newest suitable vision model is picked automatically, or set `GHOST_MODEL`.

## Structure

- `src/main.js` — window, hotkeys, screen capture, routing, live-audio orchestration
- `src/providers.js` — AI backends (Claude Code CLI, OpenAI-compatible, Anthropic API)
- `src/transcriber.js` — local whisper.cpp server for speech-to-text
- `src/preload.js` — safe IPC bridge
- `src/renderer/` — overlay UI, audio capture (`audio.js`, `capture-worklet.js`)
- `scripts/` — launcher and whisper setup

`ghost.log` records timings and errors. Set `GHOST_DEBUG=1` to also log transcripts.
