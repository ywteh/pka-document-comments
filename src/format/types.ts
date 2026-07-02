export type CommentStatus = "open" | "resolved";

export type ThreadEntry = {
	author: string;
	/** ISO-8601 timestamp, optional (the first entry usually carries it via the header). */
	timestamp?: string;
	text: string;
};

export type Reaction = {
	emoji: string;
	authors: string[];
};

export type SuggestionState = "proposed" | "accepted" | "rejected";

/** One accept/reject-able edit, anchored to an `<!--e:editId-->…<!--/e:editId-->`
 *  marker pair in the prose. Accepting replaces the text between the markers with
 *  `replacement`; `was` is a human-readable staleness snapshot, not the matcher. */
export type Suggestion = {
	editId: string;
	was?: string;
	state: SuggestionState;
	replacement: string;
};

/** The content of a comment, independent of where it sits in the document. */
export type CommentData = {
	author?: string;
	createdAt?: string;
	status: CommentStatus;
	/** Redundant copy of the anchored text — the re-anchor fallback. */
	quote?: string;
	/** Pinned cross-note references (`[[wikilinks]]`) the reader must consult. */
	refs?: string[];
	thread: ThreadEntry[];
	suggestions: Suggestion[];
	reactions: Reaction[];
};

/** A suggestion with the resolved offsets of its `e:` marker pair in the document. */
export type ParsedSuggestion = Suggestion & {
	/** `<!--e:editId-->` marker range, or null if missing. */
	open: TextRange | null;
	/** `<!--/e:editId-->` marker range, or null if missing. */
	close: TextRange | null;
	/** True when the text now between the markers no longer matches `was:` — someone
	 *  edited the prose since the suggestion was made. A hint only: accepting still
	 *  replaces whatever currently sits between the markers. */
	stale: boolean;
	/** True when another comment's or edit's marker sits inside this suggestion's
	 *  replace range — accepting would destroy that marker (partial overlap / nested
	 *  anchor). Accept is blocked; reject stays safe (it only unwraps own markers). */
	conflict: boolean;
};

export type TextRange = {
	from: number;
	to: number;
};

/** A comment as found in a document, with resolved offsets for each piece.
 *  `suggestions` carry their own resolved `e:` marker ranges (see ParsedSuggestion). */
export type ParsedComment = {
	id: string;
	/** `<!--c:ID-->` marker range, or null if missing. */
	open: TextRange | null;
	/** `<!--/c:ID-->` marker range, or null if missing. */
	close: TextRange | null;
	/** `<!--co:ID ...-->` body block range, or null if missing. */
	body: TextRange | null;
	suggestions: ParsedSuggestion[];
} & Omit<CommentData, "suggestions">;
