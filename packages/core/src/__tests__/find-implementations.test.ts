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

describe("findImplementations", () => {
	test("finds all classes implementing an interface", () => {
		const shape = resolve(engine, "src/shapes.ts:Shape");

		const impls = engine.findImplementations(shape);

		const names = impls.map((h) => h.qualifiedName);
		expect(names).toContain("src/shapes.ts:Circle");
		expect(names).toContain("src/square.ts:Square");
	});
});

describe("findImplementations — heritage and object literals", () => {
	const namesOf = (name: string): string[] => engine.findImplementations(resolve(engine, name)).map((h) => h.qualifiedName);

	test("finds subclasses of an abstract class", () => {
		expect(namesOf("src/inherit.ts:Base")).toEqual(["src/inherit.ts:Derived"]);
	});

	test("finds extending interfaces and object literals typed by annotation or satisfies", () => {
		const names = namesOf("src/inherit.ts:Named");

		expect(names).toContain("src/inherit.ts:Titled");
		expect(names).toContain("src/inherit.ts:annotated");
		expect(names).toContain("src/inherit.ts:checked");
	});
});
