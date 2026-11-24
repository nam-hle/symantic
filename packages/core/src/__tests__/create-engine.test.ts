import { createRequire } from "node:module";

import { it, expect, describe } from "vitest";

import { Engine } from "../engine.js";
import { asAsync } from "../create-engine.js";
import { createEngine } from "../create-engine.js";

const require = createRequire(import.meta.url);
const tsConfigPath = require.resolve("./fixtures/sample/tsconfig.json");

describe("asAsync", () => {
	it("wraps a sync Engine so every op returns a Promise", async () => {
		const async = asAsync(new Engine({ tsConfigPath }));
		const r = await async.resolveSymbol("src/shapes.ts:makeCircle");

		expect(r.kind).toBe("symbol");
		await async.dispose();
	});

	it("exposes an awaitable refreshIfStale", async () => {
		const async = asAsync(new Engine({ tsConfigPath }));

		await expect(async.refreshIfStale()).resolves.toBeUndefined();
	});

	it("dispose releases the compiler process and is safe to repeat", async () => {
		const async = asAsync(new Engine({ tsConfigPath }));
		await async.resolveSymbol("src/shapes.ts:Circle");

		await expect(async.dispose()).resolves.toBeUndefined();
		await expect(async.dispose()).resolves.toBeUndefined();
	});

	it("forwards every wrapped op to the underlying engine", async () => {
		const e = asAsync(new Engine({ tsConfigPath }));
		const sym = await e.resolveSymbol("src/shapes.ts:Circle");

		if (sym.kind !== "symbol") {
			throw new Error("fixture symbol should resolve");
		}

		const handle = sym.symbol;

		// Touch each wrapper so the sync→async bridge is fully exercised (not just resolveSymbol).
		expect((await e.outlineFile("src/shapes.ts")).classes.length).toBeGreaterThan(0);
		expect(Array.isArray(await e.listImports("src/consumer.ts"))).toBe(true);
		expect(Array.isArray(await e.publicSurface("src/barrel.ts"))).toBe(true);
		expect(Array.isArray(await e.symbolSource(handle))).toBe(true);
		expect(Array.isArray(await e.outlineSymbol(handle))).toBe(true);
		expect(Array.isArray(await e.membersByName("src/shapes.ts:Circle"))).toBe(true);
		expect(typeof (await e.symbolContext(handle)).signature).toBe("string");
		expect(Array.isArray(await e.findDefinition(handle))).toBe(true);
		expect(Array.isArray(await e.findImplementations(handle))).toBe(true);
		expect(Array.isArray(await e.searchSymbol("Circle"))).toBe(true);
		expect(typeof (await e.readRegion("src/shapes.ts", 1, 2)).source).toBe("string");
		expect(Array.isArray((await e.findUsages(handle)).references)).toBe(true);
		expect(Array.isArray(await e.usageReport("src/shapes.ts"))).toBe(true);
		expect(Array.isArray(await e.callHierarchy(handle))).toBe(true);
		expect(Array.isArray(await e.outlineFunction(handle))).toBe(true);
		await e.dispose();
	});
});

describe("createEngine", () => {
	it("creates an engine answering through the async surface", async () => {
		const engine = createEngine({ tsConfigPath });

		try {
			const r = await engine.resolveSymbol("src/shapes.ts:makeCircle");

			expect(r.kind).toBe("symbol");
		} finally {
			await engine.dispose();
		}
	});

	it("re-warms after dispose", async () => {
		const engine = createEngine({ tsConfigPath });

		await engine.resolveSymbol("src/shapes.ts:Circle");
		await engine.dispose();

		try {
			expect((await engine.resolveSymbol("src/shapes.ts:Circle")).kind).toBe("symbol");
		} finally {
			await engine.dispose();
		}
	});
});
