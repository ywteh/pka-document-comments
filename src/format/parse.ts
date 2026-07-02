import {
	CommentData,
	CommentStatus,
	ParsedComment,
	ParsedSuggestion,
	Reaction,
	Suggestion,
	SuggestionState,
	TextRange,
	ThreadEntry,
} from "./types";

// Anchor + body markers. All are HTML comments so they're invisible everywhere.
const OPEN_RE = /<!--c:([A-Za-z0-9]+)-->/g;
const CLOSE_RE = /<!--\/c:([A-Za-z0-9]+)-->/g;
// Edit-target markers: drift-proof anchors delimiting the prose a suggestion replaces.
const EDIT_OPEN_RE = /<!--e:([A-Za-z0-9]+)-->/g;
const EDIT_CLOSE_RE = /<!--\/e:([A-Za-z0-9]+)-->/g;
// <!--co:ID <header, rest of first line>\n <thread...> -->
const BODY_RE = /<!--co:([A-Za-z0-9]+)[ \t]*([^\n]*)\n?([\s\S]*?)-->/g;

const HEADER_ATTR_RE = /(\w+):(?:"([^"]*)"|(\S+))/g;
// author, optional "(timestamp)", then ": text"
const THREAD_LINE_RE = /^(.*?)(?:\s\(([^)]*)\))?:\s?([\s\S]*)$/;
// ~ @editId <was:"…" state:…> -> "new text"
const SUGGESTION_LINE_RE = /^~\s*@(\S+)\s*(.*?)\s*->\s*"([\s\S]*)"\s*$/;

/** Parse every comment in a document, in order of first appearance. */
export const parseComments = (doc: string): ParsedComment[] => {
	const masks = maskedRanges(doc);
	const masked = (index: number) => isInside(masks, index);

	const opens = new Map<string, TextRange>();
	const closes = new Map<string, TextRange>();
	const editOpens = new Map<string, TextRange>();
	const editCloses = new Map<string, TextRange>();
	// Every marker with its owner ("c:ID" / "e:ID") — the overlap check scans this
	// for foreign markers caught inside a suggestion's replace range.
	const markers: Array<{ owner: string; range: TextRange }> = [];
	const bodies = new Map<string, { range: TextRange; data: CommentData }>();
	const order: string[] = [];
	const seen = new Set<string>();
	const track = (id: string) => {
		if (!seen.has(id)) {
			seen.add(id);
			order.push(id);
		}
	};

	let m: RegExpExecArray | null;

	OPEN_RE.lastIndex = 0;
	while ((m = OPEN_RE.exec(doc))) {
		if (masked(m.index)) continue;
		const range = { from: m.index, to: m.index + m[0].length };
		if (!opens.has(m[1])) opens.set(m[1], range);
		markers.push({ owner: `c:${m[1]}`, range });
		track(m[1]);
	}

	CLOSE_RE.lastIndex = 0;
	while ((m = CLOSE_RE.exec(doc))) {
		if (masked(m.index)) continue;
		const range = { from: m.index, to: m.index + m[0].length };
		if (!closes.has(m[1])) closes.set(m[1], range);
		markers.push({ owner: `c:${m[1]}`, range });
		track(m[1]);
	}

	// Edit-target anchors are keyed by their own editId (not a comment id) and may
	// stand alone anywhere; a suggestion's `~ @editId` line binds them to a comment.
	EDIT_OPEN_RE.lastIndex = 0;
	while ((m = EDIT_OPEN_RE.exec(doc))) {
		if (masked(m.index)) continue;
		const range = { from: m.index, to: m.index + m[0].length };
		if (!editOpens.has(m[1])) editOpens.set(m[1], range);
		markers.push({ owner: `e:${m[1]}`, range });
	}

	EDIT_CLOSE_RE.lastIndex = 0;
	while ((m = EDIT_CLOSE_RE.exec(doc))) {
		if (masked(m.index)) continue;
		const range = { from: m.index, to: m.index + m[0].length };
		if (!editCloses.has(m[1])) editCloses.set(m[1], range);
		markers.push({ owner: `e:${m[1]}`, range });
	}

	BODY_RE.lastIndex = 0;
	while ((m = BODY_RE.exec(doc))) {
		if (masked(m.index)) continue;
		const id = m[1];
		if (!bodies.has(id)) {
			const { thread, suggestions, reactions } = parseBody(m[3] ?? "");
			const data: CommentData = {
				...parseHeader(m[2] ?? ""),
				thread,
				suggestions,
				reactions,
			};
			bodies.set(id, { range: { from: m.index, to: m.index + m[0].length }, data });
		}
		track(id);
	}

	const resolveSuggestion = (s: Suggestion): ParsedSuggestion => {
		const open = editOpens.get(s.editId) ?? null;
		const close = editCloses.get(s.editId) ?? null;
		let stale = false;
		let conflict = false;
		if (open && close && open.to <= close.from) {
			if (s.was !== undefined) {
				stale = normalizeQuote(doc.slice(open.to, close.from)) !== normalizeQuote(s.was);
			}
			// Accepting replaces [open.from, close.to] wholesale. Any foreign marker in
			// that span — a partially-overlapping anchor or one nested inside the edit
			// target — would be destroyed by the replacement, so flag it (§10 phase 6:
			// flag, don't clobber). Full containment the other way round is fine.
			conflict = markers.some(
				(mk) => mk.owner !== `e:${s.editId}` && mk.range.from < close.to && mk.range.to > open.from,
			);
		}
		return { ...s, open, close, stale, conflict };
	};

	const result: ParsedComment[] = [];
	for (const id of order) {
		const body = bodies.get(id);
		const data: CommentData = body ? body.data : { status: "open", thread: [], suggestions: [], reactions: [] };
		result.push({
			id,
			author: data.author,
			createdAt: data.createdAt,
			status: data.status,
			quote: data.quote,
			refs: data.refs,
			thread: data.thread,
			suggestions: data.suggestions.map(resolveSuggestion),
			reactions: data.reactions,
			open: opens.get(id) ?? null,
			close: closes.get(id) ?? null,
			body: body ? body.range : null,
		});
	}
	return result;
};

/** The set of ids already present in a document (for id generation). */
export const existingIds = (doc: string): Set<string> => new Set(parseComments(doc).map((c) => c.id));

/** A comment is anchored when both markers are present and ordered. */
export const isAnchored = (c: ParsedComment): boolean => {
	return !!c.open && !!c.close && c.open.to <= c.close.from;
};

/** The highlighted text range (between the markers), or null if not anchored. */
export const anchorRange = (c: ParsedComment): TextRange | null => {
	return isAnchored(c) ? { from: c.open!.to, to: c.close!.from } : null;
};

/** A deliberate whole-file comment: a body with no anchor AND no `quote:` — it was
 *  never attached to text. The UI hangs these off the note title. */
export const isFileComment = (c: ParsedComment): boolean => {
	return !!c.body && !isAnchored(c) && c.quote === undefined;
};

/** A comment that LOST its anchor: it has a body and a `quote:` snapshot of the text
 *  it used to sit on, but the markers are gone/broken. Distinct from a file comment —
 *  surface it with a warning (and the quote, for manual re-anchoring), not as a
 *  note-wide banner. */
export const isOrphan = (c: ParsedComment): boolean => {
	return !!c.body && !isAnchored(c) && c.quote !== undefined;
};

/** A suggestion is anchored when both `e:` markers are present and ordered. */
export const isEditAnchored = (s: ParsedSuggestion): boolean => {
	return !!s.open && !!s.close && s.open.to <= s.close.from;
};

/** The text range an accepted suggestion replaces (between its `e:` markers), or null. */
export const editTextRange = (s: ParsedSuggestion): TextRange | null => {
	return isEditAnchored(s) ? { from: s.open!.to, to: s.close!.from } : null;
};

const parseHeader = (header: string): Omit<CommentData, "thread" | "suggestions" | "reactions"> => {
	const attrs: Record<string, string> = {};
	let m: RegExpExecArray | null;
	HEADER_ATTR_RE.lastIndex = 0;
	while ((m = HEADER_ATTR_RE.exec(header))) {
		attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
	}
	const status: CommentStatus = attrs.status === "resolved" ? "resolved" : "open";
	const refs = attrs.refs
		? attrs.refs
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean)
		: undefined;
	return {
		author: attrs.by,
		createdAt: attrs.at,
		status,
		quote: attrs.quote,
		refs: refs && refs.length ? refs : undefined,
	};
};

/** Ranges that should be ignored when scanning for markers: fenced and inline code. */
const maskedRanges = (doc: string): Array<[number, number]> => {
	const ranges: Array<[number, number]> = [];

	// Fenced code blocks (``` or ~~~), masked from the opening fence to the closing fence line.
	let offset = 0;
	let fenceStart = -1;
	let fenceChar = "";
	for (const line of doc.split("\n")) {
		const lineEnd = offset + line.length;
		const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
		if (fenceStart < 0 && fence) {
			fenceStart = offset;
			fenceChar = fence[1][0];
		} else if (fenceStart >= 0 && fence && fence[1][0] === fenceChar) {
			ranges.push([fenceStart, lineEnd]);
			fenceStart = -1;
		}
		offset = lineEnd + 1;
	}
	if (fenceStart >= 0) ranges.push([fenceStart, doc.length]);

	// Inline code spans.
	const inline = /`+[^`\n]*`+/g;
	let m: RegExpExecArray | null;
	while ((m = inline.exec(doc))) ranges.push([m.index, m.index + m[0].length]);

	return ranges;
};

const isInside = (ranges: Array<[number, number]>, index: number): boolean => {
	for (const [from, to] of ranges) {
		if (index >= from && index < to) return true;
	}
	return false;
};

const REACTION_LINE_RE = /^\+\s*(\S+)\s+(.+)$/;

const parseBody = (block: string): { thread: ThreadEntry[]; suggestions: Suggestion[]; reactions: Reaction[] } => {
	const thread: ThreadEntry[] = [];
	const suggestions: Suggestion[] = [];
	const reactions: Reaction[] = [];
	for (const raw of block.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (line.trim() === "") continue;

		const sx = SUGGESTION_LINE_RE.exec(line);
		if (sx) {
			suggestions.push(parseSuggestion(sx[1], sx[2] ?? "", sx[3] ?? ""));
			continue;
		}

		const rx = REACTION_LINE_RE.exec(line);
		if (rx) {
			const authors = rx[2]
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean);
			reactions.push({ emoji: rx[1], authors });
			continue;
		}

		const m = THREAD_LINE_RE.exec(line);
		if (m && m[1].trim() !== "") {
			thread.push({ author: m[1].trim(), timestamp: m[2] || undefined, text: m[3] });
		} else if (thread.length > 0) {
			// Unstructured continuation line — fold into the previous entry.
			thread[thread.length - 1].text += "\n" + line;
		} else {
			thread.push({ author: "", text: line });
		}
	}
	return { thread, suggestions, reactions };
};

// Compare anchored text to `was:` the same way it was written (serialize.ts
// sanitizeQuote): collapse whitespace, straighten quotes, trim. Avoids false
// "stale" flags from cosmetic whitespace/quote differences.
const normalizeQuote = (s: string): string => s.replace(/\s+/g, " ").replace(/"/g, "'").trim();

const parseSuggestion = (editId: string, attrsPart: string, replacement: string): Suggestion => {
	const attrs: Record<string, string> = {};
	let m: RegExpExecArray | null;
	HEADER_ATTR_RE.lastIndex = 0;
	while ((m = HEADER_ATTR_RE.exec(attrsPart))) {
		attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
	}
	const state: SuggestionState =
		attrs.state === "accepted" ? "accepted" : attrs.state === "rejected" ? "rejected" : "proposed";
	return { editId, was: attrs.was, state, replacement };
};
