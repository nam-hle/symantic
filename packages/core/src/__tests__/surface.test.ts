import { fileURLToPath } from "node:url";

import { test, expect, describe, afterAll } from "vitest";

import { Engine } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

describe("publicSurface", () => {
	test("expands a barrel's named and star re-exports to concrete symbols", () => {
		const names = engine.publicSurface("src/barrel.ts").map((c) => c.qualifiedName);

		// named re-exports
		expect(names).toContain("src/shapes.ts:Circle");
		expect(names).toContain("src/shapes.ts:makeCircle");
		expect(names).toContain("src/shapes.ts:Shape");
		// star re-export `export * from "./square.js"`
		expect(names).toContain("src/square.ts:Square");
	});

	test("points each surfaced symbol at its true declaration, not the barrel", () => {
		const circle = engine.publicSurface("src/barrel.ts").find((c) => c.qualifiedName.endsWith(":Circle"));

		expect(circle?.position.file).toBe("src/shapes.ts");
	});
});
