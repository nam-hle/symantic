import type { ReferenceKind } from "../../types.js";

/**
 * Reference-classification corpus: one case per kind of reference site (see classify.test.ts).
 *
 * `name` is the identifier classified; `occurrence` is the zero-based index of the
 * occurrence to test (0 = first), so each case pins exactly one site; `expected` is the
 * kind that occurrence must produce.
 */
export interface ClassifyCase {
	code: string;
	name: string;
	occurrence: number;
	expected: ReferenceKind;
}

export const CLASSIFY_CORPUS: ClassifyCase[] = [
	{ code: `import { foo } from "./m.js"; foo();`, name: "foo", occurrence: 0, expected: "import" },
	{ code: `import * as ns from "./m.js"; ns.x;`, name: "ns", occurrence: 0, expected: "import" },
	{ code: `export { foo } from "./m.js";`, name: "foo", occurrence: 0, expected: "re-export" },
	{ code: `declare function foo(): void; foo();`, name: "foo", occurrence: 1, expected: "call" },
	{ code: `class Foo {} new Foo();`, name: "Foo", occurrence: 1, expected: "call" },
	{ code: `namespace NS { export function go(): void {} } NS.go();`, name: "go", occurrence: 1, expected: "call" },
	{ code: `interface Foo {} const a: Foo = {} as Foo;`, name: "Foo", occurrence: 1, expected: "type-ref" },
	{ code: `let x = 1; x = 2;`, name: "x", occurrence: 1, expected: "write" },
	{ code: `let x = 1; const y = x + 1;`, name: "x", occurrence: 1, expected: "read" }
];
