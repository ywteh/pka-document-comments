import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { commentField } from "../src/editor/state";

// Two comments anchored on overlapping text — `xoua6` sits nested inside `zz1q`,
// both covering "resolved". This is the shape that crashed CodeMirror's
// decoration build (RangeSetBuilder can't take overlapping ranges).
const NESTED = [
	`Already <!--c:zz1q--><!--c:xoua6-->resolved<!--/c:xoua6--><!--/c:zz1q--> text here.`,
	`<!--co:zz1q by:kyle at:2026-06-17T09:00:00.000Z status:resolved quote:"resolved"`,
	`kyle: Handled.`,
	`-->`,
	`<!--co:xoua6 by:me at:2026-06-17T19:08:26.472Z status:open quote:"resolved"`,
	`me: yooooo`,
	`-->`,
].join("\n");

describe("commentField decorations", () => {
	test("overlapping/nested comment anchors build and map without crashing", () => {
		// EditorState.create runs compute(); .map() is what CodeMirror does to the
		// decoration set on setViewData — both must survive overlapping anchors.
		expect(() => {
			const state = EditorState.create({ doc: NESTED, extensions: [commentField] });
			const field = state.field(commentField);
			const { changes } = state.update({ changes: { from: 0, to: 0, insert: "" } });
			field.decorations.map(changes);
			field.atomic.map(changes);
		}).not.toThrow();
	});

	test("still highlights both overlapping comments", () => {
		const state = EditorState.create({ doc: NESTED, extensions: [commentField] });
		const cids: string[] = [];
		const cursor = state.field(commentField).decorations.iter();
		while (cursor.value) {
			const cid = cursor.value.spec?.attributes?.["data-cid"];
			if (cid) cids.push(cid);
			cursor.next();
		}
		expect(cids).toContain("zz1q");
		expect(cids).toContain("xoua6");
	});
});

const WITH_EDIT = [
	"We will <!--c:c1--><!--e:e1-->definitely<!--/e:e1--> ship<!--/c:c1-->.",
	'<!--co:c1 status:open quote:"definitely ship"',
	'~ @e1 was:"definitely" state:proposed -> ""',
	"-->",
].join("\n");

describe("edit-target decorations", () => {
	test("paints an edit sub-highlight keyed to its parent comment", () => {
		const state = EditorState.create({ doc: WITH_EDIT, extensions: [commentField] });
		let editSpan: { cid?: string; eid?: string } | null = null;
		const cursor = state.field(commentField).decorations.iter();
		while (cursor.value) {
			const eid = cursor.value.spec?.attributes?.["data-eid"];
			if (eid) editSpan = { cid: cursor.value.spec?.attributes?.["data-cid"], eid };
			cursor.next();
		}
		expect(editSpan).toEqual({ cid: "c1", eid: "e1" });
	});

	test("hides the e: markers so they don't show as raw text", () => {
		const state = EditorState.create({ doc: WITH_EDIT, extensions: [commentField] });
		const atomic = state.field(commentField).atomic;
		const marker = "<!--e:e1-->";
		const at = WITH_EDIT.indexOf(marker);
		let covered = false;
		const it = atomic.iter();
		while (it.value) {
			if (it.from <= at && it.to >= at + marker.length) covered = true;
			it.next();
		}
		expect(covered).toBe(true);
	});
});
