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

describe("symbolSource", () => {
	test("returns the exact declaration source of a function", () => {
		const [src] = engine.symbolSource(resolve(engine, "src/shapes.ts:makeCircle"));

		expect(src!.source).toContain("export function makeCircle");
		expect(src!.source).toContain("return new Circle");
		expect(src!.qualifiedName).toBe("src/shapes.ts:makeCircle");
		expect(src!.position.file).toBe("src/shapes.ts");
	});

	test("returns the class body source", () => {
		const [src] = engine.symbolSource(resolve(engine, "src/shapes.ts:Circle"));

		expect(src!.source).toContain("class Circle");
		expect(src!.source).toContain("area()");
	});
});
