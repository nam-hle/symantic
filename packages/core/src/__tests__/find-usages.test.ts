import { fileURLToPath } from "node:url";

import { test, expect, describe, afterAll } from "vitest";

import { Engine } from "../index.js";
import type { SymbolHandle } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

function resolve(engine: Engine, name: string): SymbolHandle {
	const result = engine.resolveSymbol(name);

	if (result.kind !== "symbol") {
		throw new Error(`expected symbol, got ${result.kind}`);
	}

	return result.symbol;
}

describe("findUsages", () => {
	test("finds usages of a function across files", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		const { total, references } = engine.findUsages(symbol);

		expect(total).toBe(references.length);
		const files = references.map((r) => r.position.file);
		expect(files.some((f) => f.endsWith("consumer.ts"))).toBe(true);
		expect(references.some((r) => r.kind === "import")).toBe(true);
		expect(references.some((r) => r.kind === "call")).toBe(true);
	});

	test("respects a result-set limit and returns a cursor", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		const page = engine.findUsages(symbol, { limit: 1 });

		expect(page.references).toHaveLength(1);
		expect(page.total).toBeGreaterThan(1);
		expect(page.nextCursor).toBeDefined();
	});

	test("paginates from a valid cursor", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		const first = engine.findUsages(symbol, { limit: 1 });
		const next = engine.findUsages(symbol, { limit: 1, cursor: first.nextCursor });

		expect(next.references[0]!.position).not.toEqual(first.references[0]!.position);
	});

	test("rejects a non-numeric cursor instead of silently restarting", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		expect(() => engine.findUsages(symbol, { cursor: "abc" })).toThrow(/cursor/);
		expect(() => engine.findUsages(symbol, { cursor: "-1" })).toThrow(/cursor/);
		expect(() => engine.findUsages(symbol, { cursor: "1.5" })).toThrow(/cursor/);
	});

	test("tags test-file references and can exclude them", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		const all = engine.findUsages(symbol);
		const noTests = engine.findUsages(symbol, { excludeTests: true });

		expect(all.references.some((r) => r.test === true)).toBe(true);
		expect(noTests.references.every((r) => r.test !== true)).toBe(true);
		expect(noTests.total).toBeLessThan(all.total);
	});

	test("omits context by default and on context=none", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		expect(engine.findUsages(symbol).references.every((r) => r.context === undefined)).toBe(true);
		expect(engine.findUsages(symbol, { context: "none" }).references.every((r) => r.context === undefined)).toBe(true);
	});

	test("context=snippet attaches the trimmed reference line", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		const refs = engine.findUsages(symbol, { context: "snippet" }).references;

		expect(refs.every((r) => typeof r.context === "string")).toBe(true);
		// A call site's snippet contains the call; snippets are single-line + trimmed.
		const callRef = refs.find((r) => r.kind === "call");
		expect(callRef!.context).toContain("makeCircle");
		expect(callRef!.context).not.toMatch(/\n/);
		expect(callRef!.context).toBe(callRef!.context!.trim());
	});

	test("context=block attaches the enclosing statement text", () => {
		const symbol = resolve(engine, "src/shapes.ts:makeCircle");

		const refs = engine.findUsages(symbol, { context: "block" }).references;
		const callRef = refs.find((r) => r.kind === "call");

		expect(callRef!.context).toContain("makeCircle");
		// The block is the enclosing statement — at least as much as the snippet.
		expect(callRef!.context!.length).toBeGreaterThan(0);
	});
});

describe("findUsages — compiler semantics", () => {
	test("includes the symbol's own declaration, kind declaration", () => {
		const { references } = engine.findUsages(resolve(engine, "src/shapes.ts:makeCircle"));
		const declaration = references.filter((r) => r.kind === "declaration");

		expect(declaration).toHaveLength(1);
		expect(declaration[0]!.position).toEqual({ col: 17, line: 12, file: "src/shapes.ts" });
	});

	test("returns a merged interface + namespace symbol whole from either declaration", () => {
		const lines = (name: string): number[] =>
			engine
				.findUsages(resolve(engine, name))
				.references.filter((r) => r.position.file === "src/merged.ts")
				.map((r) => r.position.line)
				.sort((a, b) => a - b);

		// interface name (3), namespace name (7), and the `Summary` type uses inside the namespace.
		const fromInterface = lines("src/merged.ts:Summary#0");

		expect(fromInterface).toContain(3);
		expect(fromInterface).toContain(7);
		expect(fromInterface).toContain(8);
		expect(lines("src/merged.ts:Summary#1")).toEqual(fromInterface);
	});
});
