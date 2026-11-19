# pi-voice

Voice for [pi](https://pi.dev): **tap your earbud, talk, and the answer is spoken back.**

**New here? [Quick start](#quick-start) is three commands.**

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

## Quick start

```bash
git clone https://github.com/zshanhui/pi-voice ~/pi-voice
cd ~/pi-voice
./scripts/setup.sh          # installs what is missing, asks before big downloads
pi install ~/pi-voice       # enable in every session (or: pi -e ~/pi-voice for one run)
```

That is the whole flow. `setup.sh` is idempotent — re-run it any time, or with no risk:

```bash
./scripts/setup.sh --dry-run        # report what is present and what is missing
./scripts/setup.sh --yes            # no prompts (e.g. in a dotfiles bootstrap)
./scripts/setup.sh --whisper small.en   # pick a different whisper model
./scripts/setup.sh --api-only       # no local models, just check for an API key
```

Then tap your headset once and talk, or press `Enter` `Enter` on an empty prompt. Grant your terminal microphone access in System Settings → Privacy & Security → Microphone the first time — otherwise capture records silence.

Verify inside pi with `/voice-doctor` (backend, model, mic, which tab would answer a tap) and `/speak status` (voice, rate, engine).

### What setup.sh installs

| piece | size | notes |
|---|---|---|
| `ffmpeg` | ~90 MB via brew | audio capture |
| `whisper-cpp` + `ggml-base.en.bin` | ~10 MB + 141 MB | transcription, ~0.6 s for a 5 s clip |
| Kokoro venv (`kokoro-onnx`) | ~50 MB of wheels | synthesis |
| `kokoro-v1.0.int8.onnx` + `voices-v1.0.bin` | 88 MB + 27 MB | synthesis model |
| cue sounds | 148 KB | "listening", "sending", "no audio detected" |

Roughly 400 MB in total, one time. Everything lands in `~/.pi/voice-kokoro`, `~/models` and `~/.pi/voice-cues`, and `setup.sh` prints each step and asks before downloading anything large.

### Doing it by hand

If you would rather control every step:

```bash
brew install ffmpeg whisper-cpp
whisper-cpp-download-ggml-model base.en          # or drop ggml-*.bin in ~/models

uv venv --python 3.12 ~/.pi/voice-kokoro          # or: python3 -m venv
~/.pi/voice-kokoro/bin/python -m pip install kokoro-onnx
M=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
curl -L -o ~/.pi/voice-kokoro/kokoro-v1.0.int8.onnx "$M/kokoro-v1.0.int8.onnx"
curl -L -o ~/.pi/voice-kokoro/voices-v1.0.bin       "$M/voices-v1.0.bin"
cp kokoro/sidecar.py ~/.pi/voice-kokoro/
mkdir -p ~/.pi/voice-cues && cp cues/*.wav ~/.pi/voice-cues/
```

Alternatives to whisper.cpp: `pip install mlx-whisper` (Apple Silicon, downloads its model on first use, ~1.5 GB) or an OpenAI-compatible key (`PI_VOICE_API_KEY`, `OPENAI_API_KEY`, `DEEPINFRA_API_KEY`) — with a key, no local transcription model is needed at all.

## Use

**Headset.** One tap starts recording (after a short spoken "listening" — capture opens first, so the cue means *talk now*), one tap stops it and sends the transcript to the model. Because you cannot see an editor, hands-free dictation bypasses it.

**Keyboard.** On an empty editor, `Enter` `Enter` starts recording. `Enter` accepts and inserts the transcript into the editor, `Escape` throws the clip away, and `/voice` toggles recording if you prefer a command.

**Interrupting.** `Enter` during playback stops the voice; so does `ctrl+s`. Submitting any prompt stops it (and pressed Enter never gets swallowed by the editor).

**Commands.** `/voice`, `/voice-doctor`, `/voice-backend [auto|local|whisper|api|status]`, `/speak [on|off|status|stop|last|rate N|voice NAME|zh NAME|lang|uninstall]`.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| `No transcription backend available: no whisper-cli/whisper binary` | nothing to transcribe with — run `./scripts/setup.sh` |
| `Kokoro not installed at ~/.pi/voice-kokoro — extension idle` | run `./scripts/setup.sh`; or set `PI_SPEAK_KOKORO_DIR` if you keep it elsewhere |
| Recording works, transcript is empty, nothing is sent | correct behaviour: the clip was silent (below `PI_VOICE_MIN_DB`, default −40 dBFS). The cap is logged in the warning; lower it (`PI_VOICE_MIN_DB=-45`) if your mic is quiet |
| `Voice: no audible audio` on every clip | microphone permission missing for your terminal, or the wrong device — check `/voice-doctor` for the resolved device, force one with `PI_VOICE_MIC=1` |
| Headset tap does nothing | `PI_VOICE_EARBUD=0` set? Is this pi tab focused? Only the focused tab answers a tap. `PI_VOICE_TRACE=1` logs what the watcher saw |
| Tap works but the reply is silent | the prompt was typed, not dictated — read-aloud follows the input (`PI_SPEAK_ONLY_VOICE=0` disables that) |
| Speech starts late, or the first word is missing | capture needs ~1 s to open; the "listening" cue plays after that (`PI_VOICE_CUE_DELAY_MS=1500` if your device is slower) |
| `parakeet-cli failed (exit 134)` | that Parakeet build aborts on some machines — `/voice-backend whisper` |
| Playback talks over you while recording | should not happen: playback pauses on the mic lock. If it does, the recorder stopped refreshing the lock — restart pi |

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

## Security and trust

A pi extension runs as ordinary code with your privileges — the same model as a shell alias or a git hook. This is what `pi-voice` actually does, so you can check it:

| resource | access | why |
|---|---|---|
| microphone | `ffmpeg -f avfoundation` while recording only | capture |
| `$TMPDIR` | create/delete recordings and synthesized wavs | clips, owner-only (`0600`, created with `O_EXCL`) |
| `~/.pi/voice-kokoro`, `~/.pi/voice-cues` | read models, read cue wavs | engine and cues |
| `~/.pi/agent/voice-{input,output}.json` | read/write | voices, rate, backend choice |
| `/usr/bin/log stream` | read a system log | see headset taps (no microphone) |
| `osascript` | query Terminal/iTerm for the selected tab | only the focused pi tab answers a tap |
| child processes | `ffmpeg`, `whisper-cli`/`parakeet-cli`/`mlx_whisper`, `afplay`, python sidecar | transcribe, speak |

Network: **nothing** is contacted at runtime unless you configure the transcription API (`PI_VOICE_API_KEY`, `OPENAI_API_KEY` or `DEEPINFRA_API_KEY`), in which case that one clip is uploaded to that endpoint. Installing (`scripts/setup.sh`) fetches from `github.com`, `huggingface.co`, `pypi.org` and `brew`. There is no telemetry.

Prompt rewriting is part of the design: the `input` hook prepends `PI_VOICE_TAG` to dictated prompts, drops blank dictation, and (with `voice-output` installed) marks whether a prompt was spoken. It lives in one place per extension — `grep -n 'pi.on("input"' extensions/*.ts` — and `PI_VOICE_TAG=""` turns the tagging off.

To audit before installing:

```bash
grep -nE "pi\.exec|spawn\(|fetch\(" extensions/*.ts     # every process and network call
grep -nE "writeFileSync|rmSync|renameSync" extensions/*.ts  # every write
npm test                                                   # pure logic, no side effects
```

Report a vulnerability per [SECURITY.md](SECURITY.md); please do not open a public issue for anything exploitable.

## Uninstall

```bash
pi remove ~/pi-voice                    # or: pi remove git:github.com/<you>/pi-voice
rm -rf ~/.pi/voice-kokoro ~/.pi/voice-cues
rm -f ~/.pi/agent/voice-output.json ~/.pi/agent/voice-input.json
```

## Development

```bash
npm run setup   # same as ./scripts/setup.sh
npm install     # only needed for the tests
npm test        # 17 tests: audio level math, cue filtering, speech chunking
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
