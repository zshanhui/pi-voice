#!/usr/bin/env bash
#
# pi-voice setup — installs everything the extensions need, on macOS.
#
#   ./scripts/setup.sh                  guided install (asks before big downloads)
#   ./scripts/setup.sh --yes            no prompts
#   ./scripts/setup.sh --dry-run        report what is present / missing, change nothing
#   ./scripts/setup.sh --whisper small.en
#   ./scripts/setup.sh --api-only       skip local models, just check for an API key
#
# Everything is local: no account, no telemetry, no audio leaves the machine unless
# you pick the transcription API backend.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KOKORO_DIR="${PI_SPEAK_KOKORO_DIR:-${KOKORO_DIR:-$HOME/.pi/voice-kokoro}}"
CUES_DIR="${PI_VOICE_CUES:-${CUES_DIR:-$HOME/.pi/voice-cues}}"
MODELS_DIR="${PI_VOICE_MODELS_DIR:-$HOME/models}"
PYTHON="${PYTHON:-python3}"
WHISPER_MODEL="base.en"
ASSUME_YES=0
DRY_RUN=0
API_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --api-only) API_ONLY=1 ;;
    --whisper) shift; WHISPER_MODEL="${1:-base.en}" ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
miss() { printf '    \033[31mmiss\033[0m %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    \033[2mwould run\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}
size_of() { # path -> bytes, 0 when absent (portable across macOS/Linux)
  [ -f "$1" ] || { echo 0; return; }
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}
confirm() { # question
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [Y/n] ' "$1"
  read -r reply </dev/tty || return 0
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}
human() { awk -v b="$1" 'BEGIN { if (b > 1048576) printf "%.0f MB", b/1048576; else printf "%.1f KB", b/1024 }'; }

MISSING=0
NEED_HELP=0

printf '\n\033[1mpi-voice setup\033[0m\n'
printf '  repo       %s\n' "$REPO"
printf '  engine     %s\n' "$KOKORO_DIR"
printf '  cues       %s\n' "$CUES_DIR"
[ "$DRY_RUN" = 1 ] && printf '  mode       \033[2mdry run — nothing will be changed\033[0m\n'

if [ "$(uname -s)" != "Darwin" ]; then
  warn "not macOS: playback uses afplay and capture uses avfoundation, so this will not work as-is"
fi

# ---------------------------------------------------------------- ffmpeg -----
step "ffmpeg (audio capture)"
if command -v ffmpeg >/dev/null 2>&1; then
  ok "$(command -v ffmpeg)"
elif command -v brew >/dev/null 2>&1; then
  miss "not installed"
  MISSING=$((MISSING + 1))
  if confirm "    install ffmpeg with homebrew (~90 MB)?"; then
    run brew install ffmpeg
  fi
else
  miss "not installed, and homebrew is not available (https://brew.sh)"
  NEED_HELP=1
fi

# --------------------------------------------------------- transcription -----
step "transcription backend"
TRANSCRIBE_READY=0
if [ "$API_ONLY" = 1 ]; then
  if [ -n "${PI_VOICE_API_KEY:-}${OPENAI_API_KEY:-}${DEEPINFRA_API_KEY:-}" ]; then
    ok "API key found — audio will be uploaded to that endpoint, no local models needed"
    TRANSCRIBE_READY=1
  else
    miss "no PI_VOICE_API_KEY / OPENAI_API_KEY / DEEPINFRA_API_KEY set"
    NEED_HELP=1
  fi
else
  have_model() { [ "$(size_of "$MODELS_DIR/$1")" -gt 1000000 ]; }

  if command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1; then
    ok "whisper.cpp binary found"
    if have_model "ggml-$WHISPER_MODEL.bin"; then
      ok "model ggml-$WHISPER_MODEL.bin ($(human "$(size_of "$MODELS_DIR/ggml-$WHISPER_MODEL.bin")"))"
      TRANSCRIBE_READY=1
    elif [ -f "/opt/homebrew/share/whisper-cpp/models/ggml-$WHISPER_MODEL.bin" ]; then
      ok "model ggml-$WHISPER_MODEL.bin (homebrew share)"
      TRANSCRIBE_READY=1
    else
      miss "no ggml-$WHISPER_MODEL.bin model (~141 MB for base.en)"
      MISSING=$((MISSING + 1))
      if confirm "    download ggml-$WHISPER_MODEL.bin to $MODELS_DIR (~141 MB)?"; then
        run mkdir -p "$MODELS_DIR"
        if [ "$DRY_RUN" = 0 ]; then
          curl -L --fail --progress-bar -C - \
            -o "$MODELS_DIR/ggml-$WHISPER_MODEL.bin" \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin" \
            && { ok "download finished"; TRANSCRIBE_READY=1; } || { miss "download failed"; NEED_HELP=1; }
        fi
      fi
    fi
  elif command -v brew >/dev/null 2>&1; then
    miss "no whisper.cpp binary"
    MISSING=$((MISSING + 1))
    if confirm "    install whisper-cpp with homebrew, then fetch ggml-$WHISPER_MODEL.bin?"; then
      run brew install whisper-cpp
      if [ "$DRY_RUN" = 0 ]; then
        if command -v whisper-cpp-download-ggml-model >/dev/null 2>&1; then
          whisper-cpp-download-ggml-model "$WHISPER_MODEL" && TRANSCRIBE_READY=1
        else
          run mkdir -p "$MODELS_DIR"
          curl -L --fail --progress-bar -C - \
            -o "$MODELS_DIR/ggml-$WHISPER_MODEL.bin" \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin" \
            && TRANSCRIBE_READY=1
        fi
      fi
    fi
  elif command -v mlx_whisper >/dev/null 2>&1; then
    ok "mlx-whisper found (its model downloads on first use, ~1.5 GB)"
    TRANSCRIBE_READY=1
  elif [ -n "${PI_VOICE_API_KEY:-}${OPENAI_API_KEY:-}${DEEPINFRA_API_KEY:-}" ]; then
    ok "no local backend, but an API key is set — transcription will use that endpoint"
    TRANSCRIBE_READY=1
  else
    miss "no backend: install whisper-cpp (brew), mlx-whisper (pip), or set an API key"
    NEED_HELP=1
  fi
fi

# ---------------------------------------------------------------- kokoro -----
step "text to speech (Kokoro)"
VENV_OK=0
[ -x "$KOKORO_DIR/bin/python" ] && VENV_OK=1
if [ "$VENV_OK" = 1 ]; then
  ok "python venv $KOKORO_DIR"
else
  miss "no python venv at $KOKORO_DIR"
  MISSING=$((MISSING + 1))
  if confirm "    create it and install kokoro-onnx (~50 MB of wheels)?"; then
    if [ "$DRY_RUN" = 1 ]; then
      run "$PYTHON" -m venv "$KOKORO_DIR" "&&" pip install kokoro-onnx
    else
      run "$PYTHON" -m venv "$KOKORO_DIR"
      run "$KOKORO_DIR/bin/python" -m pip install --quiet --upgrade pip
      if run "$KOKORO_DIR/bin/python" -m pip install --quiet kokoro-onnx; then
        VENV_OK=1
      else
        miss "pip install failed"
        NEED_HELP=1
      fi
    fi
  fi
fi

fetch_model() { # file expected-bytes
  local file="$1" want="$2" path="$KOKORO_DIR/$1" have
  have="$(size_of "$path")"
  if [ "$have" = "$want" ]; then
    ok "$file ($(human "$have"))"
    return 0
  fi
  miss "$file — need $(human "$want")"
  MISSING=$((MISSING + 1))
  if confirm "    download $file ($(human "$want")?"; then
    run mkdir -p "$KOKORO_DIR"
    if [ "$DRY_RUN" = 0 ]; then
      curl -L --fail --progress-bar -C - -o "$path" \
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$file" \
        && ok "$file downloaded" || { miss "$file download failed"; NEED_HELP=1; }
    fi
  fi
}

if [ "$DRY_RUN" = 1 ] || [ "$VENV_OK" = 1 ]; then
  fetch_model kokoro-v1.0.int8.onnx 92361271
  fetch_model voices-v1.0.bin 28214398
  if [ "$(size_of "$KOKORO_DIR/sidecar.py")" -gt 0 ] && cmp -s "$REPO/kokoro/sidecar.py" "$KOKORO_DIR/sidecar.py"; then
    ok "sidecar.py up to date"
  else
    miss "sidecar.py missing or out of date"
    run cp "$REPO/kokoro/sidecar.py" "$KOKORO_DIR/sidecar.py"
  fi
fi

# ------------------------------------------------------------------ cues -----
step "spoken cues"
CUE_COUNT=$(ls "$REPO"/cues/*.wav 2>/dev/null | wc -l | tr -d ' ')
if [ "$DRY_RUN" = 1 ]; then
  printf '    \033[2mwould copy\033[0m %s files to %s\n' "$CUE_COUNT" "$CUES_DIR"
else
  mkdir -p "$CUES_DIR"
  cp -f "$REPO"/cues/*.wav "$CUES_DIR"/ && ok "$CUE_COUNT files in $CUES_DIR"
fi

# --------------------------------------------------------------- summary -----
step "summary"
if [ "$DRY_RUN" = 1 ]; then
  printf '    dry run finished — re-run without --dry-run to install what is missing\n'
fi
[ "$TRANSCRIBE_READY" = 1 ] && ok "dictation: ready"
[ "$TRANSCRIBE_READY" = 0 ] && miss "dictation: no backend yet"

cat <<EOF

Next:

  pi -e $REPO          # try it for one run
  pi install $REPO     # enable it in every session

Then tap your headset once, or press Enter twice on an empty prompt, and talk.
Inside pi, /voice-doctor and /speak status show what resolved.

Microphone permission: System Settings -> Privacy & Security -> Microphone must
list your terminal, or capture records silence.

EOF

if [ "$NEED_HELP" = 1 ]; then
  printf '\033[33mSome pieces need attention — see the README troubleshooting table.\033[0m\n\n'
  exit 1
fi

if [ "$MISSING" -gt 0 ] && [ "$DRY_RUN" = 0 ]; then
  printf '\033[33m%d item(s) were skipped; rerun this script any time to finish.\033[0m\n\n' "$MISSING"
fi
exit 0
