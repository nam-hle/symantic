import { fileURLToPath } from "node:url";

import { test, expect, describe, afterAll } from "vitest";

import { Engine } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

describe("namespace-nested resolution", () => {
	test("resolves a dotted path into a namespace", () => {
		const result = engine.resolveSymbol("src/nested.ts:Model::Node");

		expect(result.kind).toBe("symbol");

		if (result.kind !== "symbol") {
			return;
		}

		expect(result.symbol.qualifiedName).toBe("src/nested.ts:Model::Node");
		expect(result.symbol.position.line).toBe(2);
	});

	test("resolves a deeply nested dotted path", () => {
		const result = engine.resolveSymbol("src/nested.ts:Model::Inner::Node");

		expect(result.kind).toBe("symbol");

		if (result.kind !== "symbol") {
			return;
		}

		expect(result.symbol.position.line).toBe(7);
	});

	test("a bare nested name returns candidates with dotted paths", () => {
		const result = engine.resolveSymbol("src/nested.ts:Node");

		expect(result.kind).toBe("ambiguous");

		if (result.kind !== "ambiguous") {
			return;
		}

		const names = result.candidates.map((c) => c.qualifiedName);
		expect(names).toContain("src/nested.ts:Model::Node");
		expect(names).toContain("src/nested.ts:Model::Inner::Node");
		expect(names).toContain("src/nested.ts:Runtime::Node");
	});

	test("resolves the namespace itself by dotted path", () => {
		const result = engine.resolveSymbol("src/nested.ts:Model");

		expect(result.kind).toBe("symbol");

		if (result.kind !== "symbol") {
			return;
		}

		expect(result.symbol.position.line).toBe(1);
	});

	test("a dotted member separator hints toward :: (#101)", () => {
		const result = engine.resolveSymbol("src/nested.ts:Model.Node");

		expect(result.kind).toBe("not-found");

		if (result.kind !== "not-found") {
			return;
		}

		expect(result.hint).toBeDefined();
		expect(result.hint).toContain("Model::Node");
		expect(result.hint).toContain("::");
	});

	test("membersByName folds a merged interface+namespace into one member list (#97)", () => {
		const members = engine.membersByName("src/merged.ts:Summary").map((m) => m.name);

		expect(members).toContain("total"); // interface member
		expect(members).toContain("isEmpty"); // namespace member
	});
});
