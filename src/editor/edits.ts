import { Result } from "better-result";
import { CommentData, ParsedComment, Reaction, ThreadEntry } from "../format/types";
import { parseComments } from "../format/parse";
import { closeMarker, openMarker, serializeBody } from "../format/serialize";

/** A document edit in original coordinates (matches CodeMirror's ChangeSpec shape). */
export type Change = {
	from: number;
	to: number;
	insert: string;
};

export type NewCommentInput = {
	id: string;
	createdAt: string;
	author: string;
	text: string;
};

/** Wrap [from,to] with anchor markers and append a body block after the block.
 *  Errs (rather than returning null) so the caller sees why nothing was written. */
export const computeAddComment = (
	doc: string,
	from: number,
	to: number,
	input: NewCommentInput,
): Result<Change[], string> => {
	if (to < from) [from, to] = [to, from];
	if (to === from) return Result.err("Select some text to comment on.");

	const quote = doc.slice(from, to);
	const data: CommentData = {
		author: input.author,
		createdAt: input.createdAt,
		status: "open",
		quote,
		thread: [{ author: input.author, timestamp: input.createdAt, text: input.text }],
		suggestions: [],
		reactions: [],
	};
	const paraEnd = blockEnd(doc, to);
	return Result.ok([
		{ from, to: from, insert: openMarker(input.id) },
		{ from: to, to, insert: closeMarker(input.id) },
		{ from: paraEnd, to: paraEnd, insert: "\n" + serializeBody(input.id, data) },
	]);
};

/** Add a note-wide comment: a body block with no anchor span, appended at the end
 *  of the file (§5 file scope). It carries no `quote` — it's about the note as a
 *  whole. Surgical edits still attach via standalone `e:` anchors placed elsewhere. */
export const computeAddFileComment = (doc: string, input: NewCommentInput): Result<Change[], string> => {
	if (!input.text.trim()) return Result.err("Comment text is empty.");
	const data: CommentData = {
		author: input.author,
		createdAt: input.createdAt,
		status: "open",
		thread: [{ author: input.author, timestamp: input.createdAt, text: input.text }],
		suggestions: [],
		reactions: [],
	};
	const at = doc.length;
	// Keep the body block on its own line, whatever the file's trailing state.
	const lead = doc.length === 0 || doc.endsWith("\n") ? "" : "\n";
	return Result.ok([{ from: at, to: at, insert: lead + serializeBody(input.id, data) + "\n" }]);
};

export const computeAppendReply = (
	doc: string,
	id: string,
	entry: { createdAt: string; author: string; text: string },
): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({
		...toData(c),
		thread: [...c.thread, { author: entry.author, timestamp: entry.createdAt, text: entry.text }],
	}));
};

export const computeSetResolved = (doc: string, id: string, resolved: boolean): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({ ...toData(c), status: resolved ? "resolved" : "open" }));
};

/** Replace the text of the i-th message in a thread. */
export const computeEditEntry = (doc: string, id: string, index: number, text: string): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({
		...toData(c),
		thread: c.thread.map((e, i) => (i === index ? { ...e, text } : e)),
	}));
};

/** Remove the i-th message from a thread (used for replies). */
export const computeDeleteEntry = (doc: string, id: string, index: number): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({
		...toData(c),
		thread: c.thread.filter((_, i) => i !== index),
	}));
};

/** Add/remove the author from an emoji reaction. */
export const computeToggleReaction = (
	doc: string,
	id: string,
	emoji: string,
	author: string,
): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({ ...toData(c), reactions: toggleReactions(c.reactions, emoji, author) }));
};

/** Accept a suggestion: replace the text between its `e:` markers (and the markers
 *  themselves) with the replacement, drop the `~` line, and log the decision to the
 *  thread. Author/timestamp are injected so this stays pure. */
export const computeAcceptSuggestion = (
	doc: string,
	id: string,
	editId: string,
	logAuthor: string,
	loggedAt: string,
): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	if (!c.body) return Result.err("Comment has no body to update.");
	const s = c.suggestions.find((x) => x.editId === editId);
	if (!s) return Result.err("Suggestion not found.");
	if (!s.open || !s.close || s.open.to > s.close.from)
		return Result.err("Suggestion has no anchored text to replace.");
	if (s.conflict)
		return Result.err("This edit overlaps another comment or edit anchor — accepting would corrupt it.");

	// The replace span: the old text plus both markers.
	const changes: Change[] = [{ from: s.open.from, to: s.close.to, insert: s.replacement }];
	// A deletion (empty replacement) shouldn't leave doubled spaces or a dangling one
	// at a line edge: find the real prose characters flanking the span — looking
	// THROUGH any adjacent c:/e: markers, which often sit flush — and swallow one
	// space. "will <e>really</e> ship" → "will ship", not "will  ship".
	if (s.replacement === "") {
		const beforePos = skipMarkersBack(doc, s.open.from);
		const afterPos = skipMarkersFwd(doc, s.close.to);
		const before = beforePos > 0 ? doc[beforePos - 1] : "\n";
		const after = afterPos < doc.length ? doc[afterPos] : "\n";
		if (before === " " && (after === " " || after === "\n")) {
			changes.push({ from: beforePos - 1, to: beforePos, insert: "" });
		} else if (before === "\n" && after === " ") {
			changes.push({ from: afterPos, to: afterPos + 1, insert: "" });
		}
	}

	const was = s.was ?? doc.slice(s.open.to, s.close.from);
	const note: ThreadEntry = {
		author: logAuthor,
		timestamp: loggedAt,
		text: `Accepted edit: ${editSummary(was, s.replacement)}`,
	};
	// Accepting changes the anchored text, so refresh the redundant `quote:` snapshot
	// from the post-accept anchor (markers stripped, in case another edit still nests).
	// Only when the edit span actually sits inside the anchor — a standalone `e:`
	// elsewhere in the note doesn't change what this comment points at. (A swallowed
	// space isn't reflected here; sanitizeQuote collapses whitespace on write anyway.)
	const body = resolvedBody(c, editId, note);
	if (c.open && c.close && c.open.to <= c.close.from && s.open.from >= c.open.to && s.close.to <= c.close.from) {
		const anchored = doc.slice(c.open.to, s.open.from) + s.replacement + doc.slice(s.close.to, c.close.from);
		const quote = anchored.replace(/<!--\/?[ce]:[A-Za-z0-9]+-->/g, "").trim();
		body.quote = quote || undefined;
	}
	changes.push({ from: c.body.from, to: c.body.to, insert: serializeBody(id, body) });
	return Result.ok(changes);
};

/** Reject a suggestion: unwrap its `e:` markers (prose untouched), drop the `~` line,
 *  and log the decision. Tolerates a missing/half marker pair (cleans up the record). */
export const computeRejectSuggestion = (
	doc: string,
	id: string,
	editId: string,
	logAuthor: string,
	loggedAt: string,
): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	if (!c.body) return Result.err("Comment has no body to update.");
	const s = c.suggestions.find((x) => x.editId === editId);
	if (!s) return Result.err("Suggestion not found.");

	const was = s.was ?? (s.open && s.close ? doc.slice(s.open.to, s.close.from) : "");
	const note: ThreadEntry = {
		author: logAuthor,
		timestamp: loggedAt,
		text: `Rejected edit: ${editSummary(was, s.replacement)}`,
	};
	const changes: Change[] = [];
	if (s.open) changes.push({ from: s.open.from, to: s.open.to, insert: "" });
	if (s.close) changes.push({ from: s.close.from, to: s.close.to, insert: "" });
	changes.push({ from: c.body.from, to: c.body.to, insert: serializeBody(id, resolvedBody(c, editId, note)) });
	return Result.ok(changes);
};

// A run of adjacent c:/e: markers — deletions look through these to find the real
// flanking prose (a plugin-written anchor sits flush against the edit's markers).
const MARKER_CHAIN_FWD = /^(?:<!--\/?[ce]:[A-Za-z0-9]+-->)+/;
const MARKER_CHAIN_BACK = /(?:<!--\/?[ce]:[A-Za-z0-9]+-->)+$/;

const skipMarkersFwd = (doc: string, i: number): number => {
	const m = MARKER_CHAIN_FWD.exec(doc.slice(i));
	return m ? i + m[0].length : i;
};

const skipMarkersBack = (doc: string, i: number): number => {
	const m = MARKER_CHAIN_BACK.exec(doc.slice(0, i));
	return m ? i - m[0].length : i;
};

/** The comment's body with `editId`'s suggestion removed and `note` appended to the thread. */
const resolvedBody = (c: ParsedComment, editId: string, note: ThreadEntry): CommentData => ({
	...toData(c),
	thread: [...c.thread, note],
	suggestions: c.suggestions.filter((s) => s.editId !== editId),
});

const editSummary = (was: string, replacement: string): string =>
	replacement === "" ? `delete “${was}”` : `“${was}” → “${replacement}”`;

const replaceBody = (doc: string, id: string, mutate: (c: ParsedComment) => CommentData): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	if (!c.body) return Result.err("Comment has no body to update.");
	return Result.ok([{ from: c.body.from, to: c.body.to, insert: serializeBody(id, mutate(c)) }]);
};

const toData = (c: ParsedComment): CommentData => {
	return {
		author: c.author,
		createdAt: c.createdAt,
		status: c.status,
		quote: c.quote,
		refs: c.refs,
		thread: c.thread,
		suggestions: c.suggestions,
		reactions: c.reactions,
	};
};

const toggleReactions = (reactions: Reaction[], emoji: string, author: string): Reaction[] => {
	const out = reactions.map((r) => ({ emoji: r.emoji, authors: [...r.authors] }));
	const existing = out.find((r) => r.emoji === emoji);
	if (existing) {
		const idx = existing.authors.indexOf(author);
		if (idx >= 0) existing.authors.splice(idx, 1);
		else existing.authors.push(author);
	} else {
		out.push({ emoji, authors: [author] });
	}
	return out.filter((r) => r.authors.length > 0);
};

export const computeDeleteComment = (doc: string, id: string): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	const ranges: Change[] = [];
	if (c.open) ranges.push({ from: c.open.from, to: c.open.to, insert: "" });
	if (c.close) ranges.push({ from: c.close.from, to: c.close.to, insert: "" });
	if (c.body) {
		let from = c.body.from;
		if (from > 0 && doc.charCodeAt(from - 1) === 10) from -= 1;
		ranges.push({ from, to: c.body.to, insert: "" });
	}
	if (ranges.length === 0) return Result.err("Nothing to delete.");
	ranges.sort((a, b) => a.from - b.from);
	return Result.ok(ranges);
};

/** Apply changes (original coordinates, CM semantics) — used by tests. */
export const applyChanges = (doc: string, changes: Change[]): string => {
	const ordered = changes.map((c, i) => ({ ...c, i })).sort((a, b) => a.from - b.from || a.i - b.i);
	let out = "";
	let last = 0;
	for (const c of ordered) {
		out += doc.slice(last, c.from) + c.insert;
		last = Math.max(last, c.to);
	}
	return out + doc.slice(last);
};

/** End offset of the contiguous (non-blank) block of lines containing `pos`. */
export const blockEnd = (doc: string, pos: number): number => {
	let lineEnd = doc.indexOf("\n", pos);
	if (lineEnd === -1) return doc.length;
	for (;;) {
		const nextStart = lineEnd + 1;
		let nextEnd = doc.indexOf("\n", nextStart);
		if (nextEnd === -1) nextEnd = doc.length;
		if (doc.slice(nextStart, nextEnd).trim() === "") return lineEnd;
		lineEnd = nextEnd;
		if (nextEnd === doc.length) return doc.length;
	}
};
