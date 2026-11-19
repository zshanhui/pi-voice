import assert from "node:assert/strict";
import test from "node:test";

import {
	cleanedTranscript,
	earbudCommandFrom,
	pcmStart,
	peakDb,
	stripCueBlocks,
} from "../extensions/voice-input.ts";

/** Build a 16 kHz mono s16le wav with an optional LIST/INFO chunk, like ffmpeg writes. */
function wav(samples: Int16Array, { listChunk = false } = {}): Buffer {
	const format = Buffer.alloc(24);
	format.write("fmt ", 0, "latin1");
	format.writeUInt32LE(16, 4); // chunk size
	format.writeUInt16LE(1, 8); // PCM
	format.writeUInt16LE(1, 10); // mono
	format.writeUInt32LE(16000, 12); // sample rate
	format.writeUInt32LE(16000 * 2, 16); // byte rate
	format.writeUInt16LE(2, 20); // block align
	format.writeUInt16LE(16, 22); // bits

	const info = Buffer.alloc(listChunk ? 12 : 0);
	if (listChunk) {
		info.write("LIST", 0, "latin1");
		info.writeUInt32LE(4, 4);
		info.write("INFO", 8, "latin1");
	}

	const data = Buffer.alloc(8);
	data.write("data", 0, "latin1");
	data.writeUInt32LE(samples.byteLength, 4);

	const body = Buffer.concat([Buffer.from("WAVE", "latin1"), format, info, data, Buffer.from(samples.buffer)]);
	const riff = Buffer.alloc(8);
	riff.write("RIFF", 0, "latin1");
	riff.writeUInt32LE(body.length, 4);
	return Buffer.concat([riff, body]);
}

const SAMPLE_RATE = 16000;

test("pcmStart finds the data chunk behind a LIST header, and falls back to 44", () => {
	const samples = new Int16Array(SAMPLE_RATE);
	assert.equal(pcmStart(wav(samples)), 44);
	// ffmpeg's LIST/INFO chunk shifts the samples by 12 bytes.
	assert.equal(pcmStart(wav(samples, { listChunk: true })), 56);
	// A truncated file has no data chunk yet; do not throw.
	assert.equal(pcmStart(Buffer.from("RIFF")), 44);
});

test("peakDb separates silence, a noise floor, and speech-sized levels", () => {
	const silence = new Int16Array(SAMPLE_RATE * 2); // all zeros
	assert.equal(peakDb(wav(silence)), -Infinity);

	const floor = new Int16Array(SAMPLE_RATE * 2).map(() => (Math.random() - 0.5) * 200); // ~-50 dBFS
	const floorDb = peakDb(wav(floor));
	assert.ok(floorDb < -44 && floorDb > -60, `floor measured ${floorDb}`);

	const speech = new Int16Array(SAMPLE_RATE * 2);
	for (let i = 0; i < speech.length; i++) speech[i] = Math.round(Math.sin(i / 12) * 12000); // ~-8 dBFS
	const speechDb = peakDb(wav(speech));
	assert.ok(speechDb > -12, `speech measured ${speechDb}`);

	// Full scale clamps at 0 dBFS rather than going positive.
	assert.equal(peakDb(wav(new Int16Array([-32768]))), 0);
});

test("peakDb ignores the header even when ffmpeg adds one", () => {
	const silence = new Int16Array(SAMPLE_RATE);
	// The header of a real capture is non-zero, so reading from offset 0 would
	// report a loud clip. This is the bug that made every clip look like -1.9 dBFS.
	assert.equal(peakDb(wav(silence, { listChunk: true })), -Infinity);
});

test("cleanedTranscript drops whisper's non-speech cues however they are phrased", () => {
	for (const cue of [
		"[BLANK_AUDIO]",
		"[BLANK AUDIO]",
		"[MUSIC PLAYING]",
		"[MUSIC PLAYING IN THE BACKGROUND]",
		"[LAUGHTER AND APPLAUSE]",
		"[NOISE]",
		"(silence)",
		"(buzzing)",
		"(wind blowing)",
		"(KEYBOARD CLICKING)",
		"♪♪",
		"...",
		"-",
		"   ",
	]) {
		assert.equal(cleanedTranscript(cue), "", `should be dropped: ${cue}`);
	}
});

test("cleanedTranscript keeps real speech, including brackets the user dictated", () => {
	for (const text of [
		"Please run the tests.",
		"Thank you.",
		"中文测试",
		"[1, 2, 3] please sort these",
		"(playing with fire) is risky",
		"add a comment (TODO) here",
		"Use foo() here",
		"[ok] ship it",
	]) {
		assert.notEqual(cleanedTranscript(text), "", `should be kept: ${text}`);
	}
});

test("cue blocks are stripped from the middle of a sentence, sentence survives", () => {
	assert.equal(stripCueBlocks("[BLANK_AUDIO] hello").trim(), "hello");
	assert.equal(cleanedTranscript("[blank_audio] the user said hi"), "the user said hi");
});

test("earbudCommandFrom accepts only bluetoothd responses, not requests", () => {
	const response =
		'mediaremoted Command = <NextTrack> SenderBundleIdentifier = <com.apple.bluetoothd> Response:';
	const request =
		'mediaremoted Command = <NextTrack> SenderBundleIdentifier = <com.apple.bluetoothd> Request:';
	const other = 'mediaremoted Command = <Play> SenderBundleIdentifier = <com.apple.Music> Response:';
	assert.equal(earbudCommandFrom(response), "NextTrack");
	assert.equal(earbudCommandFrom(request), undefined);
	assert.equal(earbudCommandFrom(other), undefined);
});
