import { describe, it, expect } from "vitest";
import {
	parseComments,
	anchorRange,
	isAnchored,
	isOrphan,
	isFileComment,
	existingIds,
	editTextRange,
	isEditAnchored,
} from "../src/format/parse";
import { serializeBody, openMarker, closeMarker, editOpenMarker, editCloseMarker } from "../src/format/serialize";
import { generateId } from "../src/format/ids";
import { CommentData } from "../src/format/types";

const CANONICAL = [
	"We should " + openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9") + " regardless of the QA timeline.",
	'<!--co:k3f9 by:kyle at:2026-06-17T10:00 status:open quote:"ship on Friday"',
	"kyle: I thought we agreed Thursday?",
	"sam (2026-06-17T11:00): Thursday is better for QA.",
	"-->",
	"",
	"Next paragraph.",
].join("\n");

describe("parseComments", () => {
	it("parses the canonical example", () => {
		const comments = parseComments(CANONICAL);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		expect(c.id).toBe("k3f9");
		expect(c.author).toBe("kyle");
		expect(c.createdAt).toBe("2026-06-17T10:00");
		expect(c.status).toBe("open");
		expect(c.quote).toBe("ship on Friday");
		expect(c.thread).toHaveLength(2);
		expect(c.thread[0]).toMatchObject({ author: "kyle", text: "I thought we agreed Thursday?" });
		expect(c.thread[1]).toMatchObject({
			author: "sam",
			timestamp: "2026-06-17T11:00",
			text: "Thursday is better for QA.",
		});
	});

	it("resolves the anchor range to the highlighted text", () => {
		const c = parseComments(CANONICAL)[0];
		expect(isAnchored(c)).toBe(true);
		const r = anchorRange(c)!;
		expect(CANONICAL.slice(r.from, r.to)).toBe("ship on Friday");
	});

	it("parses a resolved status", () => {
		const doc = openMarker("a1") + "x" + closeMarker("a1") + "\n<!--co:a1 status:resolved\nme: done\n-->";
		expect(parseComments(doc)[0].status).toBe("resolved");
	});

	it("distinguishes an orphan (lost anchor, has quote) from a file comment (never anchored)", () => {
		// A quote: means it USED to sit on text — the markers are gone, so it's orphaned.
		const orphan = parseComments('X.\n<!--co:zz9 status:open quote:"gone text"\nme: dangling\n-->')[0];
		expect(isAnchored(orphan)).toBe(false);
		expect(isOrphan(orphan)).toBe(true);
		expect(isFileComment(orphan)).toBe(false);
		// No quote: a deliberate whole-file comment, not an orphan.
		const fileLevel = parseComments("X.\n<!--co:ff1 status:open\nme: about this note\n-->")[0];
		expect(isOrphan(fileLevel)).toBe(false);
		expect(isFileComment(fileLevel)).toBe(true);
	});

	it("handles multiple and overlapping comments", () => {
		const doc =
			openMarker("aaa") +
			"the " +
			openMarker("bbb") +
			"quick brown" +
			closeMarker("bbb") +
			" fox" +
			closeMarker("aaa") +
			"\n<!--co:aaa status:open\nme: outer\n-->\n<!--co:bbb status:open\nme: inner\n-->";
		const comments = parseComments(doc);
		expect(comments.map((c) => c.id).sort()).toEqual(["aaa", "bbb"]);
		const aaa = comments.find((c) => c.id === "aaa")!;
		const bbb = comments.find((c) => c.id === "bbb")!;
		expect(doc.slice(anchorRange(aaa)!.from, anchorRange(aaa)!.to)).toBe(
			"the " + openMarker("bbb") + "quick brown" + closeMarker("bbb") + " fox",
		);
		expect(doc.slice(anchorRange(bbb)!.from, anchorRange(bbb)!.to)).toBe("quick brown");
	});

	it("collects existing ids", () => {
		expect([...existingIds(CANONICAL)]).toEqual(["k3f9"]);
	});

	it("ignores markers inside fenced code blocks", () => {
		const doc = [
			"Here is documentation:",
			"",
			"```markdown",
			openMarker("ex01") + "example span" + closeMarker("ex01"),
			"<!--co:ex01 status:open\nme: not a real comment\n-->",
			"```",
			"",
			"But this " + openMarker("real1") + "is real" + closeMarker("real1") + ".",
			"<!--co:real1 status:open\nme: real\n-->",
		].join("\n");
		const comments = parseComments(doc);
		expect(comments.map((c) => c.id)).toEqual(["real1"]);
	});

	it("ignores markers inside inline code", () => {
		const doc = "Use the `" + openMarker("inl01") + "` marker syntax to open a comment.";
		expect(parseComments(doc)).toHaveLength(0);
	});
});

describe("serializeBody round-trip", () => {
	it("survives serialize -> parse", () => {
		const data: CommentData = {
			author: "kyle",
			createdAt: "2026-06-17T10:00:00.000Z",
			status: "open",
			quote: "ship on Friday",
			thread: [
				{ author: "kyle", text: "I thought we agreed Thursday?" },
				{ author: "sam", timestamp: "2026-06-17T11:00:00.000Z", text: "Thursday is better for QA." },
			],
		};
		const doc = openMarker("k3f9") + "X" + closeMarker("k3f9") + "\n" + serializeBody("k3f9", data);
		const c = parseComments(doc)[0];
		expect(c.author).toBe(data.author);
		expect(c.createdAt).toBe(data.createdAt);
		expect(c.status).toBe(data.status);
		expect(c.quote).toBe(data.quote);
		expect(c.thread).toEqual(data.thread);
	});

	it("serializes a resolved, reply-only thread", () => {
		const data: CommentData = {
			author: "me",
			status: "resolved",
			thread: [{ author: "me", text: "ok" }],
		};
		const body = serializeBody("z1", data);
		expect(body.startsWith("<!--co:z1")).toBe(true);
		expect(body.endsWith("-->")).toBe(true);
		const c = parseComments("<!--c:z1-->q<!--/c:z1-->\n" + body)[0];
		expect(c.status).toBe("resolved");
		expect(c.thread).toEqual(data.thread);
	});
});

describe("edit suggestions", () => {
	const WITH_EDITS = [
		"We will " +
			editOpenMarker("e1") +
			"definitely" +
			editCloseMarker("e1") +
			" ship on " +
			editOpenMarker("e2") +
			"Friday" +
			editCloseMarker("e2") +
			" after review.",
		"<!--co:k3f9 by:claude status:open",
		"claude: Tighten this and fix the date.",
		'~ @e1 was:"definitely" state:proposed -> ""',
		'~ @e2 was:"Friday" state:proposed -> "Thursday"',
		"-->",
	].join("\n");

	it("parses suggestion lines with state and was", () => {
		const c = parseComments(WITH_EDITS)[0];
		expect(c.suggestions).toHaveLength(2);
		expect(c.suggestions[0]).toMatchObject({ editId: "e1", was: "definitely", state: "proposed", replacement: "" });
		expect(c.suggestions[1]).toMatchObject({
			editId: "e2",
			was: "Friday",
			state: "proposed",
			replacement: "Thursday",
		});
	});

	it("resolves each suggestion's edit-target range to the old text", () => {
		const c = parseComments(WITH_EDITS)[0];
		expect(isEditAnchored(c.suggestions[0])).toBe(true);
		const r1 = editTextRange(c.suggestions[0])!;
		expect(WITH_EDITS.slice(r1.from, r1.to)).toBe("definitely");
		const r2 = editTextRange(c.suggestions[1])!;
		expect(WITH_EDITS.slice(r2.from, r2.to)).toBe("Friday");
	});

	it("marks a suggestion whose e: markers are missing as not anchored", () => {
		const doc = '<!--c:z1-->x<!--/c:z1-->\n<!--co:z1 status:open\n~ @gone state:proposed -> "new"\n-->';
		const s = parseComments(doc)[0].suggestions[0];
		expect(isEditAnchored(s)).toBe(false);
		expect(editTextRange(s)).toBe(null);
	});

	it("defaults an unknown/absent state to proposed", () => {
		const doc = '<!--co:z2 status:open\n~ @e9 -> "x"\n-->';
		expect(parseComments(doc)[0].suggestions[0].state).toBe("proposed");
	});

	it("ignores e: markers inside fenced code blocks", () => {
		const doc = [
			"```markdown",
			editOpenMarker("fake") + "example" + editCloseMarker("fake"),
			"```",
			"Real " + editOpenMarker("real") + "text" + editCloseMarker("real") + ".",
			'<!--co:c1 status:open\n~ @real state:proposed -> "new"\n-->',
		].join("\n");
		const s = parseComments(doc)[0].suggestions[0];
		expect(editTextRange(s)).not.toBe(null);
		expect(doc.slice(editTextRange(s)!.from, editTextRange(s)!.to)).toBe("text");
	});

	it("round-trips suggestions and refs through serialize -> parse", () => {
		const data: CommentData = {
			author: "claude",
			status: "open",
			refs: ["[[Project X]]", "[[Note B]]"],
			thread: [{ author: "claude", text: "see refs" }],
			suggestions: [
				{ editId: "e1", was: "old text", state: "accepted", replacement: "new text" },
				{ editId: "e2", state: "rejected", replacement: "" },
			],
			reactions: [],
		};
		const doc =
			editOpenMarker("e1") +
			"old text" +
			editCloseMarker("e1") +
			" " +
			editOpenMarker("e2") +
			"y" +
			editCloseMarker("e2") +
			"\n" +
			serializeBody("q1", data);
		const c = parseComments(doc)[0];
		expect(c.refs).toEqual(["[[Project X]]", "[[Note B]]"]);
		expect(
			c.suggestions.map((s) => ({ editId: s.editId, was: s.was, state: s.state, replacement: s.replacement })),
		).toEqual(data.suggestions);
	});
});

describe("suggestion staleness", () => {
	const withEdit = (marked: string, was: string) =>
		editOpenMarker("e1") +
		marked +
		editCloseMarker("e1") +
		`\n<!--co:c1 status:open\n~ @e1 was:"${was}" state:proposed -> "x"\n-->`;

	it("is not stale when the anchored text still matches was:", () => {
		expect(parseComments(withEdit("Friday", "Friday"))[0].suggestions[0].stale).toBe(false);
	});

	it("flags stale when the prose between the markers has changed", () => {
		expect(parseComments(withEdit("Monday", "Friday"))[0].suggestions[0].stale).toBe(true);
	});

	it("ignores cosmetic whitespace differences", () => {
		expect(parseComments(withEdit("ship   on  Friday", "ship on Friday"))[0].suggestions[0].stale).toBe(false);
	});

	it("is not stale when there are no markers to compare against", () => {
		const doc = '<!--co:c1 status:open\n~ @gone was:"Friday" state:proposed -> "x"\n-->';
		expect(parseComments(doc)[0].suggestions[0].stale).toBe(false);
	});
});

describe("suggestion overlap conflicts", () => {
	const suggestion = (id: string, editId: string) =>
		`<!--co:${id} status:open\n~ @${editId} state:proposed -> "x"\n-->`;

	it("is clean for an edit nested inside its comment's own anchor", () => {
		const doc = "A <!--c:c1-->quick <!--e:e1-->brown<!--/e:e1--> fox<!--/c:c1-->.\n" + suggestion("c1", "e1");
		expect(parseComments(doc)[0].suggestions[0].conflict).toBe(false);
	});

	it("flags an edit that straddles an anchor boundary (partial overlap)", () => {
		const doc = "A <!--c:c1-->quick <!--e:e1-->brown<!--/c:c1--> fox<!--/e:e1-->.\n" + suggestion("c1", "e1");
		expect(parseComments(doc)[0].suggestions[0].conflict).toBe(true);
	});

	it("flags an edit with another comment's anchor nested fully inside it", () => {
		const doc =
			"A <!--e:e1-->quick <!--c:c2-->brown<!--/c:c2--> fox<!--/e:e1-->.\n" +
			suggestion("c1", "e1") +
			'\n<!--co:c2 status:open quote:"brown"\nme: hi\n-->';
		const c1 = parseComments(doc).find((c) => c.id === "c1")!;
		expect(c1.suggestions[0].conflict).toBe(true);
	});

	it("flags an edit containing another suggestion's edit markers", () => {
		const doc =
			"A <!--e:e1-->quick <!--e:e2-->brown<!--/e:e2--> fox<!--/e:e1-->.\n" +
			`<!--co:c1 status:open\n~ @e1 state:proposed -> "x"\n~ @e2 state:proposed -> "y"\n-->`;
		const [c] = parseComments(doc);
		expect(c.suggestions.find((s) => s.editId === "e1")?.conflict).toBe(true);
		// The inner edit is fine: accepting it destroys nothing outside itself.
		expect(c.suggestions.find((s) => s.editId === "e2")?.conflict).toBe(false);
	});
});

describe("generateId", () => {
	it("avoids collisions with existing ids", () => {
		const existing = new Set(["a", "b", "c"]);
		const id = generateId(existing);
		expect(existing.has(id)).toBe(false);
		expect(id).toMatch(/^[a-z0-9]+$/);
	});
});
