import { it, expect, describe } from "vitest";

import { slicePage, shellWord, commandLine, continuation } from "../paging.js";

describe("slicePage", () => {
	it("returns the window and the full total", () => {
		expect(slicePage([1, 2, 3, 4, 5], 1, 2)).toEqual({ total: 5, items: [2, 3] });
		expect(slicePage([1, 2], 5, 2)).toEqual({ total: 2, items: [] });
	});
});

describe("commandLine", () => {
	it("quotes only the words that need it and drops unset flags", () => {
		const line = commandLine(["find", "refs", "src/a b.ts:Foo"], {
			json: true,
			context: undefined,
			"exclude-tests": false,
			tsconfig: "tsconfig.json"
		});

		expect(line).toBe("symantic find refs 'src/a b.ts:Foo' --json --tsconfig tsconfig.json");
	});

	it("escapes a single quote inside a word", () => {
		expect(shellWord("it's")).toBe("'it'\\''s'");
	});
});

describe("continuation", () => {
	const call = { words: ["find", "symbol", "e"], flags: { contains: true }, narrowWith: "--kind" };

	it("is undefined when the page reaches the end", () => {
		expect(continuation({ offset: 0, limit: 5, shown: 5, total: 5 }, call)).toBeUndefined();
	});

	it("says what was cut and gives the runnable next command", () => {
		expect(continuation({ offset: 0, limit: 50, shown: 50, total: 410 }, call)).toEqual({
			note: "50 of 410 shown. Narrow with --kind, or raise --limit",
			next: "symantic find symbol e --contains --cursor 50 --limit 50"
		});
	});

	it("points a cursor past the end back to the first page", () => {
		expect(continuation({ offset: 500, limit: 50, shown: 0, total: 411 }, call)).toEqual({
			note: "cursor 500 is past the end (total 411)",
			next: "symantic find symbol e --contains --limit 50"
		});
	});

	it("is undefined for an empty list, where there is no page to point at", () => {
		expect(continuation({ offset: 0, limit: 50, shown: 0, total: 0 }, call)).toBeUndefined();
	});

	it("names the range of a later page", () => {
		const result = continuation({ offset: 50, limit: 50, shown: 50, total: 410 }, call);

		expect(result?.note).toBe("51-100 of 410 shown. Narrow with --kind, or raise --limit");
		expect(result?.next).toContain("--cursor 100");
	});
});
