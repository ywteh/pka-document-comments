// @vitest-environment happy-dom
//
// End-to-end (headless) test of cursor-driven thread activation: a LIVE EditorView
// with the real margin ViewPlugin, driven by selection dispatches — the exact
// transactions Obsidian produces when the text cursor moves. Verifies both hosts:
// the onCursorThread notification the sidebar consumes, and the margin's own
// card/row lighting when it hosts the cards.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installObsidianDom } from "./obsidian-dom";

// The "obsidian" module itself resolves to test/obsidian-mock.ts (vitest.config.ts).
installObsidianDom();

import { commentField } from "../src/editor/state";
import { draftField } from "../src/editor/draft";
import { commentConfig } from "../src/editor/config";
import { marginPlugin } from "../src/editor/margin";

const DOC =
	"A <!--c:x-->quick <!--e:e1-->brown<!--/e:e1--> fox<!--/c:x--> jumps.\n" +
	'<!--co:x status:open quote:"quick brown fox"\nme: hi\n~ @e1 was:"brown" state:proposed -> "red"\n-->\n';

const ANCHOR_POS = DOC.indexOf("quick") + 2; // inside the anchor, outside the edit
const EDIT_POS = DOC.indexOf("brown") + 2; // inside the edit sub-span

const open = (sidebarOpen: boolean, onCursorThread?: (id: string | null, editId: string | null) => void) => {
	const parent = document.body.appendChild(document.createElement("div"));
	return new EditorView({
		state: EditorState.create({
			doc: DOC,
			extensions: [
				commentField,
				draftField,
				commentConfig.of({
					author: () => "me",
					showComments: () => true,
					showResolved: () => true,
					sidebarOpen: () => sidebarOpen,
					onCursorThread,
				}),
				marginPlugin,
			],
		}),
		parent,
	});
};

describe("cursor-driven thread activation", () => {
	it("notifies onCursorThread as the cursor enters the anchor, the edit span, and leaves", () => {
		const calls: Array<[string | null, string | null]> = [];
		const view = open(true, (id, editId) => calls.push([id, editId])); // sidebar hosts the cards

		view.dispatch({ selection: { anchor: ANCHOR_POS } });
		expect(calls.at(-1)).toEqual(["x", null]);

		view.dispatch({ selection: { anchor: EDIT_POS } });
		expect(calls.at(-1)).toEqual(["x", "e1"]);

		view.dispatch({ selection: { anchor: 0 } });
		expect(calls.at(-1)).toEqual([null, null]);
		view.destroy();
	});

	it("lights the margin card and the specific suggestion row when hosting inline", () => {
		const view = open(false);
		const card = () => view.dom.querySelector(".doc-comment-card");
		const row = () => view.dom.querySelector(".dc-suggestion");
		expect(card()).toBeTruthy();

		view.dispatch({ selection: { anchor: EDIT_POS } });
		expect(card()?.classList.contains("is-active")).toBe(true);
		expect(row()?.classList.contains("is-active")).toBe(true);

		view.dispatch({ selection: { anchor: ANCHOR_POS } });
		expect(card()?.classList.contains("is-active")).toBe(true); // still in the anchor
		expect(row()?.classList.contains("is-active")).toBe(false); // but not in the edit

		view.dispatch({ selection: { anchor: 0 } });
		expect(card()?.classList.contains("is-active")).toBe(false);
		view.destroy();
	});

	it("also lights the in-text spans (markHighlight) from the cursor", () => {
		const view = open(true); // even with the sidebar hosting, the spans light
		view.dispatch({ selection: { anchor: ANCHOR_POS } });
		const span = view.contentDOM.querySelector('.doc-comment-span[data-cid="x"]');
		expect(span?.classList.contains("is-active")).toBe(true);
		view.dispatch({ selection: { anchor: 0 } });
		expect(span?.classList.contains("is-active")).toBe(false);
		view.destroy();
	});
});
