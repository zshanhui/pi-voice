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

Then tap your headset once and talk. Grant your terminal microphone access in System Settings → Privacy & Security → Microphone, or capture records silence. `./scripts/setup.sh --dry-run` reports what is present and what is missing; `--help` lists the rest.

Verify inside pi with `/voice-doctor` (backend, model, mic, which tab would answer a tap) and `/speak status` (voice, rate, engine). About 400 MB of models and tools are installed once: ffmpeg, whisper.cpp plus `base.en`, and the Kokoro engine. If you would rather run every step yourself, `setup.sh --dry-run` prints the commands it would run, and each command also appears in the extension headers.

## Use

**Headset.** One tap starts recording — after a short spoken "listening", because capture opens first, so the cue means *talk now*. One tap stops it and sends the transcript straight to the model, since you cannot see an editor.

**Keyboard.** On an empty editor, `Enter` `Enter` starts recording; `Enter` inserts the transcript into the editor, `Escape` discards the clip, `/voice` toggles recording.

**Interrupting.** `Enter` or `ctrl+s` stops playback, and submitting any prompt stops it too.

**Commands.** `/voice`, `/voice-doctor`, `/voice-backend [auto|local|whisper|api]`, `/speak [on|off|status|stop|last|rate N|voice NAME]`.

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

Choices made with `/voice-backend`, `/speak voice` and `/speak rate` persist in `~/.pi/agent/voice-*.json`.

## How the two halves talk to each other

Both extensions run in one pi process and coordinate through two owner-only files in the temp directory: a microphone lock (written while recording, so playback pauses instead of transcribing the speakers) and a per-session marker saying whether the prompt was dictated or typed (so a typed prompt gets a silent reply).

## Security and trust

A pi extension runs as ordinary code with your privileges, so here is exactly what this one touches: the microphone through `ffmpeg` while recording; owner-only files in the temp directory; the Kokoro and cue directories read-only; two small JSON config files; a read of the system log to see headset taps; and an AppleScript query for the selected terminal tab, so only the focused pi tab answers a tap.

**No network access at runtime** unless you configure the transcription API, in which case one clip is uploaded per dictation. Installing fetches from GitHub, Hugging Face, PyPI and Homebrew. There is no telemetry. To audit before installing: `grep -nE "pi\.exec|spawn\(|fetch\(" extensions/*.ts`, then `npm test`. Report vulnerabilities per [SECURITY.md](SECURITY.md), not in a public issue.

## Development

```bash
npm run setup    # same as ./scripts/setup.sh
npm install
npm test         # 17 tests: audio level math, cue filtering, speech chunking
```

## Limitations

macOS only for playback (`afplay`); one recording at a time, since playback and dictation share the microphone through a lock file; hands-free triggers only act in the focused pi tab.

## Uninstall

```bash
pi remove ~/pi-voice
rm -rf ~/.pi/voice-kokoro ~/.pi/voice-cues ~/.pi/agent/voice-output.json
```

## License

MIT
