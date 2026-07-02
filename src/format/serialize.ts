import { CommentData, Suggestion, ThreadEntry } from "./types";

export const openMarker = (id: string): string => {
	return `<!--c:${id}-->`;
};

export const closeMarker = (id: string): string => {
	return `<!--/c:${id}-->`;
};

/** Edit-target markers wrap the exact prose an accept/reject-able suggestion replaces. */
export const editOpenMarker = (editId: string): string => {
	return `<!--e:${editId}-->`;
};

export const editCloseMarker = (editId: string): string => {
	return `<!--/e:${editId}-->`;
};

/** Serialize a comment body block: `<!--co:ID header\n thread\n suggestions\n reactions\n-->`. */
export const serializeBody = (id: string, data: CommentData): string => {
	const head: string[] = [`co:${id}`];
	if (data.author) head.push(`by:${sanitizeToken(data.author)}`);
	if (data.createdAt) head.push(`at:${sanitizeToken(data.createdAt)}`);
	head.push(`status:${data.status}`);
	if (data.quote) head.push(`quote:"${sanitizeQuote(data.quote)}"`);
	// refs are quoted: `[[wikilinks]]` contain spaces the unquoted attr parser would truncate.
	if (data.refs && data.refs.length) head.push(`refs:"${sanitizeQuote(data.refs.join(","))}"`);

	const lines = data.thread.map(serializeEntry);
	const suggestionLines = (data.suggestions ?? []).map(serializeSuggestion);
	const reactionLines = (data.reactions ?? [])
		.filter((r) => r.authors.length > 0)
		.map((r) => `+${r.emoji} ${r.authors.join(", ")}`);
	const body = [...lines, ...suggestionLines, ...reactionLines];
	const block = body.length ? body.join("\n") + "\n" : "";
	return `<!--${head.join(" ")}\n${block}-->`;
};

/** `~ @editId was:"old" state:proposed -> "new"` — one line per suggestion. */
const serializeSuggestion = (s: Suggestion): string => {
	const parts = [`~ @${s.editId}`];
	if (s.was !== undefined) parts.push(`was:"${sanitizeQuote(s.was)}"`);
	parts.push(`state:${s.state}`);
	parts.push(`-> "${sanitizeQuote(s.replacement)}"`);
	return parts.join(" ");
};

const serializeEntry = (e: ThreadEntry): string => {
	const who = e.timestamp ? `${e.author} (${e.timestamp})` : e.author;
	return `${who}: ${sanitizeBodyText(e.text)}`;
};

/** Body text must never contain the comment terminator `-->`. Break it with a
 *  zero-width space so the block stays well-formed and the text reads the same. */
export const sanitizeBodyText = (s: string): string => {
	return s.replace(/-->/g, "--​>");
};

const sanitizeToken = (s: string): string => {
	return s.replace(/\s+/g, "_");
};

const sanitizeQuote = (s: string): string => {
	return s.replace(/\s+/g, " ").replace(/"/g, "'").trim();
};
