import { App, Component, Keymap, MarkdownRenderer, Menu, setIcon } from "obsidian";
import { ParsedComment } from "../format/types";
import { isAnchored, isEditAnchored, isOrphan } from "../format/parse";

const QUICK_EMOJI = ["👍", "❤️", "😄", "🎉", "😮", "👀", "🙏"];

// A margin card whose thread is taller than this collapses to a "Show more" preview
// (Notion-style), so a long comment never dominates the column or runs off the
// bottom edge. Keep in sync with the .dc-card-clip max-height in styles.css.
const CLAMP_HEIGHT = 220;

export type CardCallbacks = {
	getAuthor: () => string;
	onHover: (id: string, active: boolean) => void;
	onClickAnchor: (id: string) => void;
	/** The card changed height (open/close, edit, react, expand) — re-run stacking. */
	onResize: () => void;
	/** Like onResize, but for an animated height change: track the grow/shrink for a
	 *  few frames so neighbors follow it smoothly. Falls back to onResize when absent. */
	animateLayout?: () => void;
	reply: (id: string, text: string) => void;
	setResolved: (id: string, resolved: boolean) => void;
	remove: (id: string) => void;
	editEntry: (id: string, index: number, text: string) => void;
	deleteEntry: (id: string, index: number) => void;
	toggleReaction: (id: string, emoji: string) => void;
	/** Hovering one suggestion row: light just THAT edit's sub-span (stronger than
	 *  the whole-thread wash the card hover applies). Editor views only — reading
	 *  view doesn't render edit sub-spans. */
	onHoverEdit?: (id: string, editId: string, active: boolean) => void;
	/** Apply a suggested edit (replace within its `e:` markers) and drop the `~` line. */
	acceptSuggestion: (id: string, editId: string) => void;
	/** Discard a suggested edit (unwrap its markers, prose untouched) and drop the `~` line. */
	rejectSuggestion: (id: string, editId: string) => void;
	/** Bring a just-opened reply composer fully into view (the margin scrolls the
	 *  editor minimally; the sidebar scrolls its own list). */
	revealComposer?: (id: string) => void;
	/** Reveal this thread in the comments sidebar — the escape for a card too tall to
	 *  fit the margin even when expanded. Absent for cards already in the sidebar. */
	openInSidebar?: (id: string) => void;
};

/** Per-view context a card needs to render comment text as Markdown. */
export type CardView = {
	/** App handle for MarkdownRenderer; absent in unit tests → plain-text fallback. */
	app?: App;
	/** Source note path, for resolving links/embeds in rendered comment text. */
	sourcePath: () => string;
	/** Collapse a tall card to a "Show more" preview. Margin only — the sidebar
	 *  scrolls its list, so sidebar cards stay full height. */
	collapsible?: boolean;
};

/** A single margin comment card with the full Notion-style interaction set. */
export class Card {
	readonly el: HTMLElement;
	private comment: ParsedComment;
	private open = false;
	private editingIndex = -1;
	private draft = "";
	/** Measured: the thread exceeds the clamp height / the whole column. */
	private overflows = false;
	private tooTall = false;
	private clipEl: HTMLElement | null = null;
	private threadEl: HTMLElement | null = null;
	private footEl: HTMLElement | null = null;
	/** Suggestion row elements by editId — lets the cursor light a single row. */
	private suggestionRows = new Map<string, HTMLElement>();
	private activeEditId: string | null = null;
	/** Owns the child components MarkdownRenderer attaches (link/embed handlers). */
	private md = new Component();
	/** Re-measures overflow when the (async-rendered) content settles or changes. */
	private ro = new ResizeObserver(() => this.measure());

	constructor(
		comment: ParsedComment,
		private cb: CardCallbacks,
		private view: CardView,
	) {
		this.comment = comment;
		this.md.load();
		this.el = createDiv("doc-comment-card");
		this.el.addEventListener("mouseenter", () => this.cb.onHover(this.id, true));
		this.el.addEventListener("mouseleave", () => this.cb.onHover(this.id, false));
		this.el.addEventListener("mousedown", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest("button, textarea, a, .dc-foot-btn, .dc-reaction, .dc-pop")) return;
			this.cb.onClickAnchor(this.id);
			// A thread too tall for the margin opens in the sidebar instead of expanding
			// into a full-height card whose bottom you can't scroll to.
			if (this.tooTall && this.cb.openInSidebar) this.cb.openInSidebar(this.id);
			else this.setOpen(true);
		});
		// Links in rendered comment text (a [[Note]] or an http URL in a reply) don't
		// navigate on their own — the margin container stops click propagation, so
		// Obsidian's global link handlers never see them. Route them ourselves.
		this.el.addEventListener("click", (e) => {
			const link = (e.target as HTMLElement).closest("a");
			if (!link) return;
			if (link.classList.contains("internal-link")) {
				if (!this.view.app) return;
				e.preventDefault();
				const href = link.getAttribute("data-href") || link.getAttribute("href") || link.textContent || "";
				if (href) void this.view.app.workspace.openLinkText(href, this.view.sourcePath(), Keymap.isModEvent(e));
			} else if (link.classList.contains("external-link")) {
				e.preventDefault();
				const href = link.getAttribute("href");
				if (href) window.open(href, "_blank");
			}
		});
		this.render();
	}

	get id(): string {
		return this.comment.id;
	}

	get signature(): string {
		return cardSignature(this.comment);
	}

	update(comment: ParsedComment): void {
		this.comment = comment;
		this.editingIndex = -1; // any edit has now landed
		this.render();
	}

	/** Release the markdown-render component (its link/embed child handlers) when
	 *  the card is dropped from the margin or sidebar. */
	destroy(): void {
		this.ro.disconnect();
		this.md.unload();
	}

	setActive(active: boolean): void {
		this.el.toggleClass("is-active", active);
	}

	/** Light one suggestion row (cursor sitting in its edit sub-span), or none. */
	setActiveEdit(editId: string | null): void {
		if (this.activeEditId === editId) return;
		this.activeEditId = editId;
		for (const [eid, row] of this.suggestionRows) row.toggleClass("is-active", eid === editId);
	}

	private setOpen(open: boolean): void {
		if (this.open === open) return;
		const fromHeight = this.clipEl?.offsetHeight ?? 0;
		this.open = open;
		this.render();
		this.animateClip(fromHeight);
		(this.cb.animateLayout ?? this.cb.onResize)();
		if (open) {
			this.el.ownerDocument.addEventListener("mousedown", this.onDocMouseDown, true);
			this.cb.revealComposer?.(this.id);
			this.focusComposer();
		} else {
			this.el.ownerDocument.removeEventListener("mousedown", this.onDocMouseDown, true);
		}
	}

	private onDocMouseDown = (e: MouseEvent): void => {
		if (!this.el.contains(e.target as Node)) this.setOpen(false);
	};

	/** Quick, smooth grow/shrink of the body on open/close: animate the clip from its
	 *  previous height to the new target, then drop the inline overrides so it's free
	 *  to resize naturally again. */
	private animateClip(fromHeight: number): void {
		const clip = this.clipEl;
		if (!clip || !this.view.collapsible) return;
		const toHeight = this.open ? clip.scrollHeight : CLAMP_HEIGHT;
		if (Math.abs(fromHeight - toHeight) < 2) return;
		clip.setCssStyles({ overflow: "hidden", transition: "none", maxHeight: `${fromHeight}px` });
		void clip.offsetHeight; // reflow so the start height is committed before transitioning
		clip.setCssStyles({ transition: "max-height 150ms ease", maxHeight: `${toHeight}px` });
		const cleanup = (): void => {
			clip.setCssStyles({ maxHeight: "", overflow: "", transition: "" });
			clip.removeEventListener("transitionend", cleanup);
			window.clearTimeout(timer);
		};
		const timer = window.setTimeout(cleanup, 260); // fallback if transitionend never fires
		clip.addEventListener("transitionend", cleanup);
	}

	private render(): void {
		const c = this.comment;
		this.el.empty();
		this.suggestionRows.clear();
		this.el.toggleClass("is-resolved", c.status === "resolved");
		this.el.toggleClass("is-open", this.open);

		// The thread lives in a clip wrapper that gets a max-height when a tall card is
		// collapsed; the footer (Show more / Open in sidebar) sits outside the clip.
		const clip = this.el.createDiv("dc-card-clip");
		this.clipEl = clip;
		// A comment whose anchor markers were deleted: warn, and show the quote it used
		// to sit on so the reader can find the spot (or delete the comment).
		this.el.toggleClass("is-orphan", isOrphan(c));
		if (isOrphan(c)) {
			clip.createDiv({
				cls: "dc-card-warn",
				text: `⚠ anchor lost — was on: “${c.quote}”`,
			});
		}
		const thread = clip.createDiv("dc-thread");
		this.threadEl = thread;
		c.thread.forEach((entry, i) => this.renderEntry(thread, entry, i));
		if (c.suggestions.length > 0) this.renderSuggestions(clip);
		if (this.open) this.renderComposer(clip);

		this.footEl = this.el.createDiv("dc-card-foot");
		this.applyClampState();

		// Re-measure once the (async Markdown) content settles, and on later changes.
		// The card may not be in the DOM yet during construction; the observer fires
		// when it attaches and is sized.
		if (this.view.collapsible) {
			this.ro.disconnect();
			this.ro.observe(thread);
		}
	}

	/** Recompute whether the thread overflows the clamp / the whole column, and
	 *  reflect it. Cheap; driven by the ResizeObserver as content settles or changes. */
	private measure(): void {
		if (!this.threadEl || !this.view.collapsible) return;
		const content = this.threadEl.offsetHeight;
		const overflows = content > CLAMP_HEIGHT;
		const viewport = this.el.parentElement?.clientHeight ?? 0;
		const tooTall = viewport > 0 && content > viewport - 24;
		if (overflows === this.overflows && tooTall === this.tooTall) return;
		this.overflows = overflows;
		this.tooTall = tooTall;
		this.applyClampState();
		this.cb.onResize(); // clamping changes the card height → restack
	}

	/** Apply the collapse state to the DOM: clamp the body when a tall card is at
	 *  rest, and render the Show more / Show less / Open-in-sidebar footer. */
	private applyClampState(): void {
		this.clipEl?.toggleClass("dc-clamped", !!this.view.collapsible && !this.open && this.overflows);
		const foot = this.footEl;
		if (!foot) return;
		foot.empty();
		if (this.view.collapsible) {
			if (this.tooTall && this.cb.openInSidebar) {
				// Too tall to read in the margin at all (expanding gives an unreachable
				// full-height card), so the affordance is "open in sidebar" directly — on
				// the always-reachable collapsed card.
				this.footButton(foot, "Open in sidebar →", "", () => this.cb.openInSidebar?.(this.id));
			} else if (!this.open && this.overflows) {
				// "Show more" opens the card — full thread + reply field in one click, so
				// there's no second click to reveal the composer. Collapse by clicking away.
				this.footButton(foot, "Show more", "", () => this.setOpen(true));
			}
		}
		// Collapsed "Show more" is a centered overlay at the card's bottom (over the
		// faded text); "Open in sidebar" (when open) is a normal centered footer.
		foot.toggleClass("dc-foot-overlay", !!this.view.collapsible && !this.open && this.overflows);
		foot.toggleClass("is-empty", foot.childElementCount === 0);
	}

	/** A subtle, Notion-style text affordance. A <span> (not an Obsidian <button>) so
	 *  no theme can give it chip chrome; role+tabindex keep it keyboard-accessible. */
	private footButton(parent: HTMLElement, text: string, extraClass: string, onClick: () => void): void {
		const btn = parent.createEl("span", {
			cls: extraClass ? `dc-foot-btn ${extraClass}` : "dc-foot-btn",
			text,
			attr: { role: "button", tabindex: "0" },
		});
		const fire = (e: Event) => {
			e.stopPropagation();
			onClick();
		};
		btn.addEventListener("click", fire);
		btn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				fire(e);
			}
		});
	}

	private renderEntry(
		parent: HTMLElement,
		entry: { author: string; timestamp?: string; text: string },
		i: number,
	): void {
		const row = parent.createDiv("dc-entry");

		const bar = row.createDiv("dc-entry__bar");
		this.iconButton(bar, "smile-plus", "React", (e) => this.openReactionPicker(e.currentTarget as HTMLElement));
		if (i === 0) {
			const resolved = this.comment.status === "resolved";
			this.iconButton(bar, resolved ? "rotate-ccw" : "check", resolved ? "Reopen" : "Resolve", () =>
				this.cb.setResolved(this.id, !resolved),
			);
		}
		this.iconButton(bar, "more-horizontal", "More", (e) => this.openMoreMenu(e, i));

		const head = row.createDiv("dc-entry__head");
		head.createSpan({ cls: "dc-entry__author", text: entry.author || "—" });
		const time = formatRelativeTime(entry.timestamp ?? (i === 0 ? this.comment.createdAt : undefined));
		if (time) head.createSpan({ cls: "dc-entry__time", text: time });

		if (this.editingIndex === i) {
			this.renderEditor(row, entry.text, i);
		} else {
			this.renderText(row.createDiv("dc-entry__text"), entry.text);
		}

		if (i === 0 && this.comment.reactions.length > 0) this.renderReactions(row);
	}

	/** Render comment text as Markdown (code spans, links, lists, …). Falls back to
	 *  plain text when no App is available (unit tests). */
	private renderText(el: HTMLElement, text: string): void {
		if (this.view.app) {
			void MarkdownRenderer.render(this.view.app, text, el, this.view.sourcePath(), this.md);
		} else {
			el.setText(text);
		}
	}

	private renderReactions(parent: HTMLElement): void {
		const me = this.cb.getAuthor();
		const wrap = parent.createDiv("dc-entry__reactions");
		for (const r of this.comment.reactions) {
			const chip = wrap.createEl("button", { cls: "dc-reaction" });
			chip.toggleClass("is-mine", r.authors.includes(me));
			chip.createSpan({ cls: "dc-reaction__emoji", text: r.emoji });
			chip.createSpan({ cls: "dc-reaction__count", text: String(r.authors.length) });
			chip.setAttribute("aria-label", r.authors.join(", "));
			chip.addEventListener("click", (e) => {
				e.stopPropagation();
				this.cb.toggleReaction(this.id, r.emoji);
			});
		}
	}

	/** Render the accept/reject-able suggested edits as a list under the thread. */
	private renderSuggestions(parent: HTMLElement): void {
		const wrap = parent.createDiv("dc-suggestions");
		for (const s of this.comment.suggestions) {
			const anchored = isEditAnchored(s);
			const row = wrap.createDiv("dc-suggestion");
			this.suggestionRows.set(s.editId, row);
			row.toggleClass("is-active", s.editId === this.activeEditId);
			row.toggleClass("is-orphan", !anchored);
			row.toggleClass("is-stale", s.stale);
			row.toggleClass("is-conflict", s.conflict);
			if (anchored && this.cb.onHoverEdit) {
				row.addEventListener("mouseenter", () => this.cb.onHoverEdit?.(this.id, s.editId, true));
				row.addEventListener("mouseleave", () => this.cb.onHoverEdit?.(this.id, s.editId, false));
			}

			// Another anchor's marker sits inside this edit's replace range — accepting
			// would destroy it, so Accept is withheld (reject stays safe).
			if (s.conflict) {
				row.createDiv({
					cls: "dc-suggestion__stale",
					text: "⚠ overlaps another comment's anchor — can't accept",
				});
			}
			// The prose moved under this suggestion since it was made — accepting still
			// replaces whatever's between the markers, so warn rather than block.
			else if (s.stale) {
				row.createDiv({
					cls: "dc-suggestion__stale",
					text: "⚠ text changed since this was suggested",
				});
			}

			const diff = row.createDiv("dc-suggestion__diff");
			if (s.was) diff.createSpan({ cls: "dc-suggestion__old", text: s.was });
			if (s.replacement === "") {
				diff.createSpan({ cls: "dc-suggestion__del", text: s.was ? "(delete)" : "(empty)" });
			} else {
				if (s.was) diff.createSpan({ cls: "dc-suggestion__arrow", text: "→" });
				diff.createSpan({ cls: "dc-suggestion__new", text: s.replacement });
			}

			const actions = row.createDiv("dc-suggestion__actions");
			// Accept needs live markers to replace within (and no overlap conflict); an
			// orphaned suggestion can only be rejected (which just clears the `~` line).
			if (anchored && !s.conflict) {
				this.roundButton(actions, "check", "Accept", "dc-round--confirm", () =>
					this.cb.acceptSuggestion(this.id, s.editId),
				);
			}
			this.roundButton(actions, "x", "Reject", "dc-round--cancel", () =>
				this.cb.rejectSuggestion(this.id, s.editId),
			);
		}
	}

	private renderEditor(row: HTMLElement, text: string, index: number): void {
		const box = row.createDiv("dc-field dc-field--edit");
		const ta = box.createEl("textarea", { cls: "dc-field__input" });
		ta.value = text;
		autogrow(ta);
		ta.addEventListener("input", () => autogrow(ta));
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.cancelEdit();
			else if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.commitEdit(index, ta.value);
			}
		});
		const actions = box.createDiv("dc-field__actions");
		this.roundButton(actions, "x", "Cancel", "dc-round--cancel", () => this.cancelEdit());
		this.roundButton(actions, "check", "Save", "dc-round--confirm", () => this.commitEdit(index, ta.value));
		window.setTimeout(() => {
			ta.focus();
			ta.setSelectionRange(ta.value.length, ta.value.length);
		}, 0);
	}

	private roundButton(parent: HTMLElement, icon: string, label: string, variant: string, onClick: () => void): void {
		const btn = parent.createEl("button", { cls: `dc-round ${variant}`, attr: { "aria-label": label } });
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
	}

	private renderComposer(parent: HTMLElement): void {
		const box = parent.createDiv("dc-field dc-field--composer");
		const ta = box.createEl("textarea", {
			cls: "dc-field__input",
			attr: { placeholder: "Reply…", rows: "1" },
		});
		ta.value = this.draft;
		autogrow(ta);
		ta.addEventListener("input", () => {
			this.draft = ta.value;
			autogrow(ta);
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.submitReply();
			}
		});
		const actions = box.createDiv("dc-field__actions");
		this.roundButton(actions, "arrow-up", "Send", "dc-round--confirm", () => this.submitReply());
	}

	private submitReply(): void {
		const ta = this.el.querySelector(".dc-field--composer .dc-field__input");
		if (!(ta instanceof HTMLTextAreaElement)) return;
		const text = ta.value.trim();
		if (!text) return;
		this.draft = "";
		this.cb.reply(this.id, text);
	}

	private commitEdit(index: number, value: string): void {
		const text = value.trim();
		if (text) this.cb.editEntry(this.id, index, text);
		else this.cancelEdit();
	}

	private cancelEdit(): void {
		this.editingIndex = -1;
		this.render();
		this.cb.onResize();
	}

	private startEdit(index: number): void {
		this.editingIndex = index;
		this.render();
		this.cb.onResize();
	}

	private openMoreMenu(e: MouseEvent, index: number): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Edit")
				.setIcon("pencil")
				.onClick(() => this.startEdit(index)),
		);
		menu.addItem((item) =>
			item
				.setTitle(index === 0 ? "Delete comment" : "Delete reply")
				.setIcon("trash")
				.onClick(() => (index === 0 ? this.cb.remove(this.id) : this.cb.deleteEntry(this.id, index))),
		);
		menu.showAtMouseEvent(e);
	}

	private openReactionPicker(anchor: HTMLElement): void {
		const doc = this.el.ownerDocument;
		doc.querySelectorAll(".dc-pop").forEach((p) => p.remove());
		const pop = doc.body.createDiv("dc-pop");
		for (const emoji of QUICK_EMOJI) {
			const btn = pop.createEl("button", { cls: "dc-pop__emoji", text: emoji });
			btn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				pop.remove();
				this.cb.toggleReaction(this.id, emoji);
			});
		}
		// Right-align the popover with the button so it grows left, not off-page.
		const rect = anchor.getBoundingClientRect();
		const left = Math.max(8, rect.right - pop.offsetWidth);
		pop.setCssStyles({ top: `${rect.bottom + 4}px`, left: `${left}px` });
		const close = (ev: MouseEvent) => {
			if (!pop.contains(ev.target as Node)) {
				pop.remove();
				doc.removeEventListener("mousedown", close, true);
			}
		};
		window.setTimeout(() => doc.addEventListener("mousedown", close, true), 0);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): void {
		const btn = parent.createEl("button", { cls: "dc-act", attr: { "aria-label": label } });
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick(e);
		});
	}

	private focusComposer(): void {
		window.setTimeout(() => {
			const ta = this.el.querySelector(".dc-field--composer .dc-field__input");
			if (ta instanceof HTMLTextAreaElement) ta.focus({ preventScroll: true });
		}, 0);
	}
}

/** Content signature, independent of document position — drives margin diffing.
 *  Suggestions are included (with their anchored state) so accept/reject/state
 *  changes actually repaint the card. */
export const cardSignature = (c: ParsedComment): string => {
	return JSON.stringify([
		c.status,
		c.author,
		c.createdAt,
		c.thread,
		c.reactions,
		isAnchored(c),
		c.quote, // the orphan banner shows it
		c.suggestions.map((s) => [s.editId, s.state, s.was, s.replacement, isEditAnchored(s), s.stale, s.conflict]),
	]);
};

const autogrow = (ta: HTMLTextAreaElement): void => {
	ta.setCssStyles({ height: "auto" });
	ta.setCssStyles({ height: `${ta.scrollHeight}px` });
};

const formatRelativeTime = (iso?: string): string => {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const diff = Date.now() - then;
	const sec = Math.round(diff / 1000);
	if (sec < 45) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.round(hr / 24);
	if (day < 7) return `${day}d`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
