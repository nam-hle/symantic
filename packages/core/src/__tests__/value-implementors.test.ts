import { fileURLToPath } from "node:url";

import { test, expect, describe, afterAll } from "vitest";

import { Engine } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

describe("findImplementations — value implementors", () => {
	test("names const-object implementors and finds all in one file", () => {
		const result = engine.resolveSymbol("src/resolvers.ts:Greeter");

		if (result.kind !== "symbol") {
			throw new Error("expected symbol");
		}

		const names = engine.findImplementations(result.symbol).map((h) => h.qualifiedName.split(":").pop());

		expect(names).toContain("politeGreeter");
		expect(names).toContain("casualGreeter");
		expect(names).toContain("LoudGreeter");
	});
});
