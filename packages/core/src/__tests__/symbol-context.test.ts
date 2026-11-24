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
	const r = engine.resolveSymbol(name);

	if (r.kind !== "symbol") {
		throw new Error(`expected symbol, got ${r.kind}`);
	}

	return r.symbol;
}

describe("symbolContext", () => {
	test("bundles signature, source, callees and type refs", () => {
		const ctx = engine.symbolContext(resolve(engine, "src/consumer.ts:totalArea"));

		expect(ctx.signature).toContain("totalArea");
		expect(ctx.signature).not.toMatch(/\{/);
		expect(ctx.source).toContain("makeCircle");
		expect(ctx.typeRefs).toContain("Circle");
		expect(Array.isArray(ctx.callees)).toBe(true);
		expect(ctx.callees.some((c) => c.qualifiedName.includes("makeCircle"))).toBe(true);
	});

	test("callees exclude built-in / node_modules declarations", () => {
		const ctx = engine.symbolContext(resolve(engine, "src/consumer.ts:describeArea"));

		// Project callee kept, library intrinsics (String, Error) dropped.
		expect(ctx.callees.some((c) => c.qualifiedName.includes("averageArea"))).toBe(true);
		expect(ctx.callees.some((c) => c.position.file.includes("node_modules"))).toBe(false);
		expect(ctx.callees.some((c) => /\bString\b|\bError\b/.test(c.qualifiedName))).toBe(false);
	});

	test("empty sections are arrays, not omitted", () => {
		const ctx = engine.symbolContext(resolve(engine, "src/shapes.ts:Shape"));

		expect(Array.isArray(ctx.callees)).toBe(true);
		expect(Array.isArray(ctx.typeRefs)).toBe(true);
	});
});
