/**
 * Pi voice input extension — push-to-talk dictation into the pi editor.
 *
 * On an empty editor, press Enter twice to start recording; Enter again stops it
 * and inserts the transcript. While transcribing, Enter cancels. Escape discards
 * the clip. The recording is transcribed locally (whisper.cpp / mlx-whisper) or
 * through an OpenAI-compatible `/audio/transcriptions` endpoint, then pasted
 * into the editor (or sent as a user message with PI_VOICE_SUBMIT=1).
 *
 * Nothing is ever inserted or sent for a clip that has no speech in it: a
 * recording below PI_VOICE_MIN_DB is dropped before the backend runs, and a
 * transcript that is empty, punctuation-only, or just whisper's non-speech cue
 * (`[BLANK_AUDIO]`, `[MUSIC PLAYING]`, `(silence)`, `♪`) is treated as no speech.
 *
 * Try it without installing:
 *   pi -e ./pi-extensions/voice-input.ts
 *
 * Install for every session:
 *   cp pi-extensions/voice-input.ts ~/.pi/agent/extensions/
 *
 * Commands:
 *   /voice          toggle recording (fallback when the Enter gesture is disabled)
 *   /voice-backend  switch backend: local (parakeet) | whisper | deepinfra | auto | status
 *   /voice-doctor   print resolved backend, model, mic
 *
 * Backend selection precedence: PI_VOICE_BACKEND env → `<agent dir>/voice-input.json`
 * (written by `/voice-backend`) → "auto". `auto` prefers whisper.cpp, then
 * Parakeet, then mlx-whisper, then the HTTP API.
 *
 * Keys while recording or transcribing:
 *   enter         accept: stop recording and transcribe; cancel transcription
 *   escape        discard the clip / cancel transcription
 *
 * Keys when idle:
 *   enter enter   on an empty editor, start recording (two presses within 500ms)
 *
 * The chord only applies while the editor has focus. Any dialog that owns the
 * keyboard instead — the /model picker, /settings, /sessions, `ctx.ui.select` —
 * keeps Enter for itself, so those menus stay usable.
 *
 * Environment:
 *   PI_VOICE_BACKEND   auto | parakeet | whisper-cli | mlx | api, default auto
 *   PI_VOICE_MODEL     model path/id for the selected backend
 *   PI_VOICE_LANG      language code, default "en"
 *   PI_VOICE_MIC       capture device (macOS: avfoundation index, default auto)
 *   PI_VOICE_MIN_SEC   minimum usable recording length, default 0.5
 *   PI_VOICE_MIN_DB    silence gate: peak level below this dBFS means the clip is
 *                      skipped before transcription, so a muted mic or a stray tap
 *                      never sends anything, default -40 (-90 disables it)
 *   PI_VOICE_SUBMIT    1 = send the transcript immediately instead of filling the editor
 *   PI_VOICE_ENTER     0 = do not intercept Enter while recording/transcribing
 *   PI_VOICE_DOUBLE_MS max gap between the two Enters that start a recording, default 500
 *   PI_VOICE_API_BASE  API base URL, default https://api.openai.com/v1
 *   PI_VOICE_API_KEY   API key, falls back to $OPENAI_API_KEY / $DEEPINFRA_API_KEY
 *   PI_VOICE_PROMPT    vocabulary hint for the API backend (proper nouns, jargon)
 *   PI_VOICE_FFMPEG    ffmpeg binary, default "ffmpeg"
 *   PI_VOICE_CUES      directory holding listening/sending/no-audio wav files,
 *                      default ~/.pi/voice-cues
 *   PI_VOICE_TRACE=1   log trigger/backend decisions to stderr
 *   PI_VOICE_LOG_CMD   `log` binary used by the earbud watcher, default "/usr/bin/log"
 * Hands-free triggers (PI_VOICE_EARBUD, PI_VOICE_TRIGGER) send the transcript
 * straight to the model, since the user cannot see the editor to edit it. The
 * double-Enter chord and /voice still only fill the editor for review.
 *
 *   PI_VOICE_TRIGGER   file that toggles recording when it appears, default
 *                      /tmp/pi-voice-trigger; "0" disables the watcher.
 *                      A Siri Shortcut creates it with:  touch /tmp/pi-voice-trigger
 *   PI_VOICE_TRIGGER_MS       poll interval, default 250
 *   PI_VOICE_TRIGGER_SETTLE_MS  wait after a trigger before opening the mic
 *                      (Siri holds it briefly), default 150
 *   PI_VOICE_CUE_DELAY_MS  how long capture runs before the listening cue is
 *                      spoken, default 1000. The cue means "talk now", so it waits
 *                      for the roughly one second the mic needs to start.
 *   PI_VOICE_EARBUD    headset button as the trigger. On by default; set
 *                      PI_VOICE_EARBUD=0 to turn the watcher off. Watches
 *                      mediaremoted for AVRCP commands from bluetoothd, which is
 *                      the only way to see budget-earbud taps (they never become
 *                      media keys). PI_VOICE_EARBUD_KEYS selects which,
 *                      default "NextTrack,Pause,Play" — budget buds emit
 *                      play/pause or next depending on their state, so accept
 *                      all three; any single tap then toggles dictation.
 * Hands-free triggers only work while this pi tab is the focused Terminal tab;
 * a background session never reacts. That guard is always on.
 * Spoken cue files live at ~/.pi/voice-cues/{listening,sending}.wav and are
 * used for hands-free triggers; keyboard dictation uses the system blips. A
 * hands-free clip with no speech says "No audio detected." (no-audio.wav, falling
 * back to the system Basso) instead of the "sending" cue, because hearing "sending"
 * for a clip that was dropped is a lie: the user keeps talking into a session that
 * will never answer.
 * The listening cue is spoken only after capture has had ~1s to start (see
 * PI_VOICE_CUE_DELAY_MS), so "listening" means "talk now" rather than "the mic is
 * still opening". That cue lands inside the recording, so its lead-in is trimmed
 * before transcription and a leading "Listening." is dropped from the transcript.
 * The `input` hook also records whether the prompt was spoken or typed in
 * $TMPDIR/pi-voice-<pid>-source, which voice-output.ts reads to decide whether to
 * read the reply aloud: a reply to a typed prompt stays silent.
 *   PI_VOICE_TAG       marker prepended to dictated prompts so the model knows
 *                      they were spoken, default
 *                      "[voice input: transcribed from speech, expect misheard
 *                      words]". Empty or "0"
 *                      submits the bare transcript.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono, 16-bit PCM
const STATUS_KEY = "voice";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const env = (name: string): string | undefined => {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
};

const LANG = env("PI_VOICE_LANG") ?? "en";
const MIN_SECONDS = Number(env("PI_VOICE_MIN_SEC") ?? "0.5");
/**
 * Silence gate, in dBFS peak level. A mic pressed by accident (or a muted headset)
 * records a noise floor around -55 dBFS while speech peaks near -12, so anything
 * below the threshold is skipped *before* transcription: that saves the model
 * round trip and stops whisper from hallucinating a sentence out of silence.
 * PI_VOICE_MIN_DB=-90 effectively disables the gate.
 */
const MIN_DB = (() => {
	const raw = Number(env("PI_VOICE_MIN_DB") ?? "-40");
	return Number.isFinite(raw) && raw <= 0 ? raw : -40;
})();
const AUTO_SUBMIT = env("PI_VOICE_SUBMIT") === "1";
const ENTER_STOP = env("PI_VOICE_ENTER") !== "0";
/**
 * Upper bound on the gap between the two Enter presses that start a recording.
 * Any quicker double tap works too; this is a ceiling, not a target.
 */
const DOUBLE_ENTER_MS = (() => {
	const raw = Number(env("PI_VOICE_DOUBLE_MS") ?? "500");
	return Number.isFinite(raw) && raw >= 100 ? raw : 500;
})();
const STOP_HINT = ENTER_STOP ? "Enter stops" : "/voice stops";
const CANCEL_HINT = ENTER_STOP ? " Enter cancels" : "";
const FFMPEG = env("PI_VOICE_FFMPEG") ?? "ffmpeg";

/**
 * Marker prepended to submitted prompts that came from the microphone, so the
 * model knows the text was transcribed rather than typed. Set PI_VOICE_TAG to
 * an empty string or "0" to submit the bare transcript.
 */
const VOICE_TAG = (() => {
	const raw = process.env.PI_VOICE_TAG;
	if (raw === undefined) return "[voice input: transcribed from speech, expect misheard words]";
	const value = raw.trim();
	return value === "0" || value === "" ? "" : value;
})();

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Cross-extension audio lock. voice-output.ts polls this file and stays silent
 * while we hold the microphone, so dictation never transcribes the speakers.
 * It is only a runtime flag, safe to delete.
 */
const MIC_LOCK = join(tmpdir(), "pi-voice-mic.lock");
/**
 * Says whether the prompt now being answered was dictated or typed, so voice-output
 * knows whether to read the reply aloud. Same-process, pid-scoped: both extensions
 * run inside one pi process, and a second session must not answer for this one.
 * Content is "voice" or "text"; no file at all means "voice-input is not involved".
 */
const SOURCE_FILE = join(tmpdir(), `pi-voice-${process.pid}-source`);

function markSource(fromVoice: boolean): void {
	try {
		writeFileSync(SOURCE_FILE, fromVoice ? "voice" : "text");
	} catch {
		/* output falls back to speaking, which is the loud failure, not the silent one */
	}
}
/** Every temp path we create starts with this, so the startup sweep can find them. */
const TEMP_PREFIX = "pi-voice-";

/**
 * External trigger: any process that creates this file starts or stops a
 * recording, exactly like /voice. Intended for a Siri Shortcut (or a keyboard
 * shortcut, or an earbud bridge) so dictation does not need the double-Enter
 * chord. PI_VOICE_TRIGGER=0 disables the watcher.
 */
const TRIGGER_FILE = (() => {
	const raw = process.env.PI_VOICE_TRIGGER;
	if (raw === "0" || raw === "") return "";
	// Absolute and TMPDIR-independent on purpose: a Shortcut's shell action does
	// not necessarily see pi's $TMPDIR, so both sides must agree on a fixed path.
	return raw ?? "/tmp/pi-voice-trigger";
})();
const TRIGGER_POLL_MS = Math.max(100, Number(env("PI_VOICE_TRIGGER_MS") ?? "250"));
/** Siri keeps the input device briefly after running a Shortcut. */
const TRIGGER_SETTLE_MS = Math.max(0, Number(env("PI_VOICE_TRIGGER_SETTLE_MS") ?? "150"));
/**
 * How long capture runs before the listening cue is spoken. Opening avfoundation and
 * the first device buffers costs roughly a second on this hardware, and the cue is
 * the user's "talk now" — spoken earlier, it invites speech the mic has not started
 * recording yet. Measured by wall clock, not by watching the file: ffmpeg keeps its
 * output in an AVIO buffer and the wav stays 0 bytes on disk until it is closed.
 */
const CUE_DELAY_MS = Math.max(0, Number(env("PI_VOICE_CUE_DELAY_MS") ?? "1000"));

/**
 * Audible confirmation, because a headset trigger is invisible. Spoken cues are
 * pre-recorded with Kokoro (see ~/.pi/voice-cues); if one is missing we fall back
 * to the system blips. Keyboard dictation always uses the blips so the
 * double-Enter chord stays instant.
 */
const CUE_DIR = env("PI_VOICE_CUES") ?? join(homedir(), ".pi", "voice-cues");
const CUE_START = join(CUE_DIR, "listening.wav");
const CUE_STOP = join(CUE_DIR, "sending.wav");
/** Played instead of "sending" when the clip turned out to hold no usable speech. */
const CUE_NO_AUDIO = join(CUE_DIR, "no-audio.wav");
const BEEP_START = "/System/Library/Sounds/Tink.aiff";
const BEEP_STOP = "/System/Library/Sounds/Pop.aiff";
const BEEP_NO_AUDIO = "/System/Library/Sounds/Basso.aiff";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hands-free triggers (earbud tap, trigger file) only act in the pi session whose
 * terminal tab is focused. Several pi sessions can run at once, each on its own
 * tty, and the trigger channel is global, so without this gate the first session
 * to poll would steal another tab's dictation. There is deliberately no way to
 * disable it.
 *
 * Apps that can host a pi session; anything else means no pi tab is visible.
 */
const TERMINAL_APPS = new Set([
	"Terminal", "iTerm2", "Warp", "Ghostty", "WezTerm", "Alacritty", "kitty",
	"Hyper", "Tabby", "Rio", "kitty", "VSCode", "Code", "Cursor",
]);

/** PI_VOICE_TRACE=1 explains what a trigger actually did. */
const trace = (...args: unknown[]) => {
	if (process.env.PI_VOICE_TRACE === "1") console.error("[voice]", ...args);
};

/**
 * Earbud trigger. Budget headsets (TOZO, Soundcore, …) send AVRCP commands that
 * go bluetoothd → mediaremoted → the active player, never entering the HID
 * media-key stream, so an event tap cannot see them. mediaremoted does log
 * them, and that log is readable without special permissions, so we watch it:
 * a double tap arrives as Command = <NextTrack> from com.apple.bluetoothd.
 *
 * The watcher is on by default: a headset tap is the primary hands-free trigger,
 * so there is nothing to remember to export. Only an explicit opt-out value
 * (0/off/false/no) disables it — useful on a machine with no headset, where the
 * `log stream` child would be dead weight in every session.
 */
const EARBUD_ENABLED = !/^(0|off|false|no)$/i.test((env("PI_VOICE_EARBUD") ?? "").trim());
const EARBUD_KEYS = (env("PI_VOICE_EARBUD_KEYS") ?? "NextTrack,Pause,Play")
	.split(",")
	.map((key) => key.trim())
	.filter(Boolean);

/** Pull an AVRCP command out of one mediaremoted log line, if it came from a headset. */
export function earbudCommandFrom(line: string): string | undefined {
	if (!/SenderBundleIdentifier = <com\.apple\.bluetoothd>/.test(line)) return undefined;
	// Every press logs a Request and then a Response for the same command. Only
	// the Response counts, otherwise one tap would toggle twice.
	if (/\bRequest:/.test(line)) return undefined;
	const match = line.match(/Command = <([A-Za-z]+)>/);
	return match?.[1];
}

function claimMic(): void {
	try {
		writeFileSync(MIC_LOCK, String(process.pid));
	} catch {
		/* best effort */
	}
}

function releaseMic(): void {
	try {
		rmSync(MIC_LOCK, { force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Tells whether a leftover temp file belongs to a session that no longer exists.
 * The pid sits in the name for exactly this reason: a clip only lives as long as
 * the transcription reading it, so any file whose owner is gone is garbage.
 */
function tempOwnerGone(name: string): boolean {
	const match = name.match(/^pi-voice-(?:mlx-)?(\d+)-/);
	if (!match) return false;
	const pid = Number(match[1]);
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return false; // still running, keep its files
	} catch {
		return true;
	}
}

/**
 * Sweep temp audio left behind by sessions that died without cleaning up (kill -9,
 * a closed terminal, a crashed ffmpeg). Dead owners go immediately, live owners
 * keep their files, and anything unexplained expires after an hour. The mic lock
 * and trigger file share the prefix and are harmless to delete when that old.
 */
function sweepTemps(): void {
	try {
		const cutoff = Date.now() - 60 * 60 * 1000;
		for (const name of readdirSync(tmpdir())) {
			if (!name.startsWith(TEMP_PREFIX)) continue;
			const path = join(tmpdir(), name);
			try {
				if (tempOwnerGone(name) || statSync(path).mtimeMs < cutoff) {
					rmSync(path, { recursive: true, force: true });
				}
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
}

/**
 * Persisted overrides written by `/voice-backend`. Environment variables still
 * win, so a one-off `PI_VOICE_BACKEND=api pi` does not fight the saved choice.
 */
interface VoiceConfig {
	backend?: string;
	model?: string;
}

const CONFIG_KEYS: Array<keyof VoiceConfig> = ["backend", "model"];
const configPath = () => join(getAgentDir(), "voice-input.json");

function readConfig(): VoiceConfig {
	try {
		return JSON.parse(readFileSync(configPath(), "utf8")) as VoiceConfig;
	} catch {
		return {};
	}
}

function writeConfig(patch: VoiceConfig): void {
	const next = { ...readConfig(), ...patch };
	for (const key of CONFIG_KEYS) if (next[key] === undefined) delete next[key];
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/** Which layer supplied the backend choice: env, the saved file, or the default. */
function backendSource(): "env" | "file" | "default" {
	if (env("PI_VOICE_BACKEND")) return "env";
	if (readConfig().backend) return "file";
	return "default";
}

function requestedBackend(): string {
	return env("PI_VOICE_BACKEND") ?? readConfig().backend ?? "auto";
}

function configuredModel(): string | undefined {
	return env("PI_VOICE_MODEL") ?? readConfig().model;
}

type BackendKind = "parakeet" | "whisper-cli" | "mlx" | "api";

interface Backend {
	kind: BackendKind;
	/** Path or id, depending on the kind. */
	model: string;
}

const DEFAULT_MODELS: Record<BackendKind, string> = {
	parakeet: "ggml-parakeet-tdt-0.6b-v3-q8_0.bin",
	"whisper-cli": "ggml-base.en.bin",
	mlx: "mlx-community/whisper-large-v3-turbo",
	api: "whisper-1",
};

interface ApiTarget {
	key: string;
	base: string;
	model: string;
}

/**
 * The key decides the endpoint, so a DeepInfra key never reaches api.openai.com
 * and the default model matches whichever service wins.
 */
function resolveApiTarget(): ApiTarget | undefined {
	const base = env("PI_VOICE_API_BASE");
	const model = configuredModel();
	const explicit = env("PI_VOICE_API_KEY");
	const openai = env("OPENAI_API_KEY");
	const deepinfra = env("DEEPINFRA_API_KEY");

	if (explicit) return { key: explicit, base: base ?? "https://api.openai.com/v1", model: model ?? DEFAULT_MODELS.api };
	if (openai) return { key: openai, base: base ?? "https://api.openai.com/v1", model: model ?? "whisper-1" };
	if (deepinfra) {
		// whisper-large-v3-turbo measured ~2.5x realtime; large-v3 ~1.3x on the same clip.
		return { key: deepinfra, base: base ?? "https://api.deepinfra.com/v1/openai", model: model ?? "openai/whisper-large-v3-turbo" };
	}
	return undefined;
}

/** Local whisper.cpp ggml models in the usual download locations. */
const MODEL_SEARCH_PATHS = [
	join(homedir(), "models"),
	join(homedir(), "whisper.cpp", "models"),
	"/opt/homebrew/share/whisper-cpp/models",
	"/usr/local/share/whisper-cpp/models",
	"/usr/share/whisper-cpp/models",
];

/** ggml Parakeet builds, most preferred first (accuracy, then size). */
const PARAKEET_MODEL_FILES = [
	"ggml-parakeet-tdt-0.6b-v3-q8_0.bin",
	"ggml-parakeet-tdt-0.6b-v3.bin",
	"ggml-parakeet-tdt-0.6b-v3-f16.bin",
	"ggml-parakeet-tdt-0.6b-v3-q4_k.bin",
	"ggml-parakeet-tdt-0.6b-v3-q4_0.bin",
];

function findModel(files: string[]): string | undefined {
	return MODEL_SEARCH_PATHS.flatMap((dir) => files.map((file) => join(dir, file))).find((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/** Resolve binaries through the user's PATH. Unknown binaries are absent from the map. */
async function which(pi: ExtensionAPI, names: string[]): Promise<Map<string, string>> {
	const script = names.map((name) => `p=$(command -v '${name}' 2>/dev/null) && printf '%s\\t%s\\n' '${name}' "$p"`).join("; ");
	const result = await pi.exec("/bin/sh", ["-c", script], { timeout: 10_000 });
	const found = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const [name, path] = line.split("\t");
		if (name && path) found.set(name, path);
	}
	return found;
}

async function pickBackend(pi: ExtensionAPI): Promise<Backend> {
	const requested = requestedBackend();
	const tools = await which(pi, ["parakeet-cli", "whisper-cli", "whisper-cpp", "whisper", "mlx_whisper"]);
	const explicitModel = configuredModel();

	// PI_VOICE_MODEL is shared, so route it to the family its filename names.
	const explicitIsParakeet = explicitModel ? /parakeet/i.test(explicitModel) : false;
	const localWhisper = ["whisper-cli", "whisper-cpp", "whisper"].find((name) => tools.has(name));
	const parakeetModel = explicitIsParakeet ? explicitModel : findModel(PARAKEET_MODEL_FILES);
	const localModel = explicitModel && !explicitIsParakeet ? explicitModel : findModel([DEFAULT_MODELS["whisper-cli"]]);
	const apiTarget = resolveApiTarget();

	// In auto mode a half-configured backend is skipped rather than fatal: an
	// installed-but-model-less binary must not break dictation.
	const candidates: Array<{ kind: BackendKind; ready: boolean; resolve: () => Backend; reason: string }> = [
		{
			kind: "whisper-cli",
			ready: Boolean(localWhisper && localModel),
			resolve: () => ({ kind: "whisper-cli", model: localModel! }),
			reason: localWhisper
				? `${localWhisper} is installed but no ggml model was found (run 'whisper-cpp-download-ggml-model base.en' or set PI_VOICE_MODEL)`
				: "no whisper-cli/whisper binary (brew install whisper-cpp)",
		},
		{
			kind: "parakeet",
			ready: Boolean(tools.has("parakeet-cli") && parakeetModel),
			resolve: () => ({ kind: "parakeet", model: parakeetModel! }),
			reason: tools.has("parakeet-cli")
				? "parakeet-cli is installed but no ggml Parakeet model was found in ~/models (ggml-org/parakeet-GGUF) or PI_VOICE_MODEL"
				: "no parakeet-cli binary (brew install whisper-cpp)",
		},
		{
			kind: "mlx",
			ready: tools.has("mlx_whisper"),
			resolve: () => ({ kind: "mlx", model: explicitModel ?? DEFAULT_MODELS.mlx }),
			reason: "no mlx_whisper (pip install mlx-whisper)",
		},
		{
			kind: "api",
			ready: Boolean(apiTarget),
			resolve: () => ({ kind: "api", model: apiTarget!.model }),
			reason: "no API key (set PI_VOICE_API_KEY, OPENAI_API_KEY, or DEEPINFRA_API_KEY)",
		},
	];

	const usable = requested === "auto" ? candidates : candidates.filter((candidate) => candidate.kind === requested);
	if (usable.length === 0) {
		throw new Error(`Unknown PI_VOICE_BACKEND "${requested}". Use auto, parakeet, whisper-cli, mlx, or api`);
	}
	const chosen = usable.find((candidate) => candidate.ready);
	if (chosen) return chosen.resolve();

	throw new Error(
		usable.length === 1
			? `PI_VOICE_BACKEND=${requested}: ${usable[0].reason}`
			: `No transcription backend available: ${usable.map((candidate) => candidate.reason).join("; ")}`,
	);
}

// ---------------------------------------------------------------------------
// Microphone detection and recording
// ---------------------------------------------------------------------------

/**
 * ffmpeg `avfoundation` needs a numeric device index. Prefer the built-in
 * microphone over Bluetooth headsets so recording does not switch the audio route.
 */
/**
 * Enumerating capture devices costs 0.1-1s (it shells out to ffmpeg), and the
 * answer is stable for a session, so resolve it once per process.
 */
let cachedDevice: string | undefined;

async function detectInputDevice(pi: ExtensionAPI): Promise<string> {
	const override = env("PI_VOICE_MIC");
	if (override) return override;
	if (cachedDevice) return cachedDevice;

	if (process.platform !== "darwin") return "default";

	const result = await pi.exec(FFMPEG, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
		timeout: 20_000,
	});
	const devices: Array<{ index: string; name: string }> = [];
	let inAudioSection = false;
	for (const line of result.stderr.split("\n")) {
		if (/AVFoundation audio devices/i.test(line)) {
			inAudioSection = true;
			continue;
		}
		if (/AVFoundation video devices/i.test(line)) {
			inAudioSection = false;
			continue;
		}
		if (!inAudioSection) continue;
		const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
		if (match) devices.push({ index: match[1], name: match[2] });
	}
	if (devices.length === 0) {
		throw new Error("No avfoundation audio input found. Grant microphone access to your terminal in System Settings → Privacy");
	}
	const preferred = devices.find((device) => /macbook|built-?in|internal/i.test(device.name)) ?? devices[0];
	cachedDevice = preferred.index;
	return cachedDevice;
}

function captureArgs(device: string, outFile: string): string[] {
	const input =
		process.platform === "darwin"
			? ["-f", "avfoundation", "-i", `:${device}`]
			: process.platform === "win32"
				? ["-f", "dshow", "-i", `audio=${device}`]
				: ["-f", "pulse", "-i", device];
	return ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", "-y", outFile];
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Byte offset of the PCM samples in a RIFF wav. ffmpeg does not always stop at a
 * 44-byte header — it usually appends a LIST/INFO chunk with its encoder tag — so
 * walk the chunk list instead of assuming, and fall back to 44 for raw PCM.
 */
export function pcmStart(buffer: Buffer): number {
	if (buffer.length < 12 || buffer.toString("latin1", 0, 4) !== "RIFF") return 44;
	let offset = 12;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("latin1", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		if (id === "data") return Math.min(offset + 8, buffer.length);
		offset += 8 + size + (size % 2);
	}
	return 44;
}

/**
 * Peak level of the capture, in dBFS: a 16 kHz mono s16le wav right after the
 * header. Silence is -Infinity, full scale is 0.
 */
export function peakDb(buffer: Buffer): number {
	let start = pcmStart(buffer);
	if (start % 2 === 1) start++; // Int16Array requires an aligned offset
	if (buffer.length - start < 2) return -Infinity;
	const samples = new Int16Array(buffer.buffer, buffer.byteOffset + start, Math.floor((buffer.length - start) / 2));
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i] < 0 ? -samples[i] : samples[i];
		if (sample > peak) peak = sample;
	}
	return peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768);
}

/**
 * Whisper labels non-speech as a bracketed cue — `[BLANK_AUDIO]`, `(silence)`,
 * `[MUSIC PLAYING]`, `♪` — and those arrive as ordinary text, so they would
 * otherwise be inserted or sent as if the user had said them.
 *
 * Matching an enumeration of exact cues does not survive: the model qualifies them
 * (`[MUSIC PLAYING]`, `[MUSIC PLAYING IN THE BACKGROUND]`, `(wind blowing)`), so a
 * block is a cue when it is short and either mentions a sound word or carries no
 * lowercase letters at all (the uppercase style whisper uses for cues). Anything
 * longer or wordier is left alone, so real parenthetical prose survives.
 */
const CUE_WORD =
	/\b(?:blank[\s_]?audio|audio|silence|silent|music|noise|inaudible|unintelligible|indistinct|laugh\w*|applaud\w*|applause|cheer\w*|sound|sounds|effects|static|buzz\w*|hum\w*|beep\w*|click\w*|cough\w*|sigh\w*|breath\w*|rustl\w*|tap\w*|typ\w*|ring\w*|wind|rain|thunder|background|instrumental|speaking|speech|foreign|muffled|crosstalk|clearing|sniff\w*|cry\w*|bark\w*|siren\w*|alarm)\b/;
const CUE_BLOCK = /\[([^\]]{0,80})\]|\(([^)]{0,80})\)/g;
/** Cue blocks are terse: `[MUSIC PLAYING IN THE BACKGROUND]` is five words. */
const CUE_MAX_WORDS = 6;
const MUSIC_NOTE = /[♪♫♬]/g;

export function stripCueBlocks(text: string): string {
	return text.replace(CUE_BLOCK, (block, bracketed: string | undefined, paren: string | undefined) => {
		const inner = (bracketed ?? paren ?? "").trim();
		if (!inner) return block;
		if (inner.split(/\s+/).length > CUE_MAX_WORDS) return block;
		const lower = inner.toLowerCase();
		const looksLikeCue =
			CUE_WORD.test(lower) ||
			// Bracketed uppercase is whisper's cue style, but only when there are letters
			// in it: [1, 2, 3] is a list, and (TODO) is dictation.
			(bracketed !== undefined && /[A-Z]/.test(inner) && inner === inner.toUpperCase());
		return looksLikeCue ? " " : block;
	});
}

export function cleanedTranscript(raw: string): string {
	const text = stripCueBlocks(raw)
		.replace(MUSIC_NOTE, " ")
		.replace(/\s+/g, " ")
		.trim();
	return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

async function transcribe(pi: ExtensionAPI, backend: Backend, wavFile: string, signal?: AbortSignal): Promise<string> {
	if (backend.kind === "parakeet") {
		// A transducer over 25 European languages: no language flag, no decode loop.
		const result = await pi.exec("parakeet-cli", ["-m", backend.model, "-f", wavFile, "-np"], {
			timeout: 180_000,
			signal,
		});
		if (result.code !== 0) throw new Error(`parakeet-cli failed (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
		return result.stdout;
	}

	if (backend.kind === "whisper-cli") {
		const bin = ["whisper-cli", "whisper-cpp", "whisper"];
		const tools = await which(pi, bin);
		const executable = bin.find((name) => tools.has(name));
		if (!executable) throw new Error("whisper binary disappeared from PATH");
		const result = await pi.exec(
			executable,
			["-m", backend.model, "-f", wavFile, "-l", LANG, "-nt", "-np"],
			{ timeout: 180_000, signal },
		);
		if (result.code !== 0) throw new Error(`whisper failed (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
		return result.stdout;
	}

	if (backend.kind === "mlx") {
		const outDir = join(tmpdir(), `pi-voice-mlx-${process.pid}-${Date.now()}`);
		const result = await pi.exec(
			"mlx_whisper",
			[wavFile, "--model", backend.model, "--language", LANG, "--output-format", "txt", "--output-dir", outDir],
			{ timeout: 180_000, signal },
		);
		if (result.code !== 0) throw new Error(`mlx_whisper failed (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
		const textFile = join(outDir, wavFile.split("/").pop()!.replace(/\.wav$/, ".txt"));
		try {
			return readFileSync(textFile, "utf8");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	// OpenAI-compatible /audio/transcriptions endpoint.
	const target = resolveApiTarget();
	if (!target) throw new Error("no API target resolved");
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(readFileSync(wavFile))], { type: "audio/wav" }), "audio.wav");
	form.append("model", backend.model);
	form.append("language", LANG);
	form.append("response_format", "json");
	const prompt = env("PI_VOICE_PROMPT");
	if (prompt) form.append("prompt", prompt);

	const response = await fetch(`${target.base.replace(/\/+$/, "")}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${target.key}` },
		body: form,
		signal,
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`transcription API ${response.status}: ${body.slice(0, 400)}`);
	try {
		return (JSON.parse(body) as { text?: string }).text ?? "";
	} catch {
		throw new Error(`transcription API returned unexpected body: ${body.slice(0, 400)}`);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface Recording {
	controller: AbortController;
	file: string;
	startedAt: number;
	timer: ReturnType<typeof setInterval>;
	done: Promise<ExecResult>;
	/**
	 * Started from a headset/hands-free trigger: the transcript is sent straight
	 * to the model instead of being left in the editor, because the user cannot
	 * see the editor to review or edit it. Keyboard dictation keeps the editor.
	 */
	handsFree: boolean;
	/** When the listening cue finished, which is where transcription may start. */
	cueEndAt?: number;
	/** When the capture was signalled to stop: the end of the audio in the file. */
	stoppedAt?: number;
}

export default function (pi: ExtensionAPI) {
	let recording: Recording | undefined;
	let transcribing: AbortController | undefined;
	let starting = false;
	let unsubscribeInput: (() => void) | undefined;
	/** The installed editor, used to tell whether the chord may claim Enter. */
	let editor: { focused?: boolean } | undefined;
	let restoreEditor: (() => void) | undefined;
	/** Timestamp of the last Enter on an empty editor, 0 when the chord is broken. */
	let lastEnterAt = 0;
	/** Transcripts inserted into the editor since the last submit, so we can tag them. */
	let voiceDraft = "";
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	let hintActive = false;

	const clearHint = (ctx?: ExtensionContext) => {
		if (hintTimer !== undefined) {
			clearTimeout(hintTimer);
			hintTimer = undefined;
		}
		if (!hintActive) return;
		hintActive = false;
		if (ctx) setStatus(ctx, undefined);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};

	const stopCapture = async (ctx: ExtensionContext, current: Recording): Promise<void> => {
		clearInterval(current.timer);
		releaseMic();
		setStatus(ctx, `✍ transcribing…${CANCEL_HINT}`);
		// SIGTERM makes ffmpeg finalize the wav container, so the file stays valid.
		current.stoppedAt = Date.now();
		current.controller.abort();
		await current.done;
	};

	const discardRecording = (ctx: ExtensionContext) => {
		const current = recording;
		if (!current) return;
		recording = undefined;
		releaseMic();
		clearInterval(current.timer);
		current.controller.abort();
		void current.done.finally(() => rmSync(current.file, { force: true }));
		setStatus(ctx, undefined);
	};

	/** Esc, or `/voice` while transcribing: throw the clip away. */
	const cancel = (ctx: ExtensionContext) => {
		if (recording) {
			discardRecording(ctx);
			ctx.ui.notify("Voice: recording discarded", "info");
			return;
		}
		if (transcribing) {
			transcribing.abort();
			transcribing = undefined;
			setStatus(ctx, undefined);
			ctx.ui.notify("Voice: transcription cancelled", "info");
		}
	};

	/**
	 * Why a clip ended: the trigger path plays a different cue for each, so the user
	 * hears what actually happened instead of an optimistic "sending".
	 */
	type Outcome = "sent" | "editor" | "empty" | "error" | "cancelled";

	const handleWav = async (ctx: ExtensionContext): Promise<Outcome> => {
		const current = recording!;
		recording = undefined;
		await stopCapture(ctx, current);

		// Claim the "transcribing" slot before the trim, not after: otherwise the ~50ms
		// of ffmpeg trimming is a window where nothing owns the clip, and a headset tap
		// arriving in it would start a second recording instead of cancelling this one.
		const controller = new AbortController();
		transcribing = controller;
		try {
			// Hands-free only: the listening cue was spoken into a live microphone.
			if (current.cueEndAt) await trimLead(current);
			if (controller.signal.aborted) return "cancelled"; // cancelled during the trim

			// One read: the duration and the silence gate both come off the same bytes,
			// and the RIFF chunk walk covers ffmpeg's LIST/INFO header.
			const wav = readFileSync(current.file);
			const seconds = (wav.length - pcmStart(wav)) / BYTES_PER_SECOND;
			if (seconds < MIN_SECONDS) {
				ctx.ui.notify(`Voice: recording too short (${seconds.toFixed(1)}s) — nothing sent`, "warning");
				void noAudioCue(current.handsFree);
				return "empty";
			}

			// Nothing audible (muted mic, headset off the ear, a stray tap): skip the
			// backend entirely rather than let it invent a sentence out of the floor.
			const level = peakDb(wav);
			if (level < MIN_DB) {
				const shown = Number.isFinite(level) ? `${level.toFixed(0)} dBFS` : "silent";
				ctx.ui.notify(`Voice: no audible audio (${shown}) — nothing sent`, "warning");
				void noAudioCue(current.handsFree);
				return "empty";
			}

			trace("picked backend");
			const backend = await pickBackend(pi);
			let text = cleanedTranscript(await transcribe(pi, backend, current.file, controller.signal));
			// If the trim left a sliver of the cue, whisper opens the transcript with
			// "Listening." — that is the cue, never something the user said.
			if (current.cueEndAt) text = text.replace(/^listening\b[.,!?、。]*\s*/i, "");
			if (controller.signal.aborted) return "cancelled";
			if (!text) {
				ctx.ui.notify("Voice: no speech detected — nothing sent", "warning");
				void noAudioCue(current.handsFree);
				return "empty";
			}

			if (AUTO_SUBMIT || current.handsFree) {
				const payload = VOICE_TAG ? `${VOICE_TAG}\n${text}` : text;
				pi.sendUserMessage(payload, ctx.isIdle() ? undefined : { deliverAs: "steer" });
				// "Sending" means it is on its way: play it here, not at trigger time.
				if (current.handsFree) void cue("stop");
				ctx.ui.notify(
					`Voice → sent (${backend.kind}${current.handsFree ? ", hands-free" : ""})`,
					"info",
				);
				return "sent";
			}
			const existing = ctx.ui.getEditorText().replace(/\s+$/, "");
			// Accumulate across dictations, but only while the earlier transcript is
			// still in the editor; if it was cleared, this starts a new draft.
			voiceDraft = voiceDraft && existing.includes(voiceDraft) ? `${voiceDraft} ${text}` : text;
			ctx.ui.setEditorText(existing ? `${existing} ${text}` : text);
			ctx.ui.notify(`Voice → editor (${backend.kind})${VOICE_TAG ? ` · tagged ${VOICE_TAG}` : ""}`, "info");
			return "editor";
		} catch (error) {
			// An abort is a cancellation, not a failure.
			if (controller.signal.aborted) return "cancelled";
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Voice error: ${message}`, "error");
			if (current.handsFree) void playCue(BEEP_NO_AUDIO);
			return "error";
		} finally {
			if (transcribing === controller) transcribing = undefined;
			setStatus(ctx, undefined);
			rmSync(current.file, { force: true });
		}
	};

	const startRecording = async (ctx: ExtensionContext, handsFree = false) => {
		trace("startRecording", { starting, handsFree });
		if (starting) return;
		if (!ctx.hasUI) {
			ctx.ui.notify("Voice input needs the interactive UI", "warning");
			return;
		}
		clearHint();
		starting = true;
		try {
			// Fail before recording when no backend is usable.
			await pickBackend(pi);
			const device = await detectInputDevice(pi);

			const file = join(tmpdir(), `pi-voice-${process.pid}-${Date.now()}.wav`);
			const controller = new AbortController();
			const startedAt = Date.now();
			const timer = setInterval(() => {
				const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
				setStatus(ctx, `🎙 ${elapsed}s — ${STOP_HINT}`);
			}, 250);
			setStatus(ctx, `🎙 recording… ${STOP_HINT}`);

			// Claim the audio device: read-aloud extensions watch this and go quiet.
			claimMic();

			recording = {
				controller,
				file,
				startedAt,
				timer,
				done: pi.exec(FFMPEG, captureArgs(device, file), { signal: controller.signal }),
				handsFree,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Voice error: ${message}`, "error");
			setStatus(ctx, undefined);
		} finally {
			starting = false;
		}
	};

	/** Short audible blip so the user knows what the headset trigger did. */
	/** This session's tty, so a trigger can be matched to the visible tab. */
	let ownTty: string | undefined;

	const readOwnTty = async (): Promise<void> => {
		try {
			const result = await pi.exec("ps", ["-o", "tty=", "-p", String(process.pid)], { timeout: 5_000 });
			const value = result.stdout.trim().replace(/^\/dev\//, "");
			ownTty = value && value !== "??" ? `/dev/${value}` : undefined;
			trace("own tty", ownTty);
		} catch {
			ownTty = undefined;
		}
	};

	/** tty of the frontmost terminal tab, or undefined if we cannot tell. */
	const frontTty = async (): Promise<{ app: string; tty?: string }> => {
		const script = (code: string) =>
			pi.exec("osascript", ["-e", code], { timeout: 8_000 }).then((r) => r.stdout.trim()).catch(() => "");
		const app = await script('tell application "System Events" to get name of first process whose frontmost is true');
		if (app === "Terminal") {
			return { app, tty: await script('tell application "Terminal" to get tty of selected tab of front window') };
		}
		if (app === "iTerm2") {
			return {
				app,
				tty: await script('tell application "iTerm2" to tell current window to tell current session to get tty'),
			};
		}
		return { app };
	};

	/** True when this session may act on a hands-free trigger. */
	const ownsFocus = async (): Promise<boolean> => {
		const { app, tty } = await frontTty();
		// Something that cannot host pi is frontmost: no pi tab is visible.
		if (!TERMINAL_APPS.has(app)) {
			trace("focus: frontmost app is not a terminal", { app });
			return false;
		}
		if (!tty || !ownTty) {
			// Cannot prove this tab is the visible one, so stay silent. Fail closed:
			// acting here could start dictation in a background session.
			trace("focus: cannot determine tty, ignoring", { app, tty, ownTty });
			return false;
		}
		const mine = tty.replace(/^\/dev\//, "") === ownTty.replace(/^\/dev\//, "");
		trace("focus check", { app, front: tty, own: ownTty, mine });
		return mine;
	};

	const playCue = async (file: string): Promise<void> => {
		if (!file) return;
		try {
			await pi.exec("afplay", [file], { timeout: 10_000 });
		} catch {
			/* feedback is best-effort */
		}
	};

	/** Spoken cue when we have one, otherwise the system blip. */
	const cue = async (phase: "start" | "stop"): Promise<void> => {
		const spoken = phase === "start" ? CUE_START : CUE_STOP;
		await playCue(existsSync(spoken) ? spoken : phase === "start" ? BEEP_START : BEEP_STOP);
	};

	/**
	 * A skipped clip is invisible hands-free — the user cannot see that nothing was
	 * sent — so it gets its own cue. Correct feedback matters more than the sound:
	 * hearing "sending" for a clip that was dropped is a lie, and the user would go
	 * on talking into a session that is never going to answer.
	 */
	const noAudioCue = async (handsFree: boolean): Promise<void> => {
		if (!handsFree) return;
		await playCue(existsSync(CUE_NO_AUDIO) ? CUE_NO_AUDIO : BEEP_NO_AUDIO);
	};

	/**
	 * One external trigger = one toggle. Capture opens first and the listening cue
	 * follows after PI_VOICE_CUE_DELAY_MS, so the cue means "talk now" — the device
	 * is already recording by the time the user hears it. Stopping reports through
	 * handleWav's outcome, which picks the cue.
	 */
	const onExternalTrigger = async (ctx: ExtensionContext): Promise<void> => {
		trace("trigger", { recording: Boolean(recording), transcribing: Boolean(transcribing) });
		// Stopping always belongs to whoever started, even if focus moved away.
		if (!recording && !transcribing && !(await ownsFocus())) {
			trace("trigger ignored: another pi tab is visible");
			return;
		}
		if (recording || transcribing) {
			// handleWav reports the outcome and plays the matching cue: "sending" only
			// when something was actually sent.
			await toggle(ctx);
			return;
		}
		// Siri may still be holding the device, so give it a moment, then open the
		// mic *before* speaking: the cue is the user's "talk now", and the ~1s
		// device startup would otherwise swallow whatever they say first.
		if (TRIGGER_SETTLE_MS > 0) await sleep(TRIGGER_SETTLE_MS);
		await toggle(ctx, true);
		const current = recording;
		if (!current) return;
		if (CUE_DELAY_MS > 0) await sleep(CUE_DELAY_MS);
		if (recording !== current) return; // stopped while the mic was warming up
		await cue("start");
		current.cueEndAt = Date.now();
	};

	/**
	 * Drop the lead-in from a hands-free clip: the cue is spoken into a live mic, so
	 * the opening of the recording is the word "listening" plus the device warmup,
	 * and whisper would transcribe that as the user's first sentence.
	 *
	 * The offset is derived from the file's own duration rather than from any
	 * timestamp taken while recording, because the audio in the file starts when the
	 * device opened, not when ffmpeg was spawned: if the clip runs D seconds and the
	 * cue ended (stoppedAt - cueEndAt) before the stop, the cue ends D - that into
	 * the file, whatever the startup latency was.
	 */
	const trimLead = async (current: Recording): Promise<void> => {
		const { stoppedAt, cueEndAt } = current;
		if (!stoppedAt || !cueEndAt) return;
		let duration: number;
		try {
			const wav = readFileSync(current.file);
			duration = (wav.length - pcmStart(wav)) / BYTES_PER_SECOND;
		} catch {
			return;
		}
		const lead = duration - (stoppedAt - cueEndAt) / 1000;
		// Never eat into what the user said: a third of the clip stays untouched no
		// matter how the timings came out.
		const cut = Math.min(lead, duration * 0.66);
		if (!(cut > 0.2)) return;
		const trimmed = `${current.file}.lead.wav`;
		try {
			await pi.exec(
				FFMPEG,
				[
					"-hide_banner", "-loglevel", "error", "-nostdin",
					"-ss", cut.toFixed(2),
					"-i", current.file,
					"-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", "-y", trimmed,
				],
				{ timeout: 20_000 },
			);
			renameSync(trimmed, current.file);
			trace("trimmed lead-in", { cut, duration });
		} catch (error) {
			rmSync(trimmed, { force: true });
			trace("lead-in trim skipped", error);
		}
	};

	let triggerTimer: ReturnType<typeof setInterval> | undefined;
	let earbudProcess: ChildProcessWithoutNullStreams | undefined;
	let lastEarbudTrigger = 0;

	const startEarbudWatch = (ctx: ExtensionContext) => {
		if (!EARBUD_ENABLED || earbudProcess) return;
		try {
			const child = spawn(
				process.env.PI_VOICE_LOG_CMD ?? "/usr/bin/log",
				[
					"stream",
					"--style",
					"compact",
					// The AVRCP lines are emitted by bluetoothd, not mediaremoted
					// (verified: `process == "mediaremoted"` matches zero of them).
					"--predicate",
					'subsystem == "com.apple.amp.mediaremote" AND eventMessage CONTAINS "SenderBundleIdentifier = <com.apple.bluetoothd>"',
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			let buffer = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const command = earbudCommandFrom(line);
					if (command && EARBUD_KEYS.includes(command)) {
						// One physical press can still surface more than once.
						const now = Date.now();
						if (now - lastEarbudTrigger < 600) return;
						lastEarbudTrigger = now;
						void onExternalTrigger(ctx);
						return;
					}
				}
			});
			child.on("exit", () => {
				if (earbudProcess === child) earbudProcess = undefined;
			});
			child.on("error", () => {
				if (earbudProcess === child) earbudProcess = undefined;
			});
			earbudProcess = child;
		} catch {
			/* the file trigger still works */
		}
	};

	const stopEarbudWatch = () => {
		const child = earbudProcess;
		earbudProcess = undefined;
		if (!child) return;
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	};

	const startTriggerWatch = (ctx: ExtensionContext) => {
		if (!TRIGGER_FILE || triggerTimer) return;
		rmSync(TRIGGER_FILE, { force: true }); // ignore anything stale
		triggerTimer = setInterval(() => {
			if (!existsSync(TRIGGER_FILE)) return;
			trace("trigger file seen", TRIGGER_FILE);
			rmSync(TRIGGER_FILE, { force: true });
			void onExternalTrigger(ctx);
		}, TRIGGER_POLL_MS);
	};

	const stopTriggerWatch = () => {
		if (!triggerTimer) return;
		clearInterval(triggerTimer);
		triggerTimer = undefined;
	};

	const toggle = async (ctx: ExtensionContext, handsFree = false): Promise<Outcome | undefined> => {
		if (starting) return undefined;
		if (recording) return await handleWav(ctx);
		if (transcribing) {
			cancel(ctx);
			return "cancelled";
		}
		await startRecording(ctx, handsFree);
		return undefined;
	};

	/**
	 * Enter/Esc are consumed only while a voice operation is in flight or while the
	 * editor is empty and focused, so normal prompt submission is untouched and
	 * dialogs keep their own Enter.
	 *
	 * Empty focused editor: the first Enter arms the chord, a second Enter within
	 * DOUBLE_ENTER_MS starts recording. Submitting an empty prompt is a no-op in
	 * pi, so swallowing that press costs nothing.
	 */
	const handleTerminalKey = (data: string, ctx: ExtensionContext): { consume?: boolean } | undefined => {
		const isEnter = matchesKey(data, "enter");

		// Stopping or cancelling outranks focus: the recording belongs to us
		// wherever the user's focus happens to be.
		if (recording || transcribing) {
			if (ENTER_STOP && isEnter) {
				if (recording) void handleWav(ctx);
				else cancel(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "escape")) {
				cancel(ctx);
				return { consume: true };
			}
			return undefined;
		}

		if (!ENTER_STOP) {
			lastEnterAt = 0;
			return undefined;
		}

		// A picker or dialog has the keyboard: Enter is its confirm key, not ours.
		if (editor?.focused === false) {
			lastEnterAt = 0;
			clearHint(ctx);
			return undefined;
		}

		if (!isEnter) {
			// Anything else breaks the chord.
			lastEnterAt = 0;
			return undefined;
		}
		if (starting) return { consume: true };
		// A prompt that is being typed submits normally.
		if (ctx.ui.getEditorText().trim().length > 0) {
			lastEnterAt = 0;
			clearHint(ctx);
			return undefined;
		}

		const now = Date.now();
		const isSecondPress = lastEnterAt !== 0 && now - lastEnterAt <= DOUBLE_ENTER_MS;
		lastEnterAt = isSecondPress ? 0 : now;

		if (isSecondPress) {
			clearHint();
			setStatus(ctx, "🎙 starting…");
			void startRecording(ctx);
			return { consume: true };
		}

		hintActive = true;
		setStatus(ctx, "Voice: press Enter again to record");
		if (hintTimer !== undefined) clearTimeout(hintTimer);
		hintTimer = setTimeout(() => {
			lastEnterAt = 0;
			hintTimer = undefined;
			if (!hintActive) return;
			hintActive = false;
			if (!recording && !transcribing) setStatus(ctx, undefined);
		}, DOUBLE_ENTER_MS);
		return { consume: true };
	};

	/**
	 * Tag a dictated prompt on its way to the model. The editor keeps the clean
	 * transcript; only the submitted message carries the marker.
	 *
	 * This is also the last gate before a dictation reaches the model: if what is
	 * being submitted is only the transcript we inserted and that transcript holds
	 * no speech (a stale `[BLANK_AUDIO]` from a clip recorded before a reload, or a
	 * cue a backend invented that cleanedTranscript does not know), the submission is
	 * dropped instead of sent. Returning "handled" aborts the prompt, so the model is
	 * never called.
	 *
	 * Every submission passes through here, dictated or typed, which is why the
	 * voice/text marker for the read-aloud extension is written here too.
	 */
	pi.on("input", async (event, ctx) => {
		const draft = voiceDraft;
		const submitted = squash(event.text);
		const dictated = squash(draft);
		voiceDraft = "";

		// Hands-free sends carry the tag; editor dictation still matches the draft.
		const fromVoice =
			Boolean(dictated && submitted.includes(dictated)) ||
			(VOICE_TAG !== "" && event.text.trimStart().startsWith(VOICE_TAG));
		markSource(fromVoice);

		if (!draft) return undefined;
		if (!cleanedTranscript(submitted.replace(VOICE_TAG, " ")) && submitted.includes(dictated)) {
			if (ctx.hasUI) ctx.ui.notify("Voice: blank audio — nothing sent", "warning");
			return { action: "handled" as const };
		}
		if (!VOICE_TAG || !submitted.includes(dictated)) return undefined;
		// The user may have typed around a junk draft, so strip the cue blocks out of
		// the submission too: "[BLANK_AUDIO] hello" becomes "hello", not garbage the
		// model has to filter itself.
		const text = stripCueBlocks(event.text).trim();
		return { action: "transform" as const, text: `${VOICE_TAG}\n${text}` };
	});

	pi.registerCommand("voice", {
		description: "Toggle voice input recording",
		handler: async (_args, ctx) => {
			await toggle(ctx);
		},
	});

	/** One-line report used by `/voice-doctor` and `/voice-backend`. */
	const describe = async (): Promise<string> => {
		const lines: string[] = [`setting=${requestedBackend()} (${backendSource()})`];
		try {
			const backend = await pickBackend(pi);
			lines.push(`backend=${backend.kind}`, `model=${backend.model}`);
			if (backend.kind === "api") lines.push(`endpoint=${new URL(resolveApiTarget()!.base).host}`);
		} catch (error) {
			lines.push(`backend=unavailable (${error instanceof Error ? error.message : String(error)})`);
		}
		return lines.join("  ");
	};

	const ALIASES: Record<string, string> = {
		local: "parakeet",
		parakeet: "parakeet",
		whisper: "whisper-cli",
		"whisper-cli": "whisper-cli",
		mlx: "mlx",
		remote: "api",
		deepinfra: "api",
		api: "api",
		auto: "auto",
	};

	pi.registerCommand("voice-backend", {
		description: "Switch voice backend: local | whisper | deepinfra | auto | status",
		handler: async (args, ctx) => {
			const choice = args.trim().toLowerCase();
			if (!choice || choice === "status") {
				ctx.ui.notify(`Voice: ${await describe()}`, "info");
				return;
			}

			const backend = ALIASES[choice];
			if (!backend) {
				ctx.ui.notify(`Voice: unknown choice "${choice}". Use local, whisper, deepinfra, auto, or status`, "warning");
				return;
			}

			writeConfig({ backend: backend === "auto" ? undefined : backend });
			const label = backend === "api" ? "deepinfra" : backend;
			const report = await describe();
			if (backendSource() === "env") {
				ctx.ui.notify(`Voice: saved ${label}, but PI_VOICE_BACKEND overrides it — ${report}`, "warning");
				return;
			}
			const usable = !report.includes("backend=unavailable");
			ctx.ui.notify(`Voice: switched to ${label} — ${report}`, usable ? "info" : "warning");
		},
	});

	pi.registerCommand("voice-doctor", {
		description: "Show resolved voice input configuration",
		handler: async (_args, ctx) => {
			const lines: string[] = [await describe()];
			try {
				lines.push(`mic=${await detectInputDevice(pi)}`);
			} catch (error) {
				lines.push(`mic=unavailable (${error instanceof Error ? error.message : String(error)})`);
			}
			lines.push(
				`lang=${LANG}`,
				`enter-enter=${ENTER_STOP ? `on (${DOUBLE_ENTER_MS}ms, editor focused only)` : "off"}`,
				`submit=${AUTO_SUBMIT ? "on" : "off"}`,
			);
			// Hands-free routing: which tab would answer an earbud tap right now.
			lines.push(
				`earbud=${EARBUD_ENABLED ? `on (${EARBUD_KEYS.join("/")}, default)` : "off (PI_VOICE_EARBUD=0)"}`,
			);
			await readOwnTty();
			const front = await frontTty();
			const owns = await ownsFocus();
			lines.push(
				`tty=${ownTty ?? "unknown"}`,
				`front=${front.app}${front.tty ? `@${front.tty}` : ""}`,
				owns ? "hands-free=THIS TAB" : "hands-free=another tab (this one stays silent)",
			);
			ctx.ui.notify(`Voice: ${lines.join("  ")}`, "info");
		},
	});

	/**
	 * Track the editor component so `handleTerminalKey` can tell whether the chord
	 * may claim Enter. Raw terminal listeners run before the focused component, so
	 * without this the chord would swallow Enter in every dialog too.
	 */
	const installEditorProbe = (ctx: ExtensionContext) => {
		if (editor || !ENTER_STOP) return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const created = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor = created as { focused?: boolean };
			return created;
		});
		restoreEditor = () => ctx.ui.setEditorComponent(previous);
	};

	pi.on("session_start", async (_event, ctx) => {
		// Clips from sessions that died mid-dictation are garbage; ours are not.
		sweepTemps();
		// Terminal input listeners and custom editors only exist in the interactive UI.
		if (ctx.mode !== "tui") return;
		installEditorProbe(ctx);
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => handleTerminalKey(data, ctx));
		await readOwnTty();
		startTriggerWatch(ctx);
		startEarbudWatch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTriggerWatch();
		stopEarbudWatch();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		releaseMic();
		restoreEditor?.();
		restoreEditor = undefined;
		editor = undefined;
		clearHint(ctx);
		lastEnterAt = 0;
		if (transcribing) {
			transcribing.abort();
			transcribing = undefined;
		}
		if (recording) {
			clearInterval(recording.timer);
			recording.controller.abort();
			rmSync(recording.file, { force: true });
			recording = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
