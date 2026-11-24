import { fileURLToPath } from "node:url";

import { test, expect, afterAll, describe } from "vitest";

import { Engine } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

describe("engine edge cases", () => {
	test("findDefinition on a missing file returns empty", () => {
		expect(engine.findDefinition({ qualifiedName: "nope.ts:X", position: { col: 0, line: 0, file: "" } })).toEqual([]);
	});

	test("findDefinition with an out-of-range index returns empty", () => {
		expect(
			engine.findDefinition({
				qualifiedName: "src/shapes.ts:Circle#5",
				position: { col: 0, line: 0, file: "" }
			})
		).toEqual([]);
	});

	test("findUsages on a missing file returns an empty bounded result", () => {
		const result = engine.findUsages({
			qualifiedName: "nope.ts:X",
			position: { col: 0, line: 0, file: "" }
		});
		expect(result).toEqual({ total: 0, references: [], nextCursor: undefined });
	});

	test("outlineFile throws for a file not in the project", () => {
		expect(() => engine.outlineFile("nope.ts")).toThrow(/file not found in project/);
	});

	test("outlineSymbol on a non-class/interface returns empty", () => {
		const resolved = engine.resolveSymbol("src/shapes.ts:makeCircle");

		if (resolved.kind !== "symbol") {
			throw new Error("expected symbol");
		}

		expect(engine.outlineSymbol(resolved.symbol)).toEqual([]);
	});

	test("findImplementations on a non-interface returns empty", () => {
		const resolved = engine.resolveSymbol("src/shapes.ts:Circle");

		if (resolved.kind !== "symbol") {
			throw new Error("expected symbol");
		}

		expect(engine.findImplementations(resolved.symbol)).toEqual([]);
	});

	test("refreshIfStale before any query is a no-op", () => {
		expect(() => new Engine({ tsConfigPath }).refreshIfStale()).not.toThrow();
	});
});
