import { Editor, MarkdownView, Menu, Notice, Platform, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { commentField } from "./editor/state";
import { marginPlugin } from "./editor/margin";
import { commentConfig } from "./editor/config";
import { editorLayoutField } from "./editor/layout";
import { markerDeleteGuard } from "./editor/marker-guard";
import { draftField, setDraft } from "./editor/draft";
import { addComment, insertCommentInFile, insertFileCommentInFile } from "./editor/commands";
import { findSectionRange, highlightPostProcessor } from "./reading/highlight";
import { ReadingDeps, ReadingMarginManager } from "./reading/margin";
import { COMMENTS_VIEW_TYPE, CommentsSidebarView, SidebarDeps } from "./ui/sidebar";
import { CommentModal } from "./ui/comment-modal";
import { DEFAULT_SETTINGS, DocCommentsSettings, DocCommentsSettingTab } from "./settings";

export default class DocCommentsPlugin extends Plugin {
	settings: DocCommentsSettings = { ...DEFAULT_SETTINGS };
	private ribbonIcon: HTMLElement | null = null;
	private readingManager: ReadingMarginManager | null = null;
	private scheduleReadingRefresh: () => void = () => {};
	/** True while the "All discussions" sidebar panel is mounted. */
	private sidebarOpen = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEditorExtension([
			commentField,
			// Backspace/Delete at an anchor edge eats the visible character beyond the
			// hidden marker instead of the marker itself (which orphaned the comment).
			markerDeleteGuard,
			draftField,
			commentConfig.of({
				app: this.app,
				author: () => this.authorName(),
				showComments: () => this.settings.showComments,
				showResolved: () => this.settings.showResolved,
				sidebarOpen: () => this.sidebarOpen,
				openInSidebar: (id) => void this.revealComment(id),
				onCursorThread: (id, editId) => this.sidebarView()?.cursorReveal(id, editId),
				isMobile: () => Platform.isMobile,
			}),
			// Reflects dc-has / dc-highlights / dc-hide-resolved onto .cm-editor so the
			// stylesheet caps the text column without a :has() selector.
			editorLayoutField,
			// The floating margin column needs horizontal room mobile doesn't have, so
			// there we skip it entirely — comments live in the sidebar, highlights stay,
			// and new comments are composed in a modal (see startAddComment).
			...(Platform.isMobile ? [] : [marginPlugin]),
		]);

		// Reading view: a separate render path. Highlights come from a post-processor;
		// the margin column is managed per reading-view container.
		const readingDeps: ReadingDeps = {
			app: this.app,
			getAuthor: () => this.authorName(),
			showComments: () => this.settings.showComments,
			showResolved: () => this.settings.showResolved,
			sidebarOpen: () => this.sidebarOpen,
			openInSidebar: (id) => void this.revealComment(id),
			isMobile: () => Platform.isMobile,
		};
		this.readingManager = new ReadingMarginManager(readingDeps);
		this.scheduleReadingRefresh = debounce(() => this.readingManager?.refresh(), 50, true);

		// The "All discussions" sidebar panel (Notion-style). While it's open the
		// inline floating cards step aside; the in-text highlights stay.
		const sidebarDeps: SidebarDeps = {
			app: this.app,
			getAuthor: () => this.authorName(),
		};
		this.registerView(COMMENTS_VIEW_TYPE, (leaf) => new CommentsSidebarView(leaf, sidebarDeps));

		this.registerMarkdownPostProcessor((el, ctx) => {
			highlightPostProcessor(el, ctx);
			this.scheduleReadingRefresh();
		});
		// layout-change / active-leaf-change fire for every way the panel shows or
		// hides — open, close, collapse the dock, switch tabs — so the inline column
		// follows the panel's real visibility instead of a mount flag that misses
		// collapse/tab-switch.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.syncSidebarOpen();
				this.scheduleReadingRefresh();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.syncSidebarOpen();
				this.scheduleReadingRefresh();
			}),
		);
		// resize fires while a dock collapses/expands — catches that case promptly
		// even if layout-change doesn't.
		this.registerEvent(this.app.workspace.on("resize", () => this.syncSidebarOpen()));
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleReadingRefresh()));

		this.addCommand({
			id: "add-comment",
			name: "Add comment on selection",
			editorCallback: (editor) => this.startAddComment(editor, "selection"),
		});

		this.addCommand({
			id: "add-comment-line",
			name: "Add comment on current line",
			editorCallback: (editor) => this.startAddComment(editor, "line"),
		});

		this.addCommand({
			id: "toggle-comments",
			name: "Toggle comments",
			callback: () => void this.toggleComments(),
		});

		this.addCommand({
			id: "toggle-resolved",
			name: "Toggle resolved comments",
			callback: () => void this.toggleResolved(),
		});

		this.addCommand({
			id: "add-comment-reading",
			name: "Add comment on selection (reading view)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || view.getMode() !== "preview") return false;
				if (!checking) this.startAddCommentReading(view);
				return true;
			},
		});

		this.addCommand({
			id: "add-comment-file",
			name: "Add comment on whole file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) this.startAddFileComment(file);
				return true;
			},
		});

		this.addCommand({
			id: "open-comments-sidebar",
			name: "Toggle comments sidebar",
			callback: () => void this.toggleSidebarPanel(),
		});

		this.ribbonIcon = this.addRibbonIcon(
			"message-square",
			"Toggle document comments",
			() => void this.toggleComments(),
		);
		this.updateRibbon();
		this.addRibbonIcon("messages-square", "Toggle comments sidebar", () => void this.toggleSidebarPanel());

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				// Right-click selects the word under the cursor, so offer both scopes
				// explicitly: comment on that selection, or on the whole line.
				if (editor.getSelection()) {
					menu.addItem((item) =>
						item
							.setTitle("Comment on selection")
							.setIcon("message-square")
							.onClick(() => this.startAddComment(editor, "selection")),
					);
				}
				menu.addItem((item) =>
					item
						.setTitle("Comment on line")
						.setIcon("message-square")
						.onClick(() => this.startAddComment(editor, "line")),
				);
			}),
		);

		// A note-wide comment is conceptually about the title, so offer it by
		// right-clicking the note's inline title. The inline title isn't part of the
		// editor surface (no editor-menu event), so hook its context menu directly —
		// putting our item on top and letting Obsidian + other plugins fill in the
		// usual file options (rename, delete, open in new tab, …) below it.
		this.registerDomEvent(document, "contextmenu", (e) => {
			if (!(e.target as HTMLElement).closest(".inline-title")) return;
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file) return;
			const file = view.file;
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Comment on whole file")
					.setIcon("message-square")
					.onClick(() => this.startAddFileComment(file)),
			);
			menu.addSeparator();
			this.app.workspace.trigger("file-menu", menu, file, "inline-title", view.leaf);
			menu.showAtMouseEvent(e);
		});

		this.addSettingTab(new DocCommentsSettingTab(this.app, this));
	}

	private startAddComment(editor: Editor, scope: "selection" | "line"): void {
		const view = editorView(editor);
		if (!view) {
			new Notice("Couldn't access the editor.");
			return;
		}
		let { from, to } = view.state.selection.main;
		if (scope === "line") {
			// Comment on the whole line the cursor sits on. Trim its leading/trailing
			// whitespace so the anchor wraps the meaningful text.
			const line = view.state.doc.lineAt(view.state.selection.main.head);
			from = line.from + (line.text.length - line.text.trimStart().length);
			to = line.to - (line.text.length - line.text.trimEnd().length);
			if (from >= to) {
				new Notice("This line is empty — nothing to comment on.");
				return;
			}
		} else if (from === to) {
			new Notice("Select some text to comment on.");
			return;
		}
		if (Platform.isMobile) {
			// No floating margin composer on mobile — collect the text in a modal,
			// then write through the same editor path so it's a single undo step.
			const quote = view.state.doc.sliceString(from, to);
			new CommentModal(this.app, quote, (text) => {
				const result = addComment(view, from, to, text, this.authorName());
				if (result.isErr()) new Notice(`Couldn't add the comment: ${result.error}`);
			}).open();
			return;
		}
		// Show a draft composer card in the margin (Notion-style) instead of a modal.
		view.dispatch({ effects: setDraft.of({ from, to }) });
	}

	/** Reading view has no editor surface, so map the rendered selection back to
	 *  source offsets (best-effort) and prompt for the comment text. */
	private startAddCommentReading(view: MarkdownView): void {
		const selection = activeWindow.getSelection();
		const selected = selection?.toString().trim() ?? "";
		if (!selection || selection.rangeCount === 0 || !selected) {
			new Notice("Select some text to comment on.");
			return;
		}
		const section = selection.anchorNode ? findSectionRange(selection.anchorNode) : null;
		if (!section) {
			new Notice("Couldn't locate that selection in the note.");
			return;
		}
		const idx = section.source.indexOf(selected);
		if (idx < 0) {
			new Notice("Couldn't map the selection to the Markdown — try plain text without formatting.");
			return;
		}
		const from = section.from + idx;
		const to = from + selected.length;
		if (Platform.isMobile) {
			// No margin composer on mobile — write straight to the file from a modal,
			// then refresh so the new highlight appears in the reading view.
			const file = view.file;
			if (!file) {
				new Notice("No file is open.");
				return;
			}
			new CommentModal(this.app, selected, (text) => {
				void this.insertReadingComment(file, from, to, text);
			}).open();
			return;
		}
		// Same inline draft composer as the editor (no modal).
		this.readingManager?.startDraft(view, from, to, selection.getRangeAt(0));
	}

	/** Mobile reading-view create: write to the file (no editor surface) and refresh.
	 *  insertCommentInFile already folds I/O + compute failures into the Result. */
	private async insertReadingComment(file: TFile, from: number, to: number, text: string): Promise<void> {
		(await insertCommentInFile(this.app, file, from, to, text, this.authorName())).match({
			ok: () => this.scheduleReadingRefresh(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
	}

	/** File-scope comment: no anchor span, so it's always composed in a dialog and
	 *  written straight to the file. It surfaces in the "All discussions" sidebar
	 *  (note-wide comments have no margin anchor to attach a floating card to). */
	private startAddFileComment(file: TFile): void {
		new CommentModal(this.app, file.basename, (text) => {
			void this.insertFileComment(file, text);
		}).open();
	}

	private async insertFileComment(file: TFile, text: string): Promise<void> {
		(await insertFileCommentInFile(this.app, file, text, this.authorName())).match({
			ok: () => this.refreshEditors(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
	}

	private async toggleComments(): Promise<void> {
		// With the sidebar hosting the comments, this button means "switch to the
		// inline cards": close the panel and make sure comments are shown, rather
		// than flipping the setting underneath an open panel.
		if (this.isSidebarVisible()) {
			this.closeSidebarPanel();
			if (!this.settings.showComments) {
				this.settings.showComments = true;
				await this.saveSettings();
			}
			this.updateRibbon();
			this.refreshEditors();
			return;
		}
		this.settings.showComments = !this.settings.showComments;
		await this.saveSettings();
		this.updateRibbon();
		this.refreshEditors();
	}

	private async toggleResolved(): Promise<void> {
		this.settings.showResolved = !this.settings.showResolved;
		await this.saveSettings();
		this.refreshEditors();
	}

	private updateRibbon(): void {
		if (!this.ribbonIcon) return;
		this.ribbonIcon.toggleClass("is-active", this.settings.showComments);
		// Static label, matching "Toggle comments sidebar" — the is-active tint
		// carries the on/off state, and with the sidebar open the action is
		// "switch to inline" rather than a plain show/hide anyway.
		this.ribbonIcon.setAttribute("aria-label", "Toggle document comments");
	}

	/** Force open editors + reading views (+ the sidebar) to re-evaluate live config. */
	refreshEditors(): void {
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf: WorkspaceLeaf) => {
			editorViewFromLeaf(leaf)?.dispatch({});
		});
		this.scheduleReadingRefresh();
		this.sidebarView()?.requestRefresh();
	}

	/** Ribbon/command behavior: close the panel when it's visible, else open it.
	 *  A panel that merely exists but is hidden (collapsed dock, background tab)
	 *  gets revealed rather than closed. */
	private async toggleSidebarPanel(): Promise<void> {
		if (this.isSidebarVisible()) {
			this.closeSidebarPanel();
			return;
		}
		await this.activateSidebar();
	}

	/** Close the comments panel for real: detach our tab AND collapse the dock it
	 *  lived in. Detaching alone leaves the dock expanded showing whatever tab is
	 *  next (backlinks, outline, …), which doesn't read as "closed" at all. */
	private closeSidebarPanel(): void {
		const { workspace } = this.app;
		const roots = new Set(workspace.getLeavesOfType(COMMENTS_VIEW_TYPE).map((leaf) => leaf.getRoot()));
		workspace.detachLeavesOfType(COMMENTS_VIEW_TYPE);
		// Opening expanded the dock (revealLeaf), so closing collapses it again. A
		// panel dragged into the main area just detaches — there's no dock to fold.
		if (roots.has(workspace.rightSplit)) workspace.rightSplit.collapse();
		if (roots.has(workspace.leftSplit)) workspace.leftSplit.collapse();
		this.syncSidebarOpen();
	}

	/** Reveal the comments sidebar panel, creating it in the right split if needed. */
	private async activateSidebar(): Promise<void> {
		const { workspace } = this.app;
		const opened = await Result.tryPromise({
			try: async () => {
				let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0] ?? null;
				if (!leaf) {
					leaf = workspace.getRightLeaf(false);
					if (!leaf) return;
					await leaf.setViewState({ type: COMMENTS_VIEW_TYPE, active: true });
				}
				await workspace.revealLeaf(leaf);
				this.syncSidebarOpen();
			},
			catch: (e) => (e instanceof Error ? e.message : "unknown error"),
		});
		if (opened.isErr()) new Notice(`Couldn't open the comments sidebar: ${opened.error}`);
	}

	/** Open the sidebar and scroll it to a thread — the escape from a margin card too
	 *  tall to fit the column even when expanded. */
	private async revealComment(id: string): Promise<void> {
		await this.activateSidebar();
		await this.sidebarView()?.revealComment(id);
	}

	/** The live sidebar view instance, if the panel is open. */
	private sidebarView(): CommentsSidebarView | null {
		const leaf = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0];
		return leaf?.view instanceof CommentsSidebarView ? leaf.view : null;
	}

	/** Recompute whether the comments panel is actually visible and, when that
	 *  changes, refresh editors so the inline column steps aside / comes back.
	 *  Visibility — not mere existence — is what matters: a collapsed dock or a
	 *  hidden tab must bring the inline cards back. */
	private syncSidebarOpen(): void {
		const open = this.isSidebarVisible();
		if (open === this.sidebarOpen) return;
		this.sidebarOpen = open;
		// The sidebar takes over from the inline cards: opening it flips the master
		// toggle OFF (not merely suppresses the column), so closing the panel later
		// doesn't pop the cards back. "Toggle document comments" brings them back.
		if (open && this.settings.showComments) {
			this.settings.showComments = false;
			void this.saveSettings();
			this.updateRibbon();
		}
		this.refreshEditors();
	}

	private isSidebarVisible(): boolean {
		const { workspace } = this.app;
		return workspace.getLeavesOfType(COMMENTS_VIEW_TYPE).some((leaf) => {
			// A collapsed dock flips `.collapsed` immediately; the DOM width animates,
			// so an offsetParent/size check alone lags a frame and misses the change.
			const root = leaf.getRoot();
			if (root === workspace.leftSplit && workspace.leftSplit.collapsed) return false;
			if (root === workspace.rightSplit && workspace.rightSplit.collapsed) return false;
			// Not in a collapsed dock — visible unless it's a hidden background tab.
			return leaf.view.containerEl.offsetParent !== null;
		});
	}

	onunload(): void {
		this.readingManager?.destroy();
	}

	private authorName(): string {
		return this.settings.author.trim() || "me";
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) as Partial<DocCommentsSettings> | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

const editorView = (editor: Editor): EditorView | null => {
	const cm = (editor as unknown as { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
};

const editorViewFromLeaf = (leaf: WorkspaceLeaf): EditorView | null => {
	return leaf.view instanceof MarkdownView ? editorView(leaf.view.editor) : null;
};
