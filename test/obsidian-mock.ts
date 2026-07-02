// Runtime stand-in for the "obsidian" package (which ships only type
// declarations). Wired up via the resolve alias in vitest.config.ts, so any
// source module importing "obsidian" works under vitest. Only the APIs the
// DOM-layer components actually touch are provided.

export class Notice {
	constructor(_message?: string) {}
}

export const setIcon = (_el: HTMLElement, _icon: string): void => {};

export const Keymap = {
	isModEvent: (_e: unknown): boolean => false,
};

export class Component {
	load(): void {}
	unload(): void {}
	addChild(): void {}
	removeChild(): void {}
}

export const MarkdownRenderer = {
	render: async (): Promise<void> => {},
};

export class Menu {
	addItem(): this {
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtMouseEvent(): void {}
}

export const debounce = <T extends (...args: never[]) => void>(fn: T): T => fn;

export class Platform {
	static isMobile = false;
}
