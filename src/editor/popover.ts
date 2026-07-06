import { Notice } from "obsidian";
import { Result } from "better-result";
import { EditorView, PluginValue, ViewPlugin } from "@codemirror/view";
import { anchorRange } from "../format/parse";
import { ParsedComment } from "../format/types";
import { commentField } from "./state";
import { commentConfig } from "./config";
import { Card, CardCallbacks, CardView } from "../ui/card";
import {
	acceptSuggestion,
	appendReply,
	deleteComment,
	deleteEntry,
	editEntry,
	rejectSuggestion,
	setResolved,
	toggleReaction,
} from "./commands";
import { cssEscape } from "../util/css";

const notifyErr = (result: Result<unknown, string>): void => {
	if (result.isErr()) new Notice(`Couldn't save the comment: ${result.error}`);
};

/**
 * Mobile's stand-in for the floating margin: tap an anchored span and its thread
 * opens as a single card floating just below the anchor; tap anywhere else and it
 * closes. The sidebar remains the "all discussions" view — this is the in-context
 * quick look, on the surface (the text) mobile actually has room for.
 */
class PopoverView implements PluginValue {
	private el: HTMLElement | null = null;
	private card: Card | null = null;
	private openId: string | null = null;

	constructor(private view: EditorView) {
		view.contentDOM.addEventListener("click", this.onContentClick);
		view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
	}

	update(): void {
		if (!this.openId) return;
		const c = this.comment(this.openId);
		if (!c || !c.body) {
			this.close(); // deleted under us
			return;
		}
		this.card?.update(c);
		this.reposition();
	}

	destroy(): void {
		this.view.contentDOM.removeEventListener("click", this.onContentClick);
		this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		this.close();
	}

	private comment(id: string): ParsedComment | null {
		return this.view.state.field(commentField, false)?.comments.find((c) => c.id === id) ?? null;
	}

	private onContentClick = (e: MouseEvent): void => {
		const span = (e.target as HTMLElement).closest(".doc-comment-span, .doc-comment-edit-span");
		const id = span?.getAttribute("data-cid");
		if (!id) return;
		if (id === this.openId) return; // already showing this thread
		this.open(id);
	};

	private onScroll = (): void => this.reposition();

	private onDocPointerDown = (e: Event): void => {
		const t = e.target as HTMLElement;
		if (this.el?.contains(t)) return;
		// Tapping another anchor switches threads — let onContentClick handle it.
		if (t.closest?.(".doc-comment-span, .doc-comment-edit-span")) return;
		this.close();
	};

	private open(id: string): void {
		const c = this.comment(id);
		if (!c || !c.body) return;
		this.close();
		this.openId = id;

		this.el = this.view.dom.createDiv("dc-popover");
		// Same trick as the margin container: the popover lives inside .cm-editor, so
		// stop the events CodeMirror would otherwise steal from our inputs/buttons.
		const stop = (ev: Event) => ev.stopPropagation();
		for (const type of [
			"mousedown",
			"mouseup",
			"click",
			"dblclick",
			"keydown",
			"keyup",
			"input",
			"beforeinput",
			"paste",
			"cut",
			"contextmenu",
		]) {
			this.el.addEventListener(type, stop);
		}
		this.card = new Card(c, this.callbacks(), this.cardView());
		this.el.appendChild(this.card.el);
		this.reposition();
		this.view.dom.ownerDocument.addEventListener("pointerdown", this.onDocPointerDown, true);
	}

	private close(): void {
		this.view.dom.ownerDocument.removeEventListener("pointerdown", this.onDocPointerDown, true);
		this.card?.destroy();
		this.card = null;
		this.el?.remove();
		this.el = null;
		this.openId = null;
	}

	/** Place the card just below the anchor's last line, roughly aligned with its
	 *  start. Geometry reads go through requestMeasure (coordsAtPos throws during
	 *  an update cycle). */
	private reposition(): void {
		if (!this.el || !this.openId) return;
		this.view.requestMeasure({
			key: this,
			read: () => {
				const c = this.openId ? this.comment(this.openId) : null;
				const r = c ? anchorRange(c) : null;
				const pos = r ? r.to : null;
				const startPos = r ? r.from : null;
				const end = pos != null ? this.view.coordsAtPos(pos) : null;
				const start = startPos != null ? this.view.coordsAtPos(startPos) : null;
				const editor = this.view.dom.getBoundingClientRect();
				return { end, start, editor };
			},
			write: ({ end, start, editor }) => {
				if (!this.el) return;
				if (!end) {
					this.el.addClass("dc-offscreen"); // anchor scrolled out of the viewport
					return;
				}
				this.el.removeClass("dc-offscreen");
				const width = this.el.offsetWidth || 320;
				const left = Math.max(8, Math.min((start ?? end).left - editor.left, editor.width - width - 8));
				this.el.setCssStyles({ top: `${end.bottom - editor.top + 6}px`, left: `${left}px` });
			},
		});
	}

	private cardView(): CardView {
		const cfg = this.view.state.facet(commentConfig);
		return { app: cfg.app, sourcePath: () => cfg.app?.workspace.getActiveFile()?.path ?? "", collapsible: true };
	}

	private callbacks(): CardCallbacks {
		const view = this.view;
		const author = () => view.state.facet(commentConfig).author();
		return {
			getAuthor: author,
			onHover: () => {},
			onClickAnchor: (id) => this.flashAnchor(id),
			onResize: () => this.reposition(),
			reply: (id, text) => notifyErr(appendReply(view, id, text, author())),
			setResolved: (id, resolved) => notifyErr(setResolved(view, id, resolved)),
			remove: (id) => notifyErr(deleteComment(view, id)),
			editEntry: (id, index, text) => notifyErr(editEntry(view, id, index, text)),
			deleteEntry: (id, index) => notifyErr(deleteEntry(view, id, index)),
			toggleReaction: (id, emoji) => notifyErr(toggleReaction(view, id, emoji, author())),
			acceptSuggestion: (id, editId) => notifyErr(acceptSuggestion(view, id, editId, author())),
			rejectSuggestion: (id, editId) => notifyErr(rejectSuggestion(view, id, editId, author())),
			openInSidebar: (id) => {
				this.close();
				view.state.facet(commentConfig).openInSidebar?.(id);
			},
		};
	}

	private flashAnchor(id: string): void {
		const span = this.view.contentDOM.querySelector(`.doc-comment-span[data-cid="${cssEscape(id)}"]`);
		if (!(span instanceof HTMLElement)) return;
		span.addClass("dc-flash");
		window.setTimeout(() => span.removeClass("dc-flash"), 900);
	}
}

export const popoverPlugin = ViewPlugin.fromClass(PopoverView);
