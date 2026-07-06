// @vitest-environment happy-dom
//
// Mobile: a SECOND tap on an anchored span — one that leaves the cursor where
// the first tap already put it — opens the sidebar at that thread. A tap that
// moves the cursor is a plain editing gesture and must NOT open the panel.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installObsidianDom } from "./obsidian-dom";

installObsidianDom();

import { commentField } from "../src/editor/state";
import { commentConfig } from "../src/editor/config";
import { anchorTapOpensSidebar } from "../src/editor/anchor-tap";

const DOC = "A <!--c:x-->quick fox<!--/c:x--> jumps.\n" + '<!--co:x status:open quote:"quick fox"\nme: hello\n-->\n';

describe("second tap on an anchor opens the sidebar (mobile)", () => {
	const setup = () => {
		const opened: string[] = [];
		const view = new EditorView({
			state: EditorState.create({
				doc: DOC,
				extensions: [
					commentField,
					commentConfig.of({
						author: () => "me",
						showComments: () => true,
						showResolved: () => true,
						sidebarOpen: () => false,
						isMobile: () => true,
						openInSidebar: (id) => opened.push(id),
					}),
					anchorTapOpensSidebar,
					// Suppress CodeMirror's BUILTIN mousedown handling: under happy-dom the
					// synthetic (0,0) coordinates make its mouse-selection machinery select
					// garbage ranges between our events. Lower precedence than the handler
					// under test (registered after), so ours still records the pre-tap head;
					// the tap's cursor move is then simulated explicitly via dispatch.
					EditorView.domEventHandlers({ mousedown: () => true }),
				],
			}),
			parent: document.body.appendChild(document.createElement("div")),
		});
		const span = view.contentDOM.querySelector('.doc-comment-span[data-cid="x"]')!;
		// Simulate one tap: mousedown (handler records the pre-tap cursor), an
		// optional cursor move (what CodeMirror does for a tap that lands
		// elsewhere), then click (handler decides).
		const tap = (moveTo?: number) => {
			span.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			// happy-dom fires selectionchange synchronously; blur so CodeMirror's DOM
			// observer ignores it (re-entrant update otherwise). Browsers fire it async.
			view.contentDOM.blur();
			if (moveTo !== undefined) view.dispatch({ selection: { anchor: moveTo } });
			span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		};
		return { view, opened, tap };
	};

	const IN_ANCHOR = DOC.indexOf("quick") + 2;

	it("first tap (cursor moves into the anchor) does not open; second tap does", () => {
		const { view, opened, tap } = setup();
		tap(IN_ANCHOR); // first tap: moves the cursor → editing gesture
		expect(opened).toEqual([]);
		tap(); // second tap at the same spot: cursor unmoved → open the thread
		expect(opened).toEqual(["x"]);
		view.destroy();
	});

	it("a tap that moves the cursor within the anchor is still a cursor move", () => {
		const { view, opened, tap } = setup();
		tap(IN_ANCHOR);
		tap(IN_ANCHOR + 3); // second tap, but it relocated the cursor
		expect(opened).toEqual([]);
		view.destroy();
	});

	it("a selection (double-tap word select) does not open the sidebar", () => {
		const { view, opened } = setup();
		const span = view.contentDOM.querySelector('.doc-comment-span[data-cid="x"]')!;
		span.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		view.contentDOM.blur();
		view.dispatch({ selection: { anchor: IN_ANCHOR, head: IN_ANCHOR + 5 } });
		span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(opened).toEqual([]);
		view.destroy();
	});
});
