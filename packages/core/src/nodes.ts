/**
 * Small helpers over the TypeScript 7 AST (`typescript/ast`): declaration names, kind names,
 * 1-based positions and tree walks. Pure functions of a node — no checker or project needed.
 */
import type { Node, SyntaxKind, SourceFile } from "typescript/ast";
import { isIdentifier, formatSyntaxKind, isVariableDeclaration } from "typescript/ast";

import type { Position } from "./types.js";

/** Forward-slash a path (Windows file names may carry backslashes). */
export function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Make an absolute file path relative to a base dir, normalized to forward slashes. */
export function toRelative(absPath: string, baseDir: string): string {
	const normalized = normalizeSlashes(absPath);
	const base = normalizeSlashes(baseDir);

	return normalized.startsWith(base) ? normalized.slice(base.length).replace(/^\//, "") : normalized;
}

/** The SyntaxKind name of a node (`ClassDeclaration`, `VariableStatement`, ...). */
export function kindName(node: Node): string {
	return formatSyntaxKind(node.kind);
}

/** Real file name of the source file a node lives in, forward-slashed. */
export function fileNameOf(node: Node): string {
	return normalizeSlashes(node.getSourceFile().fileName);
}

/** 1-based line/col of an offset in a source file. */
export function lineAndCol(sourceFile: SourceFile, offset: number): { col: number; line: number } {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);

	return { line: line + 1, col: character + 1 };
}

/** Where a node starts (leading trivia and JSDoc excluded), as a symantic Position. */
export function position(node: Node, baseDir: string): Position {
	const sourceFile = node.getSourceFile();

	return { file: toRelative(sourceFile.fileName, baseDir), ...lineAndCol(sourceFile, node.getStart()) };
}

/** Call `visit` for every descendant of `node`, depth-first, in source order. */
export function forEachDescendant(node: Node, visit: (descendant: Node) => void): void {
	node.forEachChild((child) => {
		visit(child);
		forEachDescendant(child, visit);
	});
}

/** The direct children of a node, in source order. */
export function childrenOf(node: Node): Node[] {
	const children: Node[] = [];
	node.forEachChild((child) => {
		children.push(child);
	});

	return children;
}

/** Nearest ancestor (excluding the node itself) matching `test`. */
export function firstAncestor<T extends Node>(node: Node, test: (candidate: Node) => candidate is T): T | undefined;
export function firstAncestor(node: Node, test: (candidate: Node) => boolean): Node | undefined;
export function firstAncestor(node: Node, test: (candidate: Node) => boolean): Node | undefined {
	for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
		if (test(current)) {
			return current;
		}
	}

	return undefined;
}

/** Nearest ancestor of the given kind. */
export function ancestorOfKind(node: Node, kind: SyntaxKind): Node | undefined {
	return firstAncestor(node, (candidate) => candidate.kind === kind);
}

/** A declaration's name node, for the kinds that carry one. */
export function nameNodeOf(node: Node): Node | undefined {
	return (node as { name?: Node }).name;
}

/**
 * The addressable name of a declaration: identifier text, or the quoted text of a string-named
 * ambient module. Undefined for anonymous declarations and for destructuring patterns.
 */
export function declName(node: Node): string | undefined {
	const name = nameNodeOf(node);

	if (name === undefined) {
		return undefined;
	}

	if (isVariableDeclaration(node) && !isIdentifier(name)) {
		return undefined;
	}

	return isIdentifier(name) ? name.text : name.getText();
}

/** Stable identity of a node across handle resolutions: file + start offset + kind. */
export function nodeKey(node: Node): string {
	return `${fileNameOf(node)}:${node.getStart()}:${node.kind}`;
}
