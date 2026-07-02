import { describe, it, expect } from "vitest";
import {
	applyChanges,
	blockEnd,
	computeAcceptSuggestion,
	computeAddComment,
	computeAddFileComment,
	computeAppendReply,
	computeDeleteComment,
	computeRejectSuggestion,
	computeSetResolved,
} from "../src/editor/edits";
import { anchorRange, isAnchored, isFileComment, isOrphan, parseComments } from "../src/format/parse";
import { closeMarker, editCloseMarker, editOpenMarker, openMarker, serializeBody } from "../src/format/serialize";

const DOC = "We should ship on Friday regardless of the QA timeline.\n\nNext paragraph.\n";
const FROM = DOC.indexOf("ship on Friday");
const TO = FROM + "ship on Friday".length;

function add(): string {
	const changes = computeAddComment(DOC, FROM, TO, {
		id: "k3f9",
		createdAt: "2026-06-17T10:00:00.000Z",
		author: "kyle",
		text: "I thought we agreed Thursday?",
	}).unwrap();
	return applyChanges(DOC, changes);
}

describe("computeAddComment", () => {
	it("wraps the selection and appends a body", () => {
		const out = add();
		const c = parseComments(out)[0];
		expect(c.id).toBe("k3f9");
		expect(c.author).toBe("kyle");
		expect(c.thread[0].text).toBe("I thought we agreed Thursday?");
		expect(out.slice(anchorRange(c)!.from, anchorRange(c)!.to)).toBe("ship on Friday");
	});

	it("places markers and body exactly", () => {
		const out = add();
		expect(out).toContain(openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9"));
		expect(out).toContain("QA timeline.\n<!--co:k3f9");
	});

	it("keeps the prose intact once markup is stripped", () => {
		const out = add();
		expect(stripComments(out)).toContain("We should ship on Friday regardless of the QA timeline.");
	});

	it("errs for an empty selection", () => {
		const result = computeAddComment(DOC, FROM, FROM, { id: "x", createdAt: "t", author: "a", text: "b" });
		expect(result.isErr()).toBe(true);
	});
});

describe("reply / resolve", () => {
	it("appends a reply", () => {
		const out = applyChanges(
			add(),
			computeAppendReply(add(), "k3f9", {
				createdAt: "2026-06-17T11:00:00.000Z",
				author: "sam",
				text: "Thursday is better",
			}).unwrap(),
		);
		const c = parseComments(out)[0];
		expect(c.thread).toHaveLength(2);
		expect(c.thread[1]).toMatchObject({ author: "sam", text: "Thursday is better" });
	});

	it("toggles resolved status", () => {
		const resolved = applyChanges(add(), computeSetResolved(add(), "k3f9", true).unwrap());
		expect(parseComments(resolved)[0].status).toBe("resolved");
		const reopened = applyChanges(resolved, computeSetResolved(resolved, "k3f9", false).unwrap());
		expect(parseComments(reopened)[0].status).toBe("open");
	});

	it("errs when the comment id is unknown", () => {
		expect(computeSetResolved(add(), "nope", true).isErr()).toBe(true);
	});
});

describe("computeAddFileComment", () => {
	const input = {
		id: "f1",
		createdAt: "2026-07-01T09:00:00.000Z",
		author: "me",
		text: "A note about the whole file.",
	};

	it("appends a body-only comment with no anchor span", () => {
		const out = applyChanges(DOC, computeAddFileComment(DOC, input).unwrap());
		const c = parseComments(out)[0];
		expect(c.id).toBe("f1");
		expect(c.body).not.toBeNull();
		expect(c.open).toBeNull();
		expect(c.close).toBeNull();
		expect(isAnchored(c)).toBe(false);
		expect(isFileComment(c)).toBe(true); // no anchor AND no quote — note-wide by design
		expect(isOrphan(c)).toBe(false); // never anchored ≠ lost its anchor
		expect(c.quote).toBeUndefined();
		expect(c.thread[0]).toMatchObject({ author: "me", text: "A note about the whole file." });
	});

	it("leaves the prose untouched", () => {
		const out = applyChanges(DOC, computeAddFileComment(DOC, input).unwrap());
		expect(stripComments(out)).toContain("We should ship on Friday regardless of the QA timeline.");
	});

	it("adds a separating newline when the file doesn't end in one", () => {
		const noTrailing = "Just one line, no newline";
		const out = applyChanges(noTrailing, computeAddFileComment(noTrailing, input).unwrap());
		expect(out.startsWith("Just one line, no newline\n<!--co:f1")).toBe(true);
	});

	it("errs on empty text", () => {
		expect(computeAddFileComment(DOC, { ...input, text: "   " }).isErr()).toBe(true);
	});
});

describe("computeDeleteComment", () => {
	it("round-trips back to the original document", () => {
		const out = add();
		const restored = applyChanges(out, computeDeleteComment(out, "k3f9").unwrap());
		expect(restored).toBe(DOC);
	});
});

describe("accept / reject suggestion", () => {
	const EDIT_DOC =
		"We will " +
		editOpenMarker("e1") +
		"definitely" +
		editCloseMarker("e1") +
		" ship on " +
		editOpenMarker("e2") +
		"Friday" +
		editCloseMarker("e2") +
		" after review.\n" +
		serializeBody("k3f9", {
			author: "claude",
			createdAt: "2026-06-17T10:00:00.000Z",
			status: "open",
			thread: [{ author: "claude", timestamp: "2026-06-17T10:00:00.000Z", text: "Tighten and fix the date." }],
			suggestions: [
				{ editId: "e1", was: "definitely", state: "proposed", replacement: "" },
				{ editId: "e2", was: "Friday", state: "proposed", replacement: "Thursday" },
			],
			reactions: [],
		});

	const accept = (doc: string, editId: string): string =>
		applyChanges(doc, computeAcceptSuggestion(doc, "k3f9", editId, "me", "2026-06-17T12:00:00.000Z").unwrap());
	const reject = (doc: string, editId: string): string =>
		applyChanges(doc, computeRejectSuggestion(doc, "k3f9", editId, "me", "2026-06-17T12:00:00.000Z").unwrap());

	it("accepts a replacement: swaps the text, unwraps the markers, drops the line", () => {
		const out = accept(EDIT_DOC, "e2");
		expect(out).toContain("ship on Thursday after review.");
		expect(out).not.toContain(editOpenMarker("e2"));
		expect(out).not.toContain(editCloseMarker("e2"));
		const c = parseComments(out)[0];
		expect(c.suggestions.map((s) => s.editId)).toEqual(["e1"]); // e2 gone, e1 remains
		expect(c.thread[c.thread.length - 1]).toMatchObject({
			author: "me",
			text: "Accepted edit: “Friday” → “Thursday”",
		});
	});

	it("refreshes the quote: snapshot when accepting an edit inside a c: anchor", () => {
		const doc =
			"Ship on <!--c:c1--><!--e:x1-->Friday<!--/e:x1--><!--/c:c1-->.\n" +
			serializeBody("c1", {
				status: "open",
				quote: "Friday",
				thread: [{ author: "claude", text: "fix the day" }],
				suggestions: [{ editId: "x1", was: "Friday", state: "proposed", replacement: "Thursday" }],
				reactions: [],
			});
		const out = applyChanges(
			doc,
			computeAcceptSuggestion(doc, "c1", "x1", "me", "2026-07-01T00:00:00.000Z").unwrap(),
		);
		expect(out).toContain("Ship on <!--c:c1-->Thursday<!--/c:c1-->."); // e: markers gone, c: anchor stays
		expect(out).not.toContain(editOpenMarker("x1"));
		expect(parseComments(out)[0].quote).toBe("Thursday"); // stale "Friday" snapshot refreshed
	});

	it("accepts a deletion: removes the anchored text and the doubled space", () => {
		const out = accept(EDIT_DOC, "e1");
		expect(out).toContain("We will ship on"); // "definitely" gone, single space kept
		expect(out).not.toContain(editOpenMarker("e1"));
		const c = parseComments(out)[0];
		expect(c.thread[c.thread.length - 1].text).toBe("Accepted edit: delete “definitely”");
	});

	it("accepting a deletion at a line end trims the dangling space", () => {
		const doc =
			"Ship it <!--e:t1-->soon<!--/e:t1-->\nNext line.\n" +
			serializeBody("d1", {
				status: "open",
				thread: [{ author: "claude", text: "cut it" }],
				suggestions: [{ editId: "t1", was: "soon", state: "proposed", replacement: "" }],
				reactions: [],
			});
		const out = applyChanges(doc, computeAcceptSuggestion(doc, "d1", "t1", "me", "t").unwrap());
		expect(out).toContain("Ship it\nNext line.");
	});

	it("swallows the doubled space through a flush c: anchor marker", () => {
		// The comment anchor sits flush against the edit markers — the space to swallow
		// is beyond <!--/c:...-->, not directly adjacent to the replace span.
		const doc =
			"We will <!--c:dsx--><!--e:d1-->definitely<!--/e:d1--><!--/c:dsx--> ship.\n" +
			serializeBody("dsx", {
				status: "open",
				quote: "definitely",
				thread: [{ author: "claude", text: "cut it" }],
				suggestions: [{ editId: "d1", was: "definitely", state: "proposed", replacement: "" }],
				reactions: [],
			});
		const out = applyChanges(doc, computeAcceptSuggestion(doc, "dsx", "d1", "me", "t").unwrap());
		expect(out).toContain("We will<!--c:dsx--><!--/c:dsx--> ship."); // single space survives
		expect(out.replace(/<!--[^>]*-->/g, "")).toContain("We will ship.");
	});

	it("accepting a deletion at a line start trims the leading space", () => {
		const doc =
			"Intro.\n<!--e:t2-->Well,<!--/e:t2--> we ship.\n" +
			serializeBody("d2", {
				status: "open",
				thread: [{ author: "claude", text: "cut it" }],
				suggestions: [{ editId: "t2", was: "Well,", state: "proposed", replacement: "" }],
				reactions: [],
			});
		const out = applyChanges(doc, computeAcceptSuggestion(doc, "d2", "t2", "me", "t").unwrap());
		expect(out).toContain("Intro.\nwe ship.");
	});

	it("rejects: unwraps the markers but leaves the prose, drops the line", () => {
		const out = reject(EDIT_DOC, "e2");
		expect(out).toContain("ship on Friday after review."); // prose untouched
		expect(out).not.toContain(editOpenMarker("e2"));
		const c = parseComments(out)[0];
		expect(c.suggestions.map((s) => s.editId)).toEqual(["e1"]);
		expect(c.thread[c.thread.length - 1]).toMatchObject({
			author: "me",
			text: "Rejected edit: “Friday” → “Thursday”",
		});
	});

	it("accepting then the other leaves clean prose and no suggestions", () => {
		const out = accept(accept(EDIT_DOC, "e2"), "e1");
		expect(out).toContain("We will ship on Thursday after review.");
		expect(parseComments(out)[0].suggestions).toHaveLength(0);
	});

	it("blocks accepting an edit whose range overlaps another anchor", () => {
		// e:o1 opens inside c:c9's anchor but closes beyond it — accepting would
		// destroy the <!--/c:c9--> marker caught inside the replace range.
		const doc =
			"A <!--c:c9-->quick <!--e:o1-->brown<!--/c:c9--> fox<!--/e:o1--> jumps.\n" +
			serializeBody("c9", {
				status: "open",
				quote: "quick brown",
				thread: [{ author: "claude", text: "overlapping" }],
				suggestions: [{ editId: "o1", state: "proposed", replacement: "red" }],
				reactions: [],
			});
		const res = computeAcceptSuggestion(doc, "c9", "o1", "me", "t");
		expect(res.isErr()).toBe(true);
		expect(res.isErr() && res.error).toMatch(/overlaps/);
		// Rejecting stays safe: it only unwraps o1's own markers.
		const out = applyChanges(doc, computeRejectSuggestion(doc, "c9", "o1", "me", "t").unwrap());
		expect(out).toContain("A <!--c:c9-->quick brown<!--/c:c9--> fox jumps.");
	});

	it("errs when the suggestion or comment is unknown", () => {
		expect(computeAcceptSuggestion(EDIT_DOC, "k3f9", "nope", "me", "t").isErr()).toBe(true);
		expect(computeAcceptSuggestion(EDIT_DOC, "zzz", "e1", "me", "t").isErr()).toBe(true);
	});

	it("errs when accepting an unanchored suggestion (no markers)", () => {
		const doc = '<!--c:z1-->x<!--/c:z1-->\n<!--co:z1 status:open\n~ @gone state:proposed -> "new"\n-->';
		expect(computeAcceptSuggestion(doc, "z1", "gone", "me", "t").isErr()).toBe(true);
		// ...but rejecting one is fine — it just clears the stale line.
		const out = applyChanges(doc, computeRejectSuggestion(doc, "z1", "gone", "me", "t").unwrap());
		expect(parseComments(out)[0].suggestions).toHaveLength(0);
	});
});

describe("blockEnd", () => {
	it("stops at the blank line after a paragraph", () => {
		expect(blockEnd(DOC, TO)).toBe(DOC.indexOf("\n"));
	});
	it("returns doc length when no trailing newline", () => {
		const d = "single line no newline";
		expect(blockEnd(d, 3)).toBe(d.length);
	});
});

function stripComments(s: string): string {
	return s.replace(/<!--\/?co?:[A-Za-z0-9]+[\s\S]*?-->/g, "");
}
