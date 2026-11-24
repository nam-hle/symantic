import { fileURLToPath } from "node:url";

import { test, expect, describe, afterAll } from "vitest";

import { Engine } from "../index.js";

const tsConfigPath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

const engine = new Engine({ tsConfigPath });

afterAll(() => {
	engine.dispose();
});

describe("listImports", () => {
	test("lists named imports of a file with their module", () => {
		const imports = engine.listImports("src/consumer.ts");

		const shapes = imports.find((i) => i.module.endsWith("shapes.js"));
		expect(shapes).toBeDefined();
		expect(shapes?.named).toContain("makeCircle");
		expect(shapes?.named).toContain("Circle");
	});

	test("returns an empty list for a file with no imports", () => {
		expect(engine.listImports("src/nested.ts")).toEqual([]);
	});
});
