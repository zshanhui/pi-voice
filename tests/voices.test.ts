import assert from "node:assert/strict";
import test from "node:test";

import { voiceOptions } from "../extensions/voice-output.ts";

const MODEL = ["zf_xiaobei", "am_michael", "af_heart", "zm_yunxi", "bm_george", "af_bella"];

test("every voice is listed, sorted so the language prefixes group", () => {
	assert.deepEqual(voiceOptions(MODEL), [
		"af_bella",
		"af_heart",
		"am_michael",
		"bm_george",
		"zf_xiaobei",
		"zm_yunxi",
	]);
});

test("the Chinese picker only offers Mandarin voices", () => {
	assert.deepEqual(voiceOptions(MODEL, true), ["zf_xiaobei", "zm_yunxi"]);
});

test("an empty list stays empty instead of inventing voices", () => {
	assert.deepEqual(voiceOptions([]), []);
	assert.deepEqual(voiceOptions([], true), []);
});

test("sorting is stable and does not mutate the caller's array", () => {
	const input = ["bm_george", "af_heart"];
	assert.deepEqual(voiceOptions(input), ["af_heart", "bm_george"]);
	assert.deepEqual(input, ["bm_george", "af_heart"]);
});
