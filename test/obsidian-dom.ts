// Minimal stand-ins for Obsidian's HTMLElement prototype extensions, so DOM-heavy
// components (Card, MarginView) can run under happy-dom. Complements a vi.mock of
// the "obsidian" module (which ships only type declarations, no runtime).

type Info = string | { cls?: string | string[]; text?: string; attr?: Record<string, string> };

const build = (doc: Document, tag: string, o?: Info): HTMLElement => {
	const el = doc.createElement(tag);
	if (typeof o === "string") el.className = o;
	else if (o) {
		if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
		if (o.text) el.textContent = o.text;
		if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	}
	return el;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export const installObsidianDom = (): void => {
	const p = HTMLElement.prototype as any;
	p.createDiv = function (o?: Info) {
		const el = build(this.ownerDocument, "div", o);
		this.appendChild(el);
		return el;
	};
	p.createEl = function (tag: string, o?: Info) {
		const el = build(this.ownerDocument, tag, o);
		this.appendChild(el);
		return el;
	};
	p.createSpan = function (o?: Info) {
		const el = build(this.ownerDocument, "span", o);
		this.appendChild(el);
		return el;
	};
	p.empty = function () {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	p.setText = function (t: string) {
		this.textContent = t;
	};
	p.toggleClass = function (cls: string, on: boolean) {
		this.classList.toggle(cls, on);
	};
	p.addClass = function (...cls: string[]) {
		this.classList.add(...cls);
	};
	p.removeClass = function (...cls: string[]) {
		this.classList.remove(...cls);
	};
	p.setCssStyles = function (styles: Record<string, string>) {
		Object.assign(this.style, styles);
	};
	// Card constructs its root via the GLOBAL createDiv (documentless helper).
	(globalThis as any).createDiv = (o?: Info) => build(document, "div", o);
	if (!(globalThis as any).ResizeObserver) {
		(globalThis as any).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
};
