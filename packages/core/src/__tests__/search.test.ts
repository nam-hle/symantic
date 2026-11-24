import { fileURLToPath } from "node:url";

import { test, expect, describe, afterAll } from "vitest";

import { Engine } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

describe("searchSymbol", () => {
	test("finds every declaration of a name across the repo", () => {
		const hits = engine.searchSymbol("Node");

		const names = hits.map((h) => h.qualifiedName);
		expect(names).toContain("src/nested.ts:Model::Node");
		expect(names).toContain("src/nested.ts:Model::Inner::Node");
		expect(names).toContain("src/nested.ts:Runtime::Node");
	});

	test("matches the exact name, not substrings, by default", () => {
		const hits = engine.searchSymbol("Circle");

		expect(hits.map((h) => h.qualifiedName)).toEqual(["src/shapes.ts:Circle"]);
	});

	test("matches substrings when contains is set", () => {
		const exact = engine.searchSymbol("Make");
		const contains = engine.searchSymbol("Make", { contains: true });

		expect(exact).toHaveLength(0);
		expect(contains.map((h) => h.qualifiedName)).toContain("src/shapes.ts:makeCircle");
	});

	test("returns an empty list when nothing matches", () => {
		expect(engine.searchSymbol("DoesNotExistAnywhere")).toEqual([]);
	});

	test("excludeTests drops hits that live in test files", () => {
		// `fromTest` is declared in src/e2e/usage.ts — a test path per isTestFile.
		const all = engine.searchSymbol("fromTest").map((h) => h.qualifiedName);
		const prod = engine.searchSymbol("fromTest", { excludeTests: true }).map((h) => h.qualifiedName);

		expect(all).toContain("src/e2e/usage.ts:fromTest");
		expect(prod).not.toContain("src/e2e/usage.ts:fromTest");
	});

	test("kinds filters hits to the given short kinds", () => {
		// "Area" spans a fn (totalArea), const (averageArea), class (AreaService), iface (AreaCalculators).
		const classes = engine.searchSymbol("Area", { contains: true, kinds: ["cls"] }).map((h) => h.qualifiedName);
		const ifaces = engine.searchSymbol("Area", { contains: true, kinds: ["iface"] }).map((h) => h.qualifiedName);

		expect(classes).toContain("src/consumer.ts:AreaService");
		expect(classes).not.toContain("src/consumer.ts:totalArea");
		expect(classes).not.toContain("src/consumer.ts:AreaCalculators");
		expect(ifaces).toContain("src/consumer.ts:AreaCalculators");
		expect(ifaces).not.toContain("src/consumer.ts:AreaService");
	});

	test("path scopes hits to a file-path substring", () => {
		// "Area" lives only in consumer.ts here; "area" (case-insensitive contains) also hits
		// shapes.ts (Circle.area etc). Scoping by path keeps just the consumer.ts subtree.
		const all = engine.searchSymbol("area", { contains: true }).map((h) => h.qualifiedName);
		const scoped = engine.searchSymbol("area", { contains: true, path: "consumer" }).map((h) => h.qualifiedName);

		expect(all.some((q) => q.startsWith("src/shapes.ts"))).toBe(true);
		expect(scoped.every((q) => q.startsWith("src/consumer.ts"))).toBe(true);
		expect(scoped.length).toBeGreaterThan(0);
	});

	test("finds a shorthand method declared inside an object literal", () => {
		const names = engine.searchSymbol("greet").map((h) => h.qualifiedName);

		// class member already worked; the object-literal member is the regression target (#95).
		expect(names).toContain("src/resolvers.ts:LoudGreeter::greet");
		expect(names).toContain("src/resolvers.ts:politeGreeter::greet");
	});
});
