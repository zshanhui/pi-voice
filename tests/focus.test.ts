import assert from "node:assert/strict";
import test from "node:test";

import { focusAllowsSpeech } from "../extensions/voice-output.ts";

// One tab speaks at a time: a background session must not start narrating.
test("the focused tab is allowed to speak", () => {
	assert.equal(focusAllowsSpeech({ app: "Terminal", tty: "/dev/ttys019", own: "/dev/ttys019" }), true);
	assert.equal(focusAllowsSpeech({ app: "iTerm2", tty: "/dev/ttys002", own: "ttys002" }), true);
});

test("another tab of the same terminal is not", () => {
	assert.equal(focusAllowsSpeech({ app: "Terminal", tty: "/dev/ttys042", own: "/dev/ttys019" }), false);
});

test("an app that cannot host pi in front means no pi tab is visible", () => {
	for (const app of ["Safari", "Slack", "Finder", "Notes"]) {
		assert.equal(focusAllowsSpeech({ app, tty: "/dev/ttys019", own: "/dev/ttys019" }), false, app);
	}
	// Editor hosts are in the terminal list: pi can run in their integrated terminal,
	// which reports no tty, so that case falls through to the fail-open rule.
	assert.equal(focusAllowsSpeech({ app: "Cursor", tty: "/dev/ttys019", own: "/dev/ttys019" }), true);
});

test("unknowable focus fails open, so missing Automation permission cannot mute", () => {
	// macOS denies the System Events query without asking: the app name is empty.
	assert.equal(focusAllowsSpeech({ app: "", tty: "/dev/ttys042", own: "/dev/ttys019" }), true);
	// Some terminals expose no tty (Warp, embedded terminals).
	assert.equal(focusAllowsSpeech({ app: "Warp", tty: undefined, own: "/dev/ttys019" }), true);
	assert.equal(focusAllowsSpeech({ app: "Terminal", tty: "/dev/ttys019", own: undefined }), true);
});

test("a terminal that reports no tty is trusted rather than silenced", () => {
	assert.equal(focusAllowsSpeech({ app: "Ghostty", own: "/dev/ttys019" }), true);
});
