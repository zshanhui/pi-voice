#!/usr/bin/env bash
# Sets up the local TTS engine and cue sounds for pi-voice.
#
#   ./scripts/setup-kokoro.sh            # ~/.pi/voice-kokoro + ~/.pi/voice-cues
#   KOKORO_DIR=/opt/kokoro ./scripts/setup-kokoro.sh
#
# Everything runs on your machine: no account, no API key, no audio leaving the box.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KOKORO_DIR="${KOKORO_DIR:-$HOME/.pi/voice-kokoro}"
CUES_DIR="${CUES_DIR:-$HOME/.pi/voice-cues}"
PYTHON="${PYTHON:-python3}"
MIRROR="${MIRROR:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

say "engine directory: $KOKORO_DIR"
mkdir -p "$KOKORO_DIR"

if [ ! -x "$KOKORO_DIR/bin/python" ]; then
  say "creating python venv"
  "$PYTHON" -m venv "$KOKORO_DIR"
fi

say "installing kokoro-onnx (pulls numpy + onnxruntime)"
"$KOKORO_DIR/bin/python" -m pip install --quiet --upgrade pip
"$KOKORO_DIR/bin/python" -m pip install --quiet kokoro-onnx

fetch() { # url-dir file expected-bytes
  local base="$1" file="$2" want="$3" have=0
  [ -f "$KOKORO_DIR/$file" ] && have=$(stat -f%z "$KOKORO_DIR/$file" 2>/dev/null || stat -c%s "$KOKORO_DIR/$file")
  if [ "$have" = "$want" ]; then
    say "already have $file ($have bytes)"
    return 0
  fi
  say "downloading $file ($((want / 1024 / 1024)) MB)"
  curl -L --fail --progress-bar -o "$KOKORO_DIR/$file" "$base/$file"
}

fetch "$MIRROR" kokoro-v1.0.int8.onnx 92361271
fetch "$MIRROR" voices-v1.0.bin       28214398

say "installing sidecar"
cp "$REPO/kokoro/sidecar.py" "$KOKORO_DIR/sidecar.py"

say "installing cue sounds into $CUES_DIR"
mkdir -p "$CUES_DIR"
cp "$REPO"/cues/*.wav "$CUES_DIR/"

cat <<EOF

Done. Start pi with the package loaded:

  pi -e $REPO          # try it for one run
  pi install $REPO     # use it in every session

Then tap your headset once and talk. /voice-doctor and /speak status print what
resolved. If Kokoro lives elsewhere, export PI_SPEAK_KOKORO_DIR=$KOKORO_DIR.
EOF
