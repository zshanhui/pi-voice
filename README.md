# pi-voice

Voice for [pi](https://pi.dev): **tap your earbud, talk, and the answer is spoken back.**

Two pi extensions that make a coding agent usable without looking at the screen — a bluetooth headset tap starts dictation, and the reply is read aloud sentence by sentence while it is still streaming. Typed prompts get silent answers, so the two modes coexist without a switch.

Everything runs on your machine: whisper.cpp (or Parakeet / mlx-whisper) for speech to text, Kokoro for text to speech. No API key, no account, no audio leaving the box.

```
tap earbud            "listening"  → talk → tap again
                                     ↓  ~0.6s
                          transcript sent to the model
                                     ↓  ~0.5s per sentence
                   "sending"        reply spoken while streaming
```

## What you get

| | |
|---|---|
| **Hands-free dictation** | One headset tap starts and stops recording. Budget earbuds work — their taps arrive as AVRCP commands, not media keys. |
| **Push-to-talk** | No headset? `Enter` `Enter` on an empty editor starts recording, `Enter` stops it. |
| **Spoken replies** | Replies are synthesized locally and played as they stream, so audio starts before the model finishes. Code fences and tables are skipped, links collapse to their text. |
| **Enter stops the voice** | Pressing `Enter` while it is talking silences it, without stealing the key from the editor. |
| **Read-aloud follows the input** | A dictated prompt gets a spoken answer; a typed prompt gets a silent one. |
| **Nothing is sent for silence** | A mute mic, a stray tap, or a whisper hallucination (`[BLANK_AUDIO]`, `you`) is dropped before it costs a call or a keystroke. |

## Requirements

macOS (playback uses `afplay`, capture uses ffmpeg's `avfoundation`), plus:

```bash
brew install ffmpeg whisper-cpp
whisper-cpp-download-ggml-model base.en    # 141 MB, ~0.6s for a 5s clip
```

Or point it at an OpenAI-compatible transcription API instead — see `PI_VOICE_BACKEND`.

## Install

```bash
# 1. the local TTS engine (~120 MB of models, created under ~/.pi/voice-kokoro)
git clone https://github.com/<you>/pi-voice ~/pi-voice
cd ~/pi-voice && ./scripts/setup-kokoro.sh

# 2. the extensions
pi install ~/pi-voice            # every session
pi -e ~/pi-voice                 # or just this run
```

`pi install` with a git URL also works, and no clone is needed:

```bash
pi install git:github.com/<you>/pi-voice
```

Grant your terminal microphone access in System Settings → Privacy & Security → Microphone, then tap the headset once. `/voice-doctor` and `/speak status` print exactly what resolved.

## Use

**Headset.** One tap starts recording (after a short spoken "listening" — capture opens first, so the cue means *talk now*), one tap stops it and sends the transcript to the model. Because you cannot see an editor, hands-free dictation bypasses it.

**Keyboard.** On an empty editor, `Enter` `Enter` starts recording. `Enter` accepts and inserts the transcript into the editor, `Escape` throws the clip away, and `/voice` toggles recording if you prefer a command.

**Interrupting.** `Enter` during playback stops the voice; so does `ctrl+s`. Submitting any prompt stops it (and pressed Enter never gets swallowed by the editor).

**Commands.** `/voice`, `/voice-doctor`, `/voice-backend [auto|local|whisper|api|status]`, `/speak [on|off|status|stop|last|rate N|voice NAME|zh NAME|lang|uninstall]`.

## How the two halves talk to each other

Both extensions run inside one pi process and coordinate through two files in `$TMPDIR`:

| file | written by | read by | meaning |
|---|---|---|---|
| `pi-voice-mic.lock` | voice-input while recording | voice-output | stay silent; the microphone is hot (an interrupted sentence is replayed after) |
| `pi-voice-<pid>-source` | voice-input on every submit | voice-output | was this prompt dictated (`voice`) or typed (`text`)? |

That is also why playback pauses and resumes around dictation: transcribing your own speakers is the classic failure of dictation plus read-aloud.

## Configuration

All of it is environment variables; both extensions also persist a few choices in `~/.pi/agent/voice-*.json` when you change them with a command.

**Input** (`voice-input.ts`)

| Variable | Default | Meaning |
|---|---|---|
| `PI_VOICE_BACKEND` | `auto` | `auto`, `whisper-cli`, `parakeet`, `mlx`, `api` |
| `PI_VOICE_MODEL` | per backend | model path or id |
| `PI_VOICE_LANG` | `en` | language code |
| `PI_VOICE_MIC` | auto | macOS avfoundation device index |
| `PI_VOICE_MIN_SEC` | `0.5` | shorter clips are treated as accidental taps |
| `PI_VOICE_MIN_DB` | `-40` | silence gate: peak level below this dBFS is never transcribed (`-90` disables) |
| `PI_VOICE_SUBMIT` | off | `1` sends the transcript instead of filling the editor |
| `PI_VOICE_ENTER` | on | `0` disables the `Enter` `Enter` chord and Enter capture |
| `PI_VOICE_DOUBLE_MS` | `500` | max gap between the two Enters |
| `PI_VOICE_CUE_DELAY_MS` | `1000` | how long capture runs before "listening" is spoken |
| `PI_VOICE_CUES` | `~/.pi/voice-cues` | where the cue wav files live |
| `PI_VOICE_EARBUD` | on | `0` disables the headset watcher |
| `PI_VOICE_EARBUD_KEYS` | `NextTrack,Pause,Play` | AVRCP commands accepted from the headset |
| `PI_VOICE_TRIGGER` | `/tmp/pi-voice-trigger` | file that toggles recording when it appears (`0` disables) |
| `PI_VOICE_TRIGGER_MS` | `250` | poll interval for that file |
| `PI_VOICE_TRIGGER_SETTLE_MS` | `150` | wait after a trigger before opening the mic |
| `PI_VOICE_API_BASE` / `PI_VOICE_API_KEY` | follows the key | OpenAI-compatible transcription endpoint |
| `PI_VOICE_PROMPT` | unset | vocabulary hint for the API backend |
| `PI_VOICE_TAG` | `[voice input: …]` | marker prepended to dictated prompts; empty or `0` sends the bare transcript |
| `PI_VOICE_TRACE` | off | `1` logs trigger and backend decisions to stderr |
| `PI_VOICE_FFMPEG` / `PI_VOICE_LOG_CMD` | `ffmpeg` / `/usr/bin/log` | binaries |

**Output** (`voice-output.ts`)

| Variable | Default | Meaning |
|---|---|---|
| `PI_SPEAK` | on | `0` starts disabled |
| `PI_SPEAK_KOKORO_DIR` | `~/.pi/voice-kokoro` | engine, model and sidecar |
| `PI_SPEAK_VOICE` | `am_michael` | voice (`af_heart`, `bm_george`, …) |
| `PI_SPEAK_VOICE_ZH` | `zf_xiaoxiao` | voice for Chinese replies |
| `PI_SPEAK_RATE` | `200` | words per minute |
| `PI_SPEAK_SPEED_EN` / `PI_SPEAK_SPEED_ZH` | `1.33` / `1.0` | tempo multipliers on top of the rate |
| `PI_SPEAK_LANG` | `en-us` | language, fixed at startup |
| `PI_SPEAK_AUTO_LANG` | on | `0` disables per-reply language detection |
| `PI_SPEAK_ONLY_VOICE` | on | `0` speaks every reply, even for typed prompts |
| `PI_SPEAK_ENTER` | on | `0` stops letting Enter interrupt playback |
| `PI_SPEAK_STOP_KEY` | `ctrl+s` | stop shortcut |
| `PI_SPEAK_CODE` | silent | `announce` says "Code block, 12 lines." |
| `PI_SPEAK_MIN_CHARS` / `PI_SPEAK_MAX_CHARS` | `40` / `320` | chunk size |
| `PI_SPEAK_DEBUG` | off | `1` logs to stderr |

## Privacy

The default path is entirely local: audio goes to whisper.cpp on your machine, text goes to your model provider, and speech is synthesized by Kokoro locally. Selecting the `api` backend (`PI_VOICE_BACKEND=api`, or setting `PI_VOICE_API_KEY`) uploads the clip to that endpoint instead. Recordings are temp files deleted as soon as they are transcribed; a sweep at startup cleans up after a crashed session.

## Uninstall

```bash
pi remove ~/pi-voice                    # or: pi remove git:github.com/<you>/pi-voice
rm -rf ~/.pi/voice-kokoro ~/.pi/voice-cues
rm -f ~/.pi/agent/voice-output.json ~/.pi/agent/voice-input.json
```

## Development

```bash
npm install
npm test        # 17 tests over the pure parts: audio level math, cue filtering, speech chunking
```

The pure functions (wav header parsing, dBFS levels, cue detection, markdown-to-speech chunking) are exported and tested; the pi wiring (commands, hooks, the two worker loops) is exercised by running it.

## Limitations

- macOS only for playback (`afplay`); capture uses ffmpeg and would work elsewhere with a different input flag.
- One recording at a time; playback and dictation share the microphone through a lock file rather than a mixer.
- Hands-free triggers only act in the pi session whose terminal tab is focused — the trigger channel is global.
- `parakeet-cli` builds vary; if the backend aborts, use `whisper-cli` (`/voice-backend whisper`).
- Kokoro's speed mapping is stepped rather than linear, hence the two separate tempo multipliers.

## License

MIT
