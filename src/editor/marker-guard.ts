import { ChangeSpec, EditorState, findClusterBreak } from "@codemirror/state";
import { commentField } from "./state";

/**
 * Backspace/Delete at an anchor's edge must eat the adjacent VISIBLE character,
 * not the invisible marker. The markers are hidden replace decorations exposed as
 * atomic ranges, so CodeMirror's delete commands extend a single keypress to the
 * whole marker — one Backspace after `<!--/c:x-->` silently destroyed the pair
 * (orphaning the comment), or, after a hidden body block, the entire thread.
 *
 * This filter catches a single-character delete whose range is EXACTLY one hidden
 * atomic range and rewrites it: skip over the whole chain of flush hidden ranges,
 * then delete one grapheme cluster (or the newline) of real text beyond it. With
 * nothing visible beyond, the keypress becomes a no-op. Deliberate selection
 * deletions are untouched — removing a whole anchored span orphans the comment,
 * and the orphan banner surfaces that.
 */
export const markerDeleteGuard = EditorState.transactionFilter.of((tr) => {
	const backward = tr.isUserEvent("delete.backward");
	if (!tr.docChanged || (!backward && !tr.isUserEvent("delete.forward"))) return tr;
	const fv = tr.startState.field(commentField, false);
	if (!fv) return tr;

	// The exact ranges the caret treats as atomic (markers + body blocks).
	const hidden: Array<{ from: number; to: number }> = [];
	fv.atomic.between(0, tr.startState.doc.length, (from, to) => {
		hidden.push({ from, to });
	});
	if (hidden.length === 0) return tr;
	const exact = new Set(hidden.map((h) => `${h.from}:${h.to}`));
	const endsAt = new Map(hidden.map((h) => [h.to, h.from]));
	const startsAt = new Map(hidden.map((h) => [h.from, h.to]));

	const doc = tr.startState.doc;
	let rewrote = false;
	const changes: ChangeSpec[] = [];
	tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		if (inserted.length > 0 || !exact.has(`${from}:${to}`)) {
			changes.push({ from, to, insert: inserted });
			return;
		}
		rewrote = true;
		if (backward) {
			let p = from;
			for (let f = endsAt.get(p); f !== undefined; f = endsAt.get(p)) p = f;
			if (p === 0) return; // nothing visible before the chain — no-op
			const line = doc.lineAt(p);
			const delFrom = p === line.from ? p - 1 : line.from + findClusterBreak(line.text, p - line.from, false);
			changes.push({ from: delFrom, to: p });
		} else {
			let q = to;
			for (let t = startsAt.get(q); t !== undefined; t = startsAt.get(q)) q = t;
			if (q === doc.length) return; // nothing visible after the chain — no-op
			const line = doc.lineAt(q);
			const delTo = q === line.to ? q + 1 : line.from + findClusterBreak(line.text, q - line.from, true);
			changes.push({ from: q, to: delTo });
		}
	});
	if (!rewrote) return tr;
	return [
		{
			changes,
			scrollIntoView: true,
			userEvent: backward ? "delete.backward" : "delete.forward",
		},
	];
});
