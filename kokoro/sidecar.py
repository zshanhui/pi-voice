#!/usr/bin/env python3
"""
Kokoro TTS sidecar for pi's voice-output extension.

Long-lived process so the ONNX model loads once per pi session instead of once
per utterance (load 1.7s + warmup 2.0s would otherwise be added to every
sentence).

Protocol: newline-delimited JSON on stdin, one JSON line per reply on stdout.

  -> {"id":1,"text":"hello","voice":"af_heart","speed":1.0,"lang":"en-us","out":"/tmp/a.wav"}
  <- {"id":1,"ok":true,"ms":680,"seconds":4.37}
  <- {"id":1,"ok":false,"err":"..."}

  -> {"cmd":"warmup"}      <- {"ok":true,"ms":2650}
  -> {"cmd":"voices"}      <- {"ok":true,"voices":[...]}

Exits on stdin EOF, so killing pi never leaves an orphan behind.
Audio is written as 16-bit mono PCM WAV at the model's native 24 kHz.
"""

import json
import os
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("KOKORO_MODEL", os.path.join(HERE, "kokoro-v1.0.int8.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", os.path.join(HERE, "voices-v1.0.bin"))

# Kokoro speed is a multiplier around a natural ~200 wpm delivery.
BASE_WPM = 200.0

# Chinese needs misaki's G2P: the zh voices were trained on phonemes that carry
# explicit tone contours (wo↓ pa↓ …). espeak's Mandarin drops the tones, which
# is why pronunciation sounds wrong even though the words are "right".
LANG_ZH = {"cmn", "zh", "zh-cn", "yue"}
_zh_g2p = None


def zh_phonemes(text):
    global _zh_g2p
    if _zh_g2p is None:
        from misaki import zh as misaki_zh

        _zh_g2p = misaki_zh.ZHG2P()
    return _zh_g2p(text)[0]


def reply(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def load():
    import numpy as np
    from kokoro_onnx import Kokoro

    started = time.time()
    engine = Kokoro(MODEL, VOICES)
    load_ms = int((time.time() - started) * 1000)

    # The first create() pays ONNX kernel warmup (~2s). Do it here, silently,
    # so the first real sentence is not the one that pays for it.
    warm_started = time.time()
    engine.create("Ready.", voice="af_heart", speed=1.0, lang="en-us")
    return engine, np, load_ms, int((time.time() - warm_started) * 1000)


def main():
    if not os.path.exists(MODEL):
        reply({"ok": False, "fatal": f"model not found: {MODEL}"})
        return 1

    engine, np, load_ms, warm_ms = load()
    reply({"ok": True, "ready": True, "load_ms": load_ms, "warm_ms": warm_ms})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            reply({"ok": False, "err": f"bad json: {exc}"})
            continue

        cmd = req.get("cmd")
        if cmd == "voices":
            reply({"ok": True, "voices": engine.get_voices()})
            continue
        if cmd == "warmup":
            started = time.time()
            engine.create("Warm.", voice="af_heart", speed=1.0, lang="en-us")
            reply({"ok": True, "ms": int((time.time() - started) * 1000)})
            continue
        if cmd == "quit":
            reply({"ok": True, "bye": True})
            return 0
        if cmd:
            reply({"ok": False, "id": req.get("id"), "err": f"unknown cmd {cmd!r}"})
            continue

        text = (req.get("text") or "").strip()
        out = req.get("out")
        if not text or not out:
            reply({"ok": False, "id": req.get("id"), "err": "text and out are required"})
            continue

        voice = req.get("voice") or "af_heart"
        lang = req.get("lang") or "en-us"
        try:
            speed = float(req.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = max(0.6, min(1.6, speed))

        started = time.time()
        method = "espeak"
        try:
            if lang in LANG_ZH:
                try:
                    phonemes = zh_phonemes(text)
                    samples, rate = engine.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
                    method = "misaki"
                except Exception as zh_exc:  # noqa: BLE001 - fall back rather than go silent
                    print(f"zh g2p failed ({type(zh_exc).__name__}: {zh_exc}); using espeak", file=sys.stderr)
                    samples, rate = engine.create(text, voice=voice, speed=speed, lang=lang)
            else:
                samples, rate = engine.create(text, voice=voice, speed=speed, lang=lang)
        except Exception as exc:  # noqa: BLE001 - report any model failure to pi
            reply({"ok": False, "id": req.get("id"), "err": f"{type(exc).__name__}: {exc}"[:400]})
            continue

        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(out, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(pcm.tobytes())

        reply(
            {
                "ok": True,
                "id": req.get("id"),
                "ms": int((time.time() - started) * 1000),
                "seconds": round(len(samples) / rate, 3),
                "g2p": method,
            }
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
