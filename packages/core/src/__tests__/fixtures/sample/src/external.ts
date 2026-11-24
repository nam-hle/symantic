// A named import from an external (non-relative) module. Addressing `external.ts:Node`
// follows the import across the package boundary to its declaration (#100).
import type { Node } from "typescript/ast";

export function nodeKind(node: Node): number {
	return node.kind;
}
