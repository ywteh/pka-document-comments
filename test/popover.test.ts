// @vitest-environment happy-dom
//
// Mobile tap-to-open popover: tapping an anchored span opens its thread as a
// floating card below the anchor; tapping elsewhere closes it. Runs the real
// ViewPlugin in a live EditorView (see obsidian-dom / obsidian-mock).
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installObsidianDom } from "./obsidian-dom";

installObsidianDom();

import { commentField } from "../src/editor/state";
import { draftField } from "../src/editor/draft";
import { commentConfig } from "../src/editor/config";
import { popoverPlugin } from "../src/editor/popover";

const DOC =
	"A <!--c:x-->quick fox<!--/c:x--> jumps.\n" +
	'<!--co:x by:me at:2026-07-01T00:00:00.000Z status:open quote:"quick fox"\nme: hello thread\n-->\n';

const open = () => {
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
					sidebarOpen: () => false,
					isMobile: () => true,
				}),
				popoverPlugin,
			],
		}),
		parent,
	});
};

const tapSpan = (view: EditorView): void => {
	const span = view.contentDOM.querySelector('.doc-comment-span[data-cid="x"]');
	span?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

describe("mobile thread popover", () => {
	it("opens the thread card on tapping the anchor span", () => {
		const view = open();
		expect(view.dom.querySelector(".dc-popover")).toBeNull();
		tapSpan(view);
		const pop = view.dom.querySelector(".dc-popover");
		expect(pop).toBeTruthy();
		expect(pop?.querySelector(".doc-comment-card")?.textContent).toContain("hello thread");
		view.destroy();
	});

	it("closes on a tap outside the popover and the anchors", () => {
		const view = open();
		tapSpan(view);
		expect(view.dom.querySelector(".dc-popover")).toBeTruthy();
		document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		expect(view.dom.querySelector(".dc-popover")).toBeNull();
		view.destroy();
	});

	it("stays open when the tap lands inside the popover", () => {
		const view = open();
		tapSpan(view);
		const card = view.dom.querySelector(".dc-popover .doc-comment-card");
		card?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		expect(view.dom.querySelector(".dc-popover")).toBeTruthy();
		view.destroy();
	});

	it("closes when the comment is deleted from the document", () => {
		const view = open();
		tapSpan(view);
		expect(view.dom.querySelector(".dc-popover")).toBeTruthy();
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "gone" } });
		expect(view.dom.querySelector(".dc-popover")).toBeNull();
		view.destroy();
	});
});
