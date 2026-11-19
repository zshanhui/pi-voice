# Security policy

## What this project is

`pi-voice` is two [pi](https://pi.dev) extensions plus a local TTS sidecar. Installed,
it runs with the privileges of the user running pi: it spawns `ffmpeg`, a whisper
binary and `afplay`, opens the microphone while you dictate, reads a system log to
see bluetooth headset buttons, and can rewrite the text of prompts you submit.

That is a lot of surface for a small project, so the threat model is stated
explicitly rather than implied:

- **Trusted:** your own machine, your own shell environment, the pi binary and the
  packages you install.
- **Not trusted:** audio transcriptions (they are model output and are filtered
  before they reach the model), provider responses, downloaded model files.

## Supported versions

Only the latest release on the default branch is supported. `0.1.x` is the current
line.

## Reporting a vulnerability

Email **shanhui.dev@proton.me** with:

- what the issue is and what an attacker gains;
- how to reproduce it (a short script or a sequence of taps is fine);
- the version or commit, and your `pi --version`.

Please **do not** open a public issue for anything exploitable, and give a reasonable
window to fix it before publishing details. You will get a reply within a few days.

## Known, intentional behaviour

These are documented rather than fixed, and reports about them are still welcome —
just say which of these you mean:

1. **Prompt rewriting.** The `input` hook prepends a tag to dictated prompts, drops
   blank dictation, and (with the read-aloud extension) writes a `voice`/`text`
   marker. `PI_VOICE_TAG=""` disables tagging. The hook is ~20 lines, in one file.
2. **Coordination files in `$TMPDIR`.** `pi-voice-mic.lock` and
   `pi-voice-<pid>-source` are plain files, owner-only (`0600`). On macOS `$TMPDIR`
   is already per-user; on a shared `/tmp` another local user could create them to
   silence or enable playback — a nuisance, not a disclosure.
3. **The bluetooth watcher reads `/usr/bin/log`.** Budget earbuds never send HID
   media keys, so the only way to see a tap is the `mediaremoted` log. It is read
   without elevation and contains nothing private beyond button presses.
4. **Network on demand only.** Nothing is contacted at runtime unless an API key is
   set for transcription, in which case exactly one audio clip is uploaded per
   dictation to that endpoint. There is no telemetry, ever.
5. **`scripts/setup.sh` trusts its sources.** It installs from Homebrew, PyPI,
   `github.com` and `huggingface.co`, pins the model files by exact byte size, and
   uses HTTPS only (`--proto "=https" --tlsv1.2`). Pin the Python package with
   `KOKORO_PKG="kokoro-onnx==<version>"` if you want reproducibility.

## Scope

In scope: secret leakage, command or AppleScript injection, path traversal, symlink
handling in temp files, privilege escalation, audio or transcript exfiltration,
dependency compromise.

Out of scope: the transcription and synthesis models' own output quality, the
security of third-party providers you configure, and anything requiring an attacker
who already controls your user account.
