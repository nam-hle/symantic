import { API } from "typescript/sync";
import type { Node } from "typescript/ast";
import { isIdentifier } from "typescript/ast";
import { it, test, expect, afterAll, describe } from "vitest";

import { forEachDescendant } from "../nodes.js";
import { classifyReference } from "../usages.js";
import type { ReferenceKind } from "../index.js";
import { CLASSIFY_CORPUS } from "./fixtures/classify-corpus.js";

const api = new API({ cwd: process.cwd() });

afterAll(() => {
	api.close();
});

/** Parse one in-memory file and return the identifiers named `name`, in source order. */
function identifiers(code: string, name: string): Node[] {
	const retained = api.createSourceFile("/virtual/t.ts", code);
	const found: Node[] = [];
	forEachDescendant(retained.sourceFile, (node) => {
		if (isIdentifier(node) && node.text === name) {
			found.push(node);
		}
	});

	return found;
}

function kindsOf(code: string, name: string): ReferenceKind[] {
	return identifiers(code, name).map((id) => classifyReference(id));
}

describe("classifyReference", () => {
	test("named import specifier -> import", () => {
		expect(kindsOf(`import { foo } from "./m.js"; foo();`, "foo")).toContain("import");
	});

	test("default/namespace import clause -> import", () => {
		expect(kindsOf(`import * as ns from "./m.js"; ns.x;`, "ns")).toContain("import");
	});

	test("barrel re-export specifier -> re-export", () => {
		expect(kindsOf(`export { foo } from "./m.js";`, "foo")).toContain("re-export");
	});

	test("call target -> call", () => {
		expect(kindsOf(`declare function foo(): void; foo();`, "foo")).toContain("call");
	});

	test("new target -> call", () => {
		expect(kindsOf(`class Foo {} new Foo();`, "Foo")).toContain("call");
	});

	test("namespace-qualified call target -> call", () => {
		expect(kindsOf(`namespace NS { export function go(): void {} } NS.go();`, "go")).toContain("call");
	});

	test("type annotation -> type-ref", () => {
		expect(kindsOf(`interface Foo {} const a: Foo = {} as Foo;`, "Foo")).toContain("type-ref");
	});

	test("assignment LHS -> write", () => {
		expect(kindsOf(`let x = 1; x = 2;`, "x")).toContain("write");
	});

	test("plain reference -> read", () => {
		expect(kindsOf(`let x = 1; const y = x + 1;`, "x")).toContain("read");
	});

	describe("shared corpus", () => {
		for (const { code, name, expected, occurrence } of CLASSIFY_CORPUS) {
			it(`${expected}: ${code}`, () => {
				const node = identifiers(code, name)[occurrence];
				expect(node).toBeDefined();
				expect(classifyReference(node!)).toBe(expected);
			});
		}
	});
});
