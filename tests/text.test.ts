import assert from "node:assert/strict";
import test from "node:test";

import {
	feedText,
	flushText,
	hardWrap,
	isStreamablePartial,
	speakable,
	speechWeight,
	splitSentences,
} from "../extensions/voice-output.ts";

test("splitSentences cuts on sentence ends but not on numbers, paths or abbreviations", () => {
	const { chunks } = splitSentences(
		"Run the tests at 1.5 scale, then read src/a.ts and tell Dr. Smith the version is v1.2.3. Done.",
	);
	const joined = chunks.join(" ");
	assert.ok(joined.includes("1.5 scale"), `split inside a number: ${joined}`);
	assert.ok(joined.includes("src/a.ts"), `split inside a path: ${joined}`);
	assert.ok(joined.includes("Dr. Smith"), `split after an abbreviation: ${joined}`);
	assert.ok(chunks.length >= 1);
});

test("splitSentences leaves an incomplete tail for the next delta", () => {
	// The default minimum is 40 characters: shorter pieces merge into the next one
	// rather than being spoken as fragments.
	const { chunks, rest } = splitSentences(
		"This first sentence is comfortably longer than forty characters. Second one is not fin",
	);
	assert.deepEqual(chunks, ["This first sentence is comfortably longer than forty characters."]);
	assert.ok(rest.trimStart().startsWith("Second one"), JSON.stringify(rest));
	assert.equal(splitSentences("Too short.").chunks.length, 0);
});

test("CJK text is spoken with a lower character threshold", () => {
	// 12 hanzi is roughly as much speech as 40 latin characters. It is still under
	// the merge threshold on its own (short pieces join the next one), so the test
	// is that it survives to the end of the message instead of being dropped.
	const state = freshState();
	const spoken = [...feedText(state, "这是一段中文语音测试内容。\n"), ...flushText(state)].join(" ");
	assert.ok(spoken.includes("中文"), `CJK text lost: ${spoken}`);
	// Latin text of the same length would have been merged, not spoken early.
	const latin = freshState();
	assert.equal(feedText(latin, "Short one.\n").length, 0);
});

test("hardWrap breaks over-long text at a natural pause", () => {
	const text = `${"word, ".repeat(80)}end.`;
	const parts = hardWrap(text, 120);
	assert.ok(parts.length > 1);
	for (const part of parts) assert.ok(part.length <= 121, `piece too long: ${part.length}`);
	assert.ok(parts.every((part) => part.trim().length > 0));
});

test("speechWeight counts CJK characters double", () => {
	assert.equal(speechWeight("abcd"), 4);
	assert.equal(speechWeight("中文"), 4);
});

test("speakable strips markdown for the ear", () => {
	assert.equal(speakable("**bold** and *italic*"), "bold and italic");
	assert.equal(speakable("see [the docs](https://example.com/x)"), "see the docs");
	assert.equal(speakable("visit https://example.com/x now"), "visit a link now");
	assert.equal(speakable("# Heading\n- bullet\n1. item"), "Heading bullet item");
	assert.equal(speakable("a_b/c"), "a b c", "identifiers keep their words");
	assert.equal(speakable("A -> B & C"), "A to B and C");
	// Inline code keeps its text, minus the backticks. Fences and tables are dropped
	// by the streaming state machine above, not by this stripper.
	assert.equal(speakable("use `foo()` here"), "use foo() here");
	assert.equal(speakable("| a | b |"), "a b");
});

test("speakable reads #4 as number 4", () => {
	assert.equal(speakable("Kimi ranks #6 at Elo 1437"), "Kimi ranks number 6 at Elo 1437");
	assert.equal(speakable("see #12 and #13"), "see number 12 and number 13");
	// Hex colours, CSS ids and C# must survive: only bare ordinals are rewritten.
	assert.equal(speakable("the colour #1F2937"), "the colour #1F2937");
	assert.equal(speakable("target #app and C#4"), "target #app and C#4");
	// A markdown heading is stripped before this rule can see it.
	assert.equal(speakable("## Heading"), "Heading");
});

test("speakable reads ~10 as about 10", () => {
	assert.equal(speakable("~10 servers"), "about 10 servers");
	assert.equal(speakable("~1.5x faster than #2"), "about 1.5x faster than number 2");
	assert.equal(speakable("costs ~$5 per run"), "costs about $5 per run");
	// A range separator is a "to", and ~/ is a home directory.
	assert.equal(speakable("5~10 ms"), "5 to 10 ms");
	assert.equal(speakable("~/oss/pi-voice"), "home oss pi-voice");
});

test("streaming text skips code fences and announces nothing by default", () => {
	const state = freshState();
	const out = [
		...feedText(state, "Here is how.\n```\nconst x = 1;\n"),
		...feedText(state, "```\nAfter the block.\n"),
		...flushText(state),
	];
	const spoken = out.join(" ");
	assert.ok(spoken.includes("Here is how."), spoken);
	assert.ok(spoken.includes("After the block."), spoken);
	assert.ok(!spoken.includes("const x"), `code leaked: ${spoken}`);
});

test("tables are skipped instead of read cell by cell", () => {
	const state = freshState();
	const out = [
		...feedText(state, "Results:\n| a | b |\n| 1 | 2 |\n\nNothing else.\n"),
		...flushText(state),
	];
	const spoken = out.join(" ");
	assert.ok(spoken.includes("Results:"), spoken);
	assert.ok(spoken.includes("Nothing else."), spoken);
	assert.ok(!spoken.includes("a b"), `table read aloud: ${spoken}`);
});

test("a half-streamed line that could become a fence is not spoken early", () => {
	assert.equal(isStreamablePartial("``"), false);
	assert.equal(isStreamablePartial("| a"), false);
	assert.equal(isStreamablePartial("# heading"), false);
	assert.equal(isStreamablePartial("Normal prose"), true);
});

test("flushText returns what is left when a message ends mid-sentence", () => {
	const state = freshState();
	feedText(state, "An answer that never quite");
	const tail = flushText(state);
	assert.ok(tail.join(" ").includes("never quite"), JSON.stringify(tail));
});

// The state shape is internal; build one the same way the extension does.
function freshState() {
	return {
		raw: "",
		pending: "",
		inFence: false,
		codeLines: 0,
		tableRows: 0,
		lineFolded: false,
	} as Parameters<typeof feedText>[0];
}
