import { EditorView } from "@codemirror/view";
import { commentConfig } from "./config";

/** Cursor position at mousedown, BEFORE CodeMirror moves it for this tap —
 *  what "the tap didn't move the cursor" is judged against. */
const headBefore = new WeakMap<EditorView, number>();

/**
 * Mobile: a SECOND tap on an anchored span — one that doesn't move the cursor,
 * because the first tap already placed it there — opens the comments sidebar
 * scrolled to that thread. The first tap stays a plain cursor move, so editing
 * inside commented text isn't constantly yanking the panel open, and iOS's
 * built-in text callout (Paste / Select / Select All…) keeps working: nothing
 * is drawn over the text and no tap is captured. (A floating in-context card
 * was tried first and fought that callout.)
 */
export const anchorTapOpensSidebar = EditorView.domEventHandlers({
	mousedown: (_e, view) => {
		headBefore.set(view, view.state.selection.main.head);
		return false;
	},
	click: (e, view) => {
		const span = (e.target as HTMLElement).closest(".doc-comment-span, .doc-comment-edit-span");
		const id = span?.getAttribute("data-cid");
		if (!id) return false;
		const sel = view.state.selection.main;
		// Only when the tap left the cursor exactly where it already was — a tap
		// that moved the cursor (or made a selection, e.g. double-tap word select)
		// was a text-editing gesture, not "show me this thread".
		if (sel.empty && headBefore.get(view) === sel.head) {
			view.state.facet(commentConfig).openInSidebar?.(id);
		}
		return false;
	},
});
