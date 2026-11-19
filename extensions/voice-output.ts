/**
 * Pi voice output — reads assistant replies aloud (local Kokoro + macOS `afplay`).
 *
 * v1 proof of concept. Speaks assistant prose sentence-by-sentence while the
 * message is still streaming, so audio starts before the response finishes.
 * Markdown is stripped for the ear: code fences and tables are skipped
 * entirely, links collapse to their text, paths and identifiers lose their
 * punctuation. Paragraphs, lists and headings are read.
 *
 * ---------------------------------------------------------------------------
 * TO REMOVE (nothing else on disk is touched, no config file is written):
 *   rm ~/.pi/agent/extensions/voice-output.ts
 * Or ask pi to run `/speak uninstall`, which prints that command.
 * Temp wavs live in $TMPDIR/pi-speak-* and are removed after playback; stale
 * ones are swept at session start. Nothing persists any other state.
 * ---------------------------------------------------------------------------
 *
 * Commands:
 *   /speak              toggle on/off
 *   /speak on|off       set explicitly
 *   /speak status       show settings
 *   /speak stop         stop speaking now
 *   /speak last         re-speak the previous reply
 *   /speak rate 240     words per minute (Kokoro derives playback speed from it)
 *   /speak voice af_heart   change the default (English) voice
 *   /speak zh zf_xiaobei     change the voice used for Chinese replies
 *   /speak lang         show the language (fixed at startup)
 *   /speak uninstall    print removal instructions
 *
 * Engine: Kokoro, local neural TTS. One long-lived Python sidecar per session,
 * so the 1.7s model load + 3.2s ONNX warmup is paid once while you are still
 * typing, not on the first sentence. ~0.45s to synthesize 3s of audio.
 *
 * There is no fallback engine: if Kokoro is not installed the extension stays
 * silent and says so, instead of substituting the macOS `say` voices.
 *
 * Installing Kokoro (~247MB, required):
 *   uv venv --python 3.12 ~/.pi/voice-kokoro
 *   uv pip install --python ~/.pi/voice-kokoro/bin/python kokoro-onnx
 *   cd ~/.pi/voice-kokoro
 *   M=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
 *   curl -L -C - -o kokoro-v1.0.int8.onnx "$M/kokoro-v1.0.int8.onnx"   # 92361271 bytes
 *   curl -L -C - -o voices-v1.0.bin       "$M/voices-v1.0.bin"         # 28214398 bytes
 *   and copy sidecar.py next to them (the extension spawns it, JSON lines on stdin)
 *
 * Keys:
 *   ctrl+s            stop playback (change with PI_SPEAK_STOP_KEY)
 *   enter             stop playback too, while audio is running. The key is not
 *                     consumed: the editor still gets it, so a draft submits, an
 *                     empty submit stays a no-op, and voice-input's double-Enter
 *                     chord still works. Dialogs keep their own Enter.
 *                     PI_SPEAK_ENTER=0 disables it.
 *
 * Only dictated prompts are answered aloud: voice-input.ts records on every
 * submission whether the prompt was spoken or typed, and a typed prompt's reply is
 * streamed silently (the text still lands in the transcript and lastReply, so
 * /speak last can read it on demand). Without voice-input installed there is no
 * marker and everything is spoken as before. PI_SPEAK_ONLY_VOICE=0 disables this.
 *
 * Environment (all optional):
 *   PI_SPEAK=0            start disabled
 *   PI_SPEAK_KOKORO_DIR   default ~/.pi/voice-kokoro
 *   PI_SPEAK_VOICE        default am_michael; /speak voice also persists here
 *                         (~/.pi/agent/voice-output.json), env still wins
 *   PI_SPEAK_RATE         words per minute, default 200
 *   PI_SPEAK_SPEED_EN     English tempo multiplier on top of the rate, default 1.33.
 *                         Kokoro's speed->duration mapping is stepped, not linear:
 *                         1.25 = +17% pace, 1.33 = +27%, 1.34 = +39%. Tune by ear.
 *   PI_SPEAK_SPEED_ZH     Chinese tempo multiplier, default 1.0 (Mandarin stretches at speed)
 *   PI_SPEAK_LANG         default en-us; zh maps to espeak's cmn
 *   PI_SPEAK_VOICE_ZH     voice for Chinese replies, default zf_xiaoxiao
 *   PI_SPEAK_AUTO_LANG=0  disable per-reply language detection
 *   PI_SPEAK_CODE=announce  say "Code block, N lines." instead of silence
 *   PI_SPEAK_MIN_CHARS    minimum chunk length, default 40
 *   PI_SPEAK_MAX_CHARS    maximum chunk length, default 320
 *   PI_SPEAK_STOP_KEY     default "ctrl+s"
 *   PI_SPEAK_ENTER=0      do not let Enter stop playback
 *   PI_SPEAK_ONLY_VOICE=0 speak every reply, even ones answering typed prompts
 *   PI_SPEAK_DEBUG=1      log to stderr
 *
 * Known limitation of v1: dictating with voice-input.ts while playback is
 * running feeds the speakers back into the microphone. Both extensions now
 * coordinate through $TMPDIR/pi-voice-mic.lock: voice-input claims it while
 * recording, playback pauses (and replays the interrupted sentence after).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const env = (name: string): string | undefined => {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
};

/** Only set when the user actually set it, so the saved file can be consulted. */
const ENV_RATE = (() => {
	const raw = env("PI_SPEAK_RATE");
	const value = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
})();

/**
 * Settings written by /speak, so a voice/rate choice sticks across sessions
 * without environment variables. Precedence: env → this file → built-in default.
 */
interface OutputConfig {
	voice?: string;
	zhVoice?: string;
	rate?: number;
}

const CONFIG_KEYS: Array<keyof OutputConfig> = ["voice", "zhVoice", "rate"];
const configPath = () => join(homedir(), ".pi", "agent", "voice-output.json");

function readConfig(): OutputConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as OutputConfig;
		return typeof parsed === "object" && parsed ? parsed : {};
	} catch {
		return {};
	}
}

function saveConfig(patch: OutputConfig): void {
	const next: OutputConfig = { ...readConfig(), ...patch };
	for (const key of CONFIG_KEYS) if (next[key] === undefined) delete next[key];
	try {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
	} catch {
		/* a read-only home should not break playback */
	}
}

const SAVED = readConfig();

// --- engine ----------------------------------------------------------------
//
// Kokoro only. One long-lived Python sidecar so the 1.7s model load is paid
// once per session. Needs ~/.pi/voice-kokoro (install commands in the header).
// There is deliberately no fallback engine: if Kokoro is missing the extension
// stays silent and says so, rather than substituting a voice nobody chose.

const KOKORO_DIR = env("PI_SPEAK_KOKORO_DIR") ?? join(homedir(), ".pi", "voice-kokoro");
const KOKORO_PY = join(KOKORO_DIR, "bin", "python");
const KOKORO_SIDECAR = join(KOKORO_DIR, "sidecar.py");
const KOKORO_MODEL_FILE = join(KOKORO_DIR, "kokoro-v1.0.int8.onnx");
const KOKORO_VOICES_FILE = join(KOKORO_DIR, "voices-v1.0.bin");

function kokoroInstalled(): boolean {
	return [KOKORO_PY, KOKORO_SIDECAR, KOKORO_MODEL_FILE, KOKORO_VOICES_FILE].every((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}

/** espeak needs `cmn` for Mandarin; Kokoro's own voices are tagged zh-*. */
function speakLang(requested: string | undefined): string {
	const value = (requested ?? "en-us").toLowerCase();
	if (value === "en") return "en-us";
	if (value === "zh" || value === "zh-cn" || value === "cmn") return "cmn";
	return value;
}

const SPEAK_LANG = speakLang(env("PI_SPEAK_LANG"));

/**
 * Per-language speed multipliers, applied on top of the wpm setting. English
 * reads fast enough to feel slow at 1.0; Mandarin stretches badly, so it gets
 * its own factor and stays where it is by default.
 */
const speedFactor = (name: string, fallback: number): number => {
	const value = Number(env(name) ?? String(fallback));
	return Number.isFinite(value) && value > 0 ? Math.max(0.5, Math.min(2.0, value)) : fallback;
};
const SPEED_EN = speedFactor("PI_SPEAK_SPEED_EN", 1.33);
const SPEED_ZH = speedFactor("PI_SPEAK_SPEED_ZH", 1.0);

/**
 * Cross-extension audio lock, written by voice-input.ts while it records.
 * We poll it so the microphone never picks up our own playback.
 */
const MIC_LOCK = join(tmpdir(), "pi-voice-mic.lock");
const MIC_LOCK_TTL_MS = 15_000;

/**
 * Read-aloud follows the input: a reply to a typed prompt stays silent, a reply to a
 * dictated one is spoken. voice-input.ts writes this marker on every submission,
 * since that is the only place that knows how the prompt arrived. No marker at all
 * means voice-input is not installed, and then speaking stays the old behaviour.
 */
const SOURCE_FILE = join(tmpdir(), `pi-voice-${process.pid}-source`);
const ONLY_VOICE = env("PI_SPEAK_ONLY_VOICE") !== "0";

function promptWasTyped(): boolean {
	if (!ONLY_VOICE) return false;
	try {
		return readFileSync(SOURCE_FILE, "utf8").trim() === "text";
	} catch {
		return false; // no marker: nobody told us this was typed
	}
}

function micActive(): boolean {
	try {
		return Date.now() - statSync(MIC_LOCK).mtimeMs < MIC_LOCK_TTL_MS;
	} catch {
		return false;
	}
}

/** Enough CJK to mean the sentence is Chinese, not English with a quoted term. */
function isChinese(text: string): boolean {
	const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
	if (cjk < 4) return false;
	const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
	return cjk > latin / 2;
}

const DEFAULT_VOICE = env("PI_SPEAK_VOICE") ?? SAVED.voice ?? "am_michael";

/**
 * Automatic per-chunk language: a Chinese reply gets a Chinese voice even when
 * the session default is English.
 */
let ZH_VOICE = env("PI_SPEAK_VOICE_ZH") ?? SAVED.zhVoice ?? "zf_xiaoxiao";
const AUTO_LANG = env("PI_SPEAK_AUTO_LANG") !== "0";
const MIN_CHARS = Math.max(10, Number(env("PI_SPEAK_MIN_CHARS") ?? "40"));
const MAX_CHARS = Math.max(MIN_CHARS * 2, Number(env("PI_SPEAK_MAX_CHARS") ?? "320"));
const ANNOUNCE_CODE = env("PI_SPEAK_CODE") === "announce";
const STOP_KEY = env("PI_SPEAK_STOP_KEY") ?? "ctrl+s";
/**
 * Enter silences playback, the way a headset tap starts dictation: while audio is
 * running, one Enter stops it. The key is not consumed, so submitting a prompt,
 * an empty-editor no-op, and voice-input's double-Enter chord all behave as before.
 */
const ENTER_STOP = env("PI_SPEAK_ENTER") !== "0";
const DEBUG = env("PI_SPEAK_DEBUG") === "1";

const log = (...args: unknown[]) => {
	if (DEBUG) console.error("[voice-output]", ...args);
};

const TMP_PREFIX = "pi-speak-";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Text preparation — pure functions, no pi dependencies
// ---------------------------------------------------------------------------

/** Split points that should not end a spoken sentence. */
const ABBREVIATIONS = new Set([
	"e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "st", "cf", "approx",
	"fig", "figs", "al", "inc", "ltd", "jr", "sr", "no", "vol", "ch", "sec",
]);

/**
 * A line may be spoken while it is still streaming unless its first printable
 * character could turn it into a code fence, table, heading or quote, where
 * speaking the raw prefix would be wrong.
 */
export function isStreamablePartial(line: string): boolean {
	if (!line.trim()) return false;
	return !/^\s*[`~|#>=]/.test(line);
}

function endsWithAbbreviation(textBeforePeriod: string): boolean {
	const token = textBeforePeriod.match(/([A-Za-z][A-Za-z.]*)$/)?.[1];
	if (!token) return false;
	const bare = token.toLowerCase().replace(/\.+$/, "");
	if (ABBREVIATIONS.has(bare)) return true;
	// Single-letter initial: "J. Smith", "U.S." handled by the dotted form above.
	return /^[A-Za-z]$/.test(bare) && !/\d/.test(textBeforePeriod.slice(-2));
}

/** Break an over-long sentence at the last natural pause. */
export function hardWrap(piece: string, maxChars = MAX_CHARS): string[] {
	const out: string[] = [];
	let rest = piece;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		const cut = Math.max(
			window.lastIndexOf(", "),
			window.lastIndexOf("; "),
			window.lastIndexOf(" — "),
			window.lastIndexOf(","),
			window.lastIndexOf("、"),
			window.lastIndexOf(" "),
		);
		if (cut < maxChars * 0.4) break; // no sensible pause, keep it whole
		out.push(rest.slice(0, cut + 1).trim());
		rest = rest.slice(cut + 1).trimStart();
	}
	if (rest) out.push(rest);
	return out;
}

/**
 * Spoken weight of a string: CJK characters carry a syllable each, so they
 * count double against the character thresholds. Without this a 30-character
 * Chinese sentence looks "too short to speak" and an 80-character one blows
 * past Kokoro's phoneme limit.
 */
export function speechWeight(text: string): number {
	const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g)?.length ?? 0;
	return text.length + cjk;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g;

/**
 * Chinese/Japanese carry a syllable per character, so the Latin-calibrated
 * minimum is far too high: 40 Latin characters is ~2.5s of speech, but only
 * ~12 CJK characters are. Lower the bar for CJK-heavy text.
 */
function thresholdFor(piece: string, minChars: number): number {
	const cjk = piece.match(CJK_RE)?.length ?? 0;
	return cjk > piece.length * 0.3 ? Math.max(12, Math.round(minChars * 0.75)) : minChars;
}

/**
 * Pull complete sentences off the front of `text`. The trailing fragment is
 * returned untouched so the next delta can extend it.
 */
export function splitSentences(
	text: string,
	minChars = MIN_CHARS,
	maxChars = MAX_CHARS,
): { chunks: string[]; rest: string } {
	const chunks: string[] = [];
	let start = 0;
	let i = 0;

	while (i < text.length) {
		const ch = text[i];
		let end = -1;

		if (ch === "\n") {
			end = i;
		} else if (/[.!?。！？]/.test(ch)) {
			const next = text[i + 1];
			if (next === undefined) break; // too early to tell, wait for more input
			const cjkEnd = ch === "。" || ch === "！" || ch === "？";
			// Chinese punctuation does not need a following space.
			if (!cjkEnd && !/\s/.test(next)) {
				i++;
				continue; // 1.5, src/a.ts, v1.2.3 — not a boundary
			}
			if (ch === "." && endsWithAbbreviation(text.slice(Math.max(0, i - 12), i))) {
				i++;
				continue;
			}
			end = i + 1;
			while (end < text.length && /["'”’)\]*_]/.test(text[end])) end++; // keep closing marks
		} else {
			i++;
			continue;
		}

		const piece = text.slice(start, end).trim();
		if (speechWeight(piece) >= thresholdFor(piece, minChars)) {
			chunks.push(...hardWrap(piece, maxChars));
			start = end;
			i = end;
		} else {
			i++; // too short to stand alone, merge with what follows
		}
	}

	return { chunks, rest: text.slice(start) };
}

/**
 * Strip markdown so the result reads well aloud. Returns "" when nothing
 * speakable is left, which callers use as a "skip this chunk" signal.
 */
export function speakable(text: string): string {
	let s = text;
	s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
	s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links keep their label
	s = s.replace(/https?:\/\/\S+/g, " a link "); // bare urls
	s = s.replace(/^\s{0,3}#{1,6}\s+/gm, " "); // headings
	s = s.replace(/^\s{0,3}>\s?/gm, " "); // blockquotes
	s = s.replace(/^\s*[-*+]\s+/gm, " "); // bullets (stream-safe to strip)
	s = s.replace(/^\s*\d+[.)]\s+/gm, " "); // ordered list markers
	s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1"); // **bold**
	s = s.replace(/\*([^*\n]+)\*/g, "$1"); // *italic*
	// Underscore emphasis only when it is not inside an identifier, so that
	// PI_SPEAK_RATE keeps its word boundaries.
	s = s.replace(/(?<![A-Za-z0-9])__([^_\n]+)__(?![A-Za-z0-9])/g, "$1");
	s = s.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, "$1");
	s = s.replace(/~~([^~\n]+)~~/g, "$1"); // strikethrough
	s = s.replace(/`([^`]*)`/g, "$1"); // inline code keeps its text
	s = s.replace(/[`|]/g, " "); // leftover fences / table pipes
	s = s.replace(/->|=>|←|→/g, " to ");
	s = s.replace(/&/g, " and ");
	s = s.replace(/[·•]/g, " ");
	s = s.replace(/[_/\\]/g, " "); // paths and identifiers: a_b/c -> "a b c"
	s = s.replace(/\s+/g, " ").trim();
	// Any script counts: CJK has no latin letters but is perfectly speakable.
	return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

// ---------------------------------------------------------------------------
// Streaming text builder: markdown lines -> speakable chunks
// ---------------------------------------------------------------------------

interface TextState {
	/** Current incomplete line. */
	raw: string;
	/** Unemitted, already line-classified prose. */
	pending: string;
	inFence: boolean;
	codeLines: number;
	/** Rows skipped in the table currently being read past. */
	tableRows: number;
	/** Part of the current line was already spoken, so it cannot be a fence opener. */
	lineFolded: boolean;
}

const freshTextState = (): TextState => ({
	raw: "",
	pending: "",
	inFence: false,
	codeLines: 0,
	tableRows: 0,
	lineFolded: false,
});

/**
 * Markdown tables are unlistenable: the header and every cell arrive as loose
 * fragments ("Benchmark DaisyRose base Qwen"). Skip whole rows instead. A line
 * counts as a table row when it starts with a pipe, or carries two or more
 * pipes (which also catches rows written without a leading pipe).
 */
function isTableRow(line: string): boolean {
	if (/^\s*\|/.test(line)) return true;
	return (line.match(/\|/g)?.length ?? 0) >= 2;
}

/** Announce a skipped table once, at the point it ends. */
function flushTableAnnouncement(state: TextState, out: string[]): void {
	if (state.tableRows === 0) return;
	const rows = state.tableRows;
	state.tableRows = 0;
	if (ANNOUNCE_CODE) out.push(`Table, ${rows} row${rows === 1 ? "" : "s"}.`);
}

function drainSentences(state: TextState, out: string[]): void {
	const { chunks, rest } = splitSentences(state.pending);
	state.pending = rest;
	for (const chunk of chunks) {
		const spoken = speakable(chunk);
		if (spoken) out.push(spoken);
	}
}

/** Feed a stream delta, get back chunks that are ready to be spoken. */
export function feedText(state: TextState, delta: string): string[] {
	const out: string[] = [];
	state.raw += delta;

	for (;;) {
		const nl = state.raw.indexOf("\n");
		if (nl < 0) break;
		const line = state.raw.slice(0, nl);
		state.raw = state.raw.slice(nl + 1);

		if (state.inFence) {
			if (/^\s*(```|~~~)/.test(line)) {
				state.inFence = false;
				if (ANNOUNCE_CODE && state.codeLines > 0) {
					out.push(`Code block, ${state.codeLines} line${state.codeLines === 1 ? "" : "s"}.`);
				}
				state.codeLines = 0;
			} else if (line.trim()) {
				state.codeLines++;
			}
			state.lineFolded = false;
			continue;
		}
		// A fence only opens at the true start of a line: if the line's prefix was
		// already spoken as prose, a trailing ``` is inline code, not a fence.
		if (!state.lineFolded && /^\s*(```|~~~)/.test(line)) {
			state.inFence = true;
			state.lineFolded = false;
			continue;
		}
		state.lineFolded = false;
		if (isTableRow(line)) {
			state.tableRows++; // rows are never spoken
			continue;
		}
		flushTableAnnouncement(state, out);
		state.pending += `${line}\n`;
		drainSentences(state, out);
	}

	if (!state.inFence) flushTableAnnouncement(state, out);

	// Prose may be spoken while its line is still incomplete; anything that
	// could still become a fence/table/heading waits for its newline.
	if (!state.inFence && state.raw && (state.lineFolded || isStreamablePartial(state.raw))) {
		state.pending += state.raw;
		state.raw = "";
		state.lineFolded = true;
		drainSentences(state, out);
	}

	return out;
}

/** Flush at end of message. */
export function flushText(state: TextState): string[] {
	const out: string[] = [];
	flushTableAnnouncement(state, out);
	if (state.raw) {
		if (state.inFence) {
			if (state.raw.trim()) state.codeLines++;
			state.inFence = false;
		} else {
			state.pending += `${state.raw}\n`;
		}
		state.raw = "";
	}
	state.lineFolded = false;
	drainSentences(state, out);
	const tail = speakable(state.pending.replace(/\s+/g, " ").trim());
	if (tail) out.push(tail);
	state.pending = "";
	return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Files from a dead process are garbage regardless of age; a live pid may still own them. */
function ownerGone(name: string): boolean {
	const match = name.match(/^pi-speak-(\d+)-/);
	if (!match) return false;
	const pid = Number(match[1]);
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return false; // still running
	} catch {
		return true;
	}
}

interface Playback {
	controller: AbortController;
	/** True when the microphone interrupted this chunk, not the user. */
	mic: boolean;
}

export default function (pi: ExtensionAPI) {
	let enabled = env("PI_SPEAK") !== "0";
	let voice = DEFAULT_VOICE;
	let rate =
		ENV_RATE ??
		(typeof SAVED.rate === "number" && SAVED.rate >= 80 && SAVED.rate <= 500 ? SAVED.rate : 200);

	/** Bumped on every stop/new message; stale loops compare against it. */
	let generation = 0;
	let textQueue: string[] = [];
	let wavQueue: string[] = [];
	let streaming = false;
	/** This reply answers a typed prompt, so it is not read aloud (see promptWasTyped). */
	let muted = false;
	// The two loops retire independently: synthesis finishes at message_end while
	// playback is still running, so "any loop alive" is the wrong question when
	// deciding whether to start them.
	let synthAlive = false;
	let playAlive = false;
	/** Chunks being synthesized right now; keeps the player from retiring early. */
	let activeSynth = 0;
	/** The afplay currently running, so the mic watcher can cut it short. */
	let playback: Playback | undefined;
	let micWatch: ReturnType<typeof setInterval> | undefined;
	let controller: AbortController | undefined;
	let statusCtx: ExtensionContext | undefined;
	let lastReply = "";
	let tmpSeq = 0;
	/**
	 * Live editor component, only to read `focused`. Raw terminal listeners fire
	 * before the focused component, so without this an Enter meant for a picker
	 * (`/model`, `/settings`, a confirm dialog) would be swallowed by the stop key.
	 */
	let editor: { focused?: boolean } | undefined;
	let restoreEditor: (() => void) | undefined;
	let unsubscribeInput: (() => void) | undefined;

	let text: TextState = freshTextState();
	/** Guards the message_end fallback: did deltas actually reach us? */
	let sawDelta = false;

	// --- Kokoro sidecar ----------------------------------------------------
	//
	// One Python process for the whole session: model load (1.7s) plus ONNX
	// warmup (3.2s) happen once, then each sentence costs ~0.45s.

	interface KokoroReply {
		ok?: boolean;
		id?: number;
		ready?: boolean;
		load_ms?: number;
		warm_ms?: number;
		err?: string;
		fatal?: string;
	}

	let sidecar: ChildProcessWithoutNullStreams | undefined;
	let sidecarBuffer = "";
	let sidecarSeq = 0;
	const waiting = new Map<
		number,
		{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	const settleAll = (error: Error) => {
		for (const [, entry] of waiting) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		waiting.clear();
	};

	const handleSidecarLine = (line: string) => {
		if (!line.trim()) return;
		let message: KokoroReply;
		try {
			message = JSON.parse(line) as KokoroReply;
		} catch {
			log("sidecar non-json:", line.slice(0, 200));
			return;
		}
		if (message.ready) {
			log("kokoro ready", { load_ms: message.load_ms, warm_ms: message.warm_ms });
			return;
		}
		if (message.fatal) {
			log("kokoro fatal:", message.fatal);
			statusCtx?.ui.notify(`Voice output: kokoro unavailable (${message.fatal})`, "warning");
			return;
		}
		const entry = message.id === undefined ? undefined : waiting.get(message.id);
		if (!entry) return;
		waiting.delete(message.id!);
		clearTimeout(entry.timer);
		if (message.ok) entry.resolve();
		else entry.reject(new Error(message.err ?? "kokoro failed"));
	};

	const stopSidecar = () => {
		settleAll(new Error("kokoro sidecar stopped"));
		const child = sidecar;
		sidecar = undefined;
		sidecarBuffer = "";
		if (!child) return;
		try {
			child.stdin.end();
		} catch {
			/* already gone */
		}
		child.kill();
	};

	const ensureSidecar = (): ChildProcessWithoutNullStreams => {
		if (sidecar && !sidecar.killed) return sidecar;
		log("starting kokoro sidecar", KOKORO_PY);
		const child = spawn(KOKORO_PY, [KOKORO_SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
		sidecarBuffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			sidecarBuffer += chunk;
			for (;;) {
				const nl = sidecarBuffer.indexOf("\n");
				if (nl < 0) break;
				const line = sidecarBuffer.slice(0, nl);
				sidecarBuffer = sidecarBuffer.slice(nl + 1);
				handleSidecarLine(line);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => log("sidecar stderr:", chunk.trim().slice(0, 200)));
		child.on("exit", (code) => {
			if (sidecar === child) sidecar = undefined;
			settleAll(new Error(`kokoro sidecar exited (${code})`));
		});
		child.on("error", (error) => {
			if (sidecar === child) sidecar = undefined;
			settleAll(new Error(`kokoro sidecar error: ${error.message}`));
		});
		sidecar = child;
		return child;
	};

	const kokoroSynth = (
		textToSpeak: string,
		out: string,
		voiceName: string,
		lang: string,
		speed: number,
		signal: AbortSignal,
	): Promise<void> => {
		const child = ensureSidecar();
		const id = ++sidecarSeq;
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("aborted"));
				return;
			}
			const timer = setTimeout(() => {
				waiting.delete(id);
				reject(new Error("kokoro timed out after 120s"));
			}, 120_000);
			const onAbort = () => {
				waiting.delete(id);
				clearTimeout(timer);
				reject(new Error("aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			waiting.set(id, {
				resolve: () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				reject: (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			child.stdin.write(
				`${JSON.stringify({ id, text: textToSpeak, voice: voiceName, speed, lang, out })}\n`,
			);
		});
	};

	const setStatus = (text: string | undefined) => {
		const ctx = statusCtx;
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("speak", text);
	};

	const cleanupTemps = () => {
		// Only this process's files: a second pi session must keep its own audio.
		for (const wav of wavQueue) rmSync(wav, { force: true });
		try {
			const mine = `${TMP_PREFIX}${process.pid}-`;
			for (const name of readdirSync(tmpdir())) {
				if (name.startsWith(mine)) rmSync(join(tmpdir(), name), { force: true });
			}
		} catch {
			/* ignore */
		}
	};

	const stop = (ctx?: ExtensionContext, notify?: string) => {
		generation++;
		controller?.abort();
		controller = undefined;
		playback = undefined;
		stopMicWatch();
		// Old loops exit on the aborted signal but skip clearing these flags
		// (their generation is stale), so reset them here.
		synthAlive = false;
		playAlive = false;
		textQueue = [];
		wavQueue = [];
		activeSynth = 0;
		streaming = false;
		cleanupTemps();
		if (ctx) statusCtx = ctx;
		setStatus(undefined);
		if (notify && ctx?.hasUI) ctx.ui.notify(notify, "info");
	};

	/**
	 * Voice, language and tempo for one chunk: Chinese gets its own voice and speed.
	 */
	const voiceFor = (text: string): { voice: string; lang: string; speed: number } => {
		// Kokoro speed is a multiplier around a ~200 wpm base voice.
		const base = rate / 200;
		const clamp = (value: number) => Math.max(0.6, Math.min(1.6, value));
		if (AUTO_LANG && isChinese(text)) return { voice: ZH_VOICE, lang: "cmn", speed: clamp(base * SPEED_ZH) };
		return { voice, lang: SPEAK_LANG, speed: clamp(base * SPEED_EN) };
	};

	/** Synthesize one chunk to a temp wav. */
	const synthesize = async (chunk: string, signal: AbortSignal): Promise<string> => {
		const wavFile = join(tmpdir(), `${TMP_PREFIX}${process.pid}-${tmpSeq++}.wav`);
		// Owner-only and exclusive: the name is predictable, so claim it before the
		// sidecar opens it, instead of letting a planted symlink be written through.
		try {
			closeSync(openSync(wavFile, "wx", 0o600));
		} catch {
			/* exists: the sidecar truncates it */
		}
		const choice = voiceFor(chunk);
		log("synth", { voice: choice.voice, lang: choice.lang, speed: choice.speed, text: chunk.slice(0, 40) });
		await kokoroSynth(chunk, wavFile, choice.voice, choice.lang, choice.speed, signal);
		return wavFile;
	};

	const synthLoop = async (myGen: number, signal: AbortSignal) => {
		log("synthLoop enter", myGen);
		while (!signal.aborted && myGen === generation) {
			if (wavQueue.length >= 2) {
				await sleep(40); // prefetch stays one utterance ahead
				continue;
			}
			const chunk = textQueue.shift();
			if (chunk === undefined) {
				if (!streaming) {
					log("synthLoop exit", { myGen, generation, aborted: signal.aborted });
					return;
				}
				await sleep(40);
				continue;
			}
			activeSynth++;
			try {
				const wav = await synthesize(chunk, signal);
				if (myGen !== generation || signal.aborted) {
					rmSync(wav, { force: true });
					return;
				}
				wavQueue.push(wav);
			} catch (error) {
				if (signal.aborted) return;
				log("synthesis failed", error);
				statusCtx?.ui.notify(`Voice output: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				activeSynth--;
			}
		}
	};

	const playLoop = async (myGen: number, signal: AbortSignal) => {
		let idleStreak = 0;
		while (!signal.aborted && myGen === generation) {
			const wav = wavQueue.shift();
			if (wav === undefined) {
				// Retire only once nothing is queued, nothing is streaming and no
				// synthesis is in flight ('idle' twice, so a chunk landing between two
				// polls cannot slip through).
				const idle = !streaming && textQueue.length === 0 && wavQueue.length === 0 && activeSynth === 0;
				idleStreak = idle ? idleStreak + 1 : 0;
				if (idleStreak >= 2) {
					log("playLoop exit", { myGen, generation, aborted: signal.aborted });
					return;
				}
				await sleep(50);
				continue;
			}
			idleStreak = 0;

			// The microphone owns the audio device while voice-input records.
			if (micActive()) {
				setStatus("🔇 paused — recording");
				while (micActive() && !signal.aborted && myGen === generation) await sleep(150);
				if (signal.aborted || myGen !== generation) {
					rmSync(wav, { force: true });
					return;
				}
				setStatus("🔊 speaking");
			}

			const playing: Playback = { controller: new AbortController(), mic: false };
			const onAbort = () => playing.controller.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			playback = playing;
			let replay = false;
			try {
				await pi.exec("afplay", [wav], { timeout: 300_000, signal: playing.controller.signal });
			} catch (error) {
				if (playing.mic) {
					replay = true; // interrupted by the mic: say this sentence again later
				} else if (!signal.aborted) {
					log("playback failed", error);
				}
			} finally {
				signal.removeEventListener("abort", onAbort);
				if (playback === playing) playback = undefined;
				if (replay) wavQueue.unshift(wav);
				else rmSync(wav, { force: true });
			}
		}
	};

	const startMicWatch = () => {
		if (micWatch) return;
		micWatch = setInterval(() => {
			if (!micActive()) return;
			const current = playback;
			if (!current) return;
			current.mic = true;
			current.controller.abort();
		}, 150);
	};

	const stopMicWatch = () => {
		if (!micWatch) return;
		clearInterval(micWatch);
		micWatch = undefined;
	};

	const loopsRunning = () => synthAlive || playAlive;

	const ensureRunning = (ctx: ExtensionContext) => {
		if (!enabled) return;
		statusCtx = ctx;
		setStatus("🔊 speaking");
		if (!controller || controller.signal.aborted) controller = new AbortController();
		const myGen = generation;
		const { signal } = controller;
		startMicWatch();

		const retired = () => {
			log("loop exited", { myGen, generation, synthAlive, playAlive });
			if (synthAlive || playAlive) return;
			stopMicWatch();
			// Work can arrive between a loop's idle check and its exit; never strand it.
			if (textQueue.length > 0 || wavQueue.length > 0) {
				log("restarting loops for stranded work", { text: textQueue.length, wav: wavQueue.length });
				if (statusCtx) ensureRunning(statusCtx);
				return;
			}
			log("loops retired");
		};

		if (!synthAlive) {
			synthAlive = true;
			void synthLoop(myGen, signal).finally(() => {
				if (myGen === generation) synthAlive = false;
				retired();
			});
		}
		if (!playAlive) {
			playAlive = true;
			void playLoop(myGen, signal).finally(() => {
				if (myGen === generation) playAlive = false;
				retired();
			});
		}
	};

	const enqueue = (ctx: ExtensionContext, chunks: string[]) => {
		if (!enabled || chunks.length === 0) return;
		log("enqueue", {
			chunks: chunks.length,
			synthAlive,
			playAlive,
			textQueue: textQueue.length,
			wavQueue: wavQueue.length,
		});
		textQueue.push(...chunks);
		ensureRunning(ctx);
	};

	const speakNow = (ctx: ExtensionContext, textToSpeak: string) => {
		const chunks: string[] = [];
		const state = freshTextState();
		chunks.push(...feedText(state, textToSpeak));
		chunks.push(...flushText(state));
		if (chunks.length === 0) {
			if (ctx.hasUI) ctx.ui.notify("Voice output: nothing to speak", "warning");
			return;
		}
		streaming = true;
		textQueue.push(...chunks);
		streaming = false;
		ensureRunning(ctx);
	};

	// --- enter to stop -------------------------------------------------------

	/**
	 * Track the editor component so the stop key can tell whether the editor has
	 * the keyboard. Chained like voice-input.ts: whatever factory was installed
	 * before is wrapped, never dropped.
	 */
	const installEditorProbe = (ctx: ExtensionContext) => {
		if (editor) return;
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

	/**
	 * Enter is the "stop talking" key while audio is running. The press is never
	 * consumed: the editor still gets it (an empty submit is a no-op, a draft still
	 * sends, and voice-input.ts keeps its double-Enter chord for dictation). Dialogs
	 * are left alone, so Enter still confirms a picker instead of silencing audio.
	 */
	const handleTerminalKey = (data: string, ctx: ExtensionContext): { consume?: boolean } | undefined => {
		if (!ENTER_STOP || !loopsRunning()) return undefined;
		if (!matchesKey(data, "enter")) return undefined;
		if (editor?.focused === false) return undefined; // a dialog owns the keyboard
		log("enter stops playback");
		stop(ctx);
		return undefined;
	};

	// --- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Raw terminal input and custom editors only exist in the interactive UI.
		if (ctx.mode === "tui") {
			installEditorProbe(ctx);
			unsubscribeInput?.();
			unsubscribeInput = ctx.ui.onTerminalInput((data) => handleTerminalKey(data, ctx));
		}
		// Playback is afplay, so macOS is still required.
		if (process.platform !== "darwin") {
			if (ctx.hasUI) ctx.ui.notify("Voice output: needs macOS afplay — extension idle", "info");
			return;
		}
		if (!kokoroInstalled()) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Voice output: Kokoro not installed at ${KOKORO_DIR} — extension idle`, "warning");
			}
			return;
		}
		// Sweep wavs left behind by a crashed session: dead owners go immediately,
		// live owners keep theirs, and anything unexplained expires after an hour.
		try {
			const cutoff = Date.now() - 60 * 60 * 1000;
			for (const name of readdirSync(tmpdir())) {
				if (!name.startsWith(TMP_PREFIX)) continue;
				const path = join(tmpdir(), name);
				try {
					const stale = ownerGone(name) || statSync(path).mtimeMs < cutoff;
					if (stale) rmSync(path, { force: true });
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
		statusCtx = ctx;
		log("ready", { enabled, voice, rate, lang: SPEAK_LANG });

		// Pay the model load and ONNX warmup now, while the user is still typing,
		// instead of on the first sentence of the first reply.
		if (enabled && ctx.mode === "tui") {
			try {
				ensureSidecar();
				log("kokoro warmup started");
			} catch (error) {
				log("kokoro warmup failed", error);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
		stopSidecar();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		restoreEditor?.();
		restoreEditor = undefined;
		editor = undefined;
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		text = freshTextState();
		sawDelta = false;
		streaming = true;
		statusCtx = ctx;
		// Snapshot the input source now, not at message_end: the marker can change
		// while a long reply streams if the user submits the next prompt early.
		muted = promptWasTyped();
		log("reply", { muted });
	});

	pi.on("message_update", async (event, ctx) => {
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent?.type !== "text_delta") return;
		if (!enabled) return;
		sawDelta = true;
		if (muted) return; // typed prompt: keep tracking text, just stay quiet
		const chunks = feedText(text, streamEvent.delta);
		if (chunks.length > 0) {
			log("speaking", chunks.map((c) => (c.length > 60 ? `${c.slice(0, 60)}…` : c)));
			enqueue(ctx, chunks);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		streaming = false;
		statusCtx = ctx;

		const whole = event.message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (whole.trim()) lastReply = whole;

		// Safety net: if no deltas reached us (or the stream produced no text),
		// speak the authoritative message instead of staying silent.
		let chunks: string[];
		if (sawDelta) {
			chunks = flushText(text);
		} else {
			const fallback = freshTextState();
			chunks = [...feedText(fallback, whole), ...flushText(fallback)];
		}
		text = freshTextState();
		if (chunks.length > 0 && !muted) enqueue(ctx, chunks);

		// Let the loops drain, then clear the indicator.
		const myGen = generation;
		void (async () => {
			while (myGen === generation && (streaming || textQueue.length > 0 || wavQueue.length > 0 || loopsRunning())) {
				await sleep(120);
			}
			if (myGen === generation) setStatus(undefined);
		})();
	});

	// Barge-in: submitting anything silences playback.
	pi.on("input", async (_event, ctx) => {
		if (controller && loopsRunning()) stop(ctx);
		return { action: "continue" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (controller && loopsRunning()) stop(ctx);
	});

	// Belt and braces: an aborted run may skip message_end, which would leave the
	// player waiting for text that never arrives.
	pi.on("agent_settled", async (_event, ctx) => {
		streaming = false;
		statusCtx = ctx;
	});

	// --- commands ------------------------------------------------------------

	const describe = () =>
		`${enabled ? "on" : "off"} · voice=${voice}${AUTO_LANG ? ` (zh: ${ZH_VOICE})` : ""} · rate=${rate}wpm (en ×${SPEED_EN}, zh ×${SPEED_ZH}) · lang=${SPEAK_LANG} · stop=${STOP_KEY}${ENTER_STOP ? "+enter" : ""}`;

	pi.registerCommand("speak", {
		description: "Read assistant replies aloud (on|off|status|stop|last|rate|voice|uninstall)",
		handler: async (args, ctx) => {
			const [head, ...rest] = args.trim().split(/\s+/);
			const arg = (head ?? "").toLowerCase();
			const value = rest.join(" ").trim();

			if (!arg) {
				enabled = !enabled;
				if (!enabled) stop(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Voice output: ${describe()}`, "info");
				return;
			}
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				if (!enabled) stop(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Voice output: ${describe()}`, "info");
				return;
			}
			if (arg === "status") {
				if (ctx.hasUI) ctx.ui.notify(`Voice output: ${describe()}`, "info");
				return;
			}
			if (arg === "stop") {
				stop(ctx, "Voice output: stopped");
				return;
			}
			if (arg === "last") {
				if (!lastReply) {
					if (ctx.hasUI) ctx.ui.notify("Voice output: no previous reply in this session", "warning");
					return;
				}
				speakNow(ctx, lastReply);
				return;
			}
			if (arg === "rate") {
				const next = Number(value);
				if (!Number.isFinite(next) || next < 80 || next > 500) {
					if (ctx.hasUI) ctx.ui.notify("Voice output: rate must be 80–500 words per minute", "warning");
					return;
				}
				rate = Math.round(next);
				saveConfig({ rate });
				if (ctx.hasUI) ctx.ui.notify(`Voice output: ${describe()} · saved`, "info");
				return;
			}
			if (arg === "voice") {
				if (!value) {
					if (ctx.hasUI) ctx.ui.notify("Voice output: usage /speak voice <name>", "warning");
					return;
				}
				voice = value;
				saveConfig({ voice });
				if (ctx.hasUI) ctx.ui.notify(`Voice output: ${describe()} · saved`, "info");
				return;
			}
			if (arg === "zh") {
				if (!value) {
					if (ctx.hasUI) ctx.ui.notify(`Voice output: Chinese voice is ${ZH_VOICE}`, "info");
					return;
				}
				ZH_VOICE = value;
				saveConfig({ zhVoice: value });
				if (ctx.hasUI) ctx.ui.notify(`Voice output: ${describe()} · saved`, "info");
				return;
			}
			if (arg === "lang") {
				if (!value) {
					if (ctx.hasUI) ctx.ui.notify(`Voice output: lang is ${SPEAK_LANG} (set PI_SPEAK_LANG to change)`, "info");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify("Voice output: language is fixed at startup — set PI_SPEAK_LANG", "warning");
				return;
			}
			if (arg === "uninstall") {
				stop(ctx);
				stopSidecar();
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Voice output: remove with  rm ${join(process.env.HOME ?? "~", ".pi/agent/extensions/voice-output.ts")} ${configPath()}  (and optionally  rm -rf ${KOKORO_DIR}  for the model); no settings were changed`,
						"info",
					);
				}
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Voice output: usage /speak [on|off|status|stop|last|rate N|voice NAME|zh NAME|lang|uninstall]",
					"warning",
				);
			}
		},
	});

	pi.registerShortcut(STOP_KEY as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Stop voice output playback",
		handler: async (ctx) => {
			if (loopsRunning()) stop(ctx, "Voice output: stopped");
		},
	});
}
