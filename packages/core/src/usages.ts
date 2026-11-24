/**
 * Reference classification for findUsages. Maps a reference node to a ReferenceKind by
 * inspecting its syntactic context. Deterministic, no LLM.
 */
import type { Node } from "typescript/ast";
import { SyntaxKind, isNewExpression, isCallExpression, isBinaryExpression, isExportDeclaration, isPropertyAccessExpression } from "typescript/ast";

import { ancestorOfKind } from "./nodes.js";
import type { ReferenceKind } from "./types.js";

export function classifyReference(node: Node): ReferenceKind {
	// `export { X } from "..."` — a barrel re-export, distinct from a consuming import.
	const exportSpecifier = ancestorOfKind(node, SyntaxKind.ExportSpecifier);

	if (exportSpecifier !== undefined) {
		const exportDecl = ancestorOfKind(exportSpecifier, SyntaxKind.ExportDeclaration);

		if (exportDecl !== undefined && isExportDeclaration(exportDecl) && exportDecl.moduleSpecifier !== undefined) {
			return "re-export";
		}
	}

	if (
		ancestorOfKind(node, SyntaxKind.ImportSpecifier) !== undefined ||
		ancestorOfKind(node, SyntaxKind.ImportClause) !== undefined ||
		ancestorOfKind(node, SyntaxKind.NamespaceImport) !== undefined
	) {
		return "import";
	}

	if (isInTypePosition(node)) {
		return "type-ref";
	}

	if (isCallTarget(node)) {
		return "call";
	}

	if (isWriteTarget(node)) {
		return "write";
	}

	return "read";
}

function isCallTarget(node: Node): boolean {
	let target = node;
	let parent = node.parent;

	// For a qualified call `A.b()`, the node is the property-access name; step up to
	// the property-access so the call/new check below sees it as the call expression.
	if (isPropertyAccessExpression(parent) && parent.name === node) {
		target = parent;
		parent = parent.parent;
	}

	return (isCallExpression(parent) || isNewExpression(parent)) && parent.expression === target;
}

function isInTypePosition(node: Node): boolean {
	return ancestorOfKind(node, SyntaxKind.TypeReference) !== undefined || ancestorOfKind(node, SyntaxKind.TypeQuery) !== undefined;
}

function isWriteTarget(node: Node): boolean {
	const parent = node.parent;

	return isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === SyntaxKind.EqualsToken;
}
