import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	resolve: {
		alias: {
			// The real "obsidian" package is type declarations only (no runtime JS), so
			// any source module importing it can't load under vitest. Point it at a
			// minimal runtime mock instead.
			obsidian: resolve(__dirname, "test/obsidian-mock.ts"),
		},
	},
});
