**English** · [简体中文](README.zh-CN.md)

# pi-voice

Voice for [pi](https://pi.dev): **tap your earbud, talk, and the answer is spoken back.**

Two extensions that make a coding agent usable without looking at the screen — a bluetooth headset tap starts dictation, and the reply is read aloud sentence by sentence while it is still streaming. Typed prompts get silent answers, so the two modes coexist without a switch. Everything runs on your machine: whisper.cpp for speech to text, Kokoro for text to speech. No API key, no account, no audio leaving the box.

```
tap earbud → "listening" → talk → tap again → transcript sent → reply spoken
```

## What you get

- **Hands-free dictation** — one headset tap starts and stops recording. Budget earbuds work; their taps arrive as AVRCP commands, not media keys.
- **Push-to-talk** — no headset? `Enter` `Enter` on an empty editor starts recording, `Enter` stops it.
- **Spoken replies** — synthesized locally and played while the reply streams. Code fences and tables are skipped, links collapse to their text, `Enter` or `ctrl+s` silences it.
- **Nothing is sent for silence** — a mute mic, a stray tap, or a whisper hallucination (`[BLANK_AUDIO]`) is dropped before it costs a call.

## Quick start

```bash
git clone https://github.com/zshanhui/pi-voice ~/pi-voice
cd ~/pi-voice && ./scripts/setup.sh    # installs what is missing, asks before big downloads
pi install ~/pi-voice                  # or: pi -e ~/pi-voice for one run
```

Then tap your headset once and talk. Grant your terminal microphone access in System Settings → Privacy & Security → Microphone, or capture records silence.

Verify inside pi: `/voice-doctor` reports the backend, model, mic and which tab would answer a tap; `/speak status` reports voice, rate and engine.

### The setup script

`scripts/setup.sh` detects what is present, tells you what is missing, and only downloads after asking. It is idempotent — re-run it any time, including after moving directories.

| command | what it does |
|---|---|
| `./scripts/setup.sh` | guided install of everything missing |
| `./scripts/setup.sh --dry-run` | report present/missing, change nothing |
| `./scripts/setup.sh --yes` | unattended (dotfiles bootstrap, CI) |
| `./scripts/setup.sh --whisper small.en` | install a different whisper model |
| `./scripts/setup.sh --api-only` | no local models, just check for an API key |
| `./scripts/setup.sh --help` | usage |

It works through five steps and reports each one:

1. `ffmpeg` — capture (`brew install ffmpeg` if missing)
2. whisper.cpp binary **and** ggml model — transcription; skipped if mlx-whisper or an API key is available
3. Kokoro venv plus `kokoro-v1.0.int8.onnx` and `voices-v1.0.bin` — synthesis
4. `sidecar.py` and the cue wav files copied into place
5. a summary, and the exact `pi install` line to run next

It exits **1** when something still needs attention, so a bootstrap can detect it. Override where things land with `KOKORO_DIR` / `PI_SPEAK_KOKORO_DIR`, `CUES_DIR` / `PI_VOICE_CUES`, `PI_VOICE_MODELS_DIR`, `PYTHON`, or pin the Python package with `KOKORO_PKG="kokoro-onnx==0.4.9"`. Everything is HTTPS-only and resumable.

## Use

| gesture | effect |
|---|---|
| tap headset | start recording, tap again to stop and send |
| `Enter` `Enter` | start recording from the keyboard (empty editor) |
| `Enter` while recording | accept and insert the transcript into the editor |
| `Escape` while recording | discard the clip |
| `Enter` or `ctrl+s` while it is talking | stop playback |
| submit any prompt | stops playback too |

A headset tap speaks "listening" after capture has opened — that cue means *talk now* — and sends the transcript straight to the model, since you cannot see an editor. Keyboard dictation inserts into the editor instead, so you can edit before sending.

| command | what it does |
|---|---|
| `/voice` | toggle recording (the keyboard-free alternative to the chord) |
| `/voice-doctor` | resolved backend, model, mic, and which tab would answer a tap |
| `/voice-backend` | show the saved transcriber and what it resolves to |
| `/voice-backend local\|whisper\|api\|auto` | choose the transcriber; persists across sessions |
| `/speak` | toggle read-aloud |
| `/speak on` / `/speak off` | set it explicitly |
| `/speak status` | voice, rate, language, engine, stop key |
| `/speak stop` | stop playback now |
| `/speak last` | re-read the previous reply |
| `/speak rate 240` | words per minute; persists |
| `/speak voice af_heart` | change voice; persists |
| `/speak zh zf_xiaobei` | voice used for Chinese replies |
| `/speak uninstall` | print the removal commands |

## Configuration

Everything is environment variables; every one is documented in the header of the extension it belongs to. The handful worth knowing:

| Variable | Default | Meaning |
|---|---|---|
| `PI_VOICE_MIN_DB` | `-40` | silence gate in dBFS — clips quieter than this are never transcribed |
| `PI_VOICE_CUE_DELAY_MS` | `1000` | how long capture runs before "listening" is spoken; raise it on slow devices |
| `PI_VOICE_EARBUD` | on | `0` disables the headset watcher |
| `PI_VOICE_BACKEND` | `auto` | `whisper-cli`, `parakeet`, `mlx`, or `api` (needs `PI_VOICE_API_KEY`) |
| `PI_SPEAK_VOICE` | `am_michael` | TTS voice, e.g. `af_heart`, `bm_george` |
| `PI_SPEAK_RATE` | `200` | words per minute |
| `PI_SPEAK_ONLY_VOICE` | on | `0` speaks every reply, even answers to typed prompts |
| `PI_SPEAK` | on | `0` starts with read-aloud disabled |
| `PI_SPEAK_FOCUS` | on | `0` lets background sessions speak too |

Choices made with `/voice-backend`, `/speak voice` and `/speak rate` persist in `~/.pi/agent/voice-*.json`.

## How the two halves talk to each other

Both extensions run in one pi process and coordinate through two owner-only files in the temp directory: a microphone lock (written when recording starts and refreshed every two seconds while it lasts, so playback stops — and stays stopped for that reply, which `/speak last` can re-read — instead of talking into the microphone) and a per-session marker saying whether the prompt was dictated or typed (so a typed prompt gets a silent reply).

## Security

Runs as ordinary code with your privileges, and touches the microphone only while recording. No network access at runtime unless you set a transcription API key, and no telemetry. Threat model, every resource touched, and how to audit: [SECURITY.md](SECURITY.md).

## Development

```bash
npm run setup    # same as ./scripts/setup.sh
npm install
npm test         # 17 tests: audio level math, cue filtering, speech chunking
```

## Limitations

macOS only for playback (`afplay`); one recording at a time, since playback and dictation share the microphone through a lock file; only the focused pi tab speaks or answers a headset tap — a background session stays silent (`PI_SPEAK_FOCUS=0` lifts that for playback).

## Uninstall

```bash
pi remove ~/pi-voice
rm -rf ~/.pi/voice-kokoro ~/.pi/voice-cues ~/.pi/agent/voice-output.json
```

## License

MIT
