import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { commentField } from "../src/editor/state";
import { markerDeleteGuard } from "../src/editor/marker-guard";
import { parseComments, isOrphan } from "../src/format/parse";

// What CodeMirror's delete commands produce at an anchor edge: the atomic hidden
// marker makes a single keypress delete the WHOLE marker range. We simulate that
// exact transaction and assert the guard rewrites it to eat visible text instead.

const DOC = "A <!--c:x-->quick<!--/c:x--> fox.\n" + '<!--co:x status:open quote:"quick"\nme: watch this word\n-->\n';

const state = (doc: string): EditorState => EditorState.create({ doc, extensions: [commentField, markerDeleteGuard] });

const applyDelete = (doc: string, from: number, to: number, dir: "backward" | "forward"): string =>
	state(doc)
		.update({ changes: { from, to }, userEvent: `delete.${dir}` })
		.state.doc.toString();

const OPEN = { from: DOC.indexOf("<!--c:x-->"), to: DOC.indexOf("<!--c:x-->") + "<!--c:x-->".length };
const CLOSE = { from: DOC.indexOf("<!--/c:x-->"), to: DOC.indexOf("<!--/c:x-->") + "<!--/c:x-->".length };

describe("markerDeleteGuard", () => {
	it("backspace at the anchor start deletes the visible char before, not the marker", () => {
		const out = applyDelete(DOC, OPEN.from, OPEN.to, "backward");
		expect(out).toContain("A<!--c:x-->quick<!--/c:x--> fox."); // space gone, markers intact
		expect(isOrphan(parseComments(out)[0])).toBe(false);
	});

	it("backspace at the anchor end deletes the last anchored char, not the marker", () => {
		const out = applyDelete(DOC, CLOSE.from, CLOSE.to, "backward");
		expect(out).toContain("A <!--c:x-->quic<!--/c:x--> fox.");
	});

	it("forward delete at the anchor start deletes the first anchored char", () => {
		const out = applyDelete(DOC, OPEN.from, OPEN.to, "forward");
		expect(out).toContain("A <!--c:x-->uick<!--/c:x--> fox.");
	});

	it("forward delete at the anchor end deletes the visible char after", () => {
		const out = applyDelete(DOC, CLOSE.from, CLOSE.to, "forward");
		expect(out).toContain("A <!--c:x-->quick<!--/c:x-->fox.");
	});

	it("backspace after the hidden body block eats prose, not the whole thread", () => {
		// The body hide range swallows its leading newline (state.ts addHide).
		const bodyStart = DOC.indexOf("<!--co:x");
		const bodyEnd = DOC.indexOf("-->", bodyStart) + "-->".length;
		const out = applyDelete(DOC, bodyStart - 1, bodyEnd, "backward");
		expect(out).toContain("<!--co:x"); // thread survives
		expect(out).toContain("A <!--c:x-->quick<!--/c:x--> fox\n"); // the "." went instead
	});

	it("is a no-op when there is nothing visible beyond the chain", () => {
		const doc = '<!--c:y-->word<!--/c:y-->\n<!--co:y status:open quote:"word"\nme: hi\n-->\n';
		const open = { from: 0, to: "<!--c:y-->".length };
		expect(applyDelete(doc, open.from, open.to, "backward")).toBe(doc);
	});

	it("leaves a deliberate selection deletion alone (comment becomes an orphan)", () => {
		// Select from before the open marker to after the close marker and delete.
		const out = applyDelete(DOC, OPEN.from, CLOSE.to, "backward");
		expect(out).toContain("A  fox.");
		const c = parseComments(out)[0];
		expect(isOrphan(c)).toBe(true);
	});

	it("ignores non-delete transactions", () => {
		const s = state(DOC);
		const out = s.update({ changes: { from: OPEN.from, to: OPEN.to, insert: "" } }).state.doc.toString();
		expect(out).not.toContain("<!--c:x-->"); // no userEvent → passes through untouched
	});
});
