/**
 * Symbol resolution — qualified-name parsing and name-based declaration lookup.
 *
 * Grammar: `relPath:name` where `name` is a `::`-separated path into nested
 * namespaces (`Model::Inner::Node`), with an optional `#index` to disambiguate.
 * A bare last segment (`Node`) matches a declaration at any namespace depth and
 * returns each match tagged with its full dotted path.
 * See docs/DESIGN.md open-Q (symbol resolution).
 */
import type { Node, Statement, SourceFile } from "typescript/ast";
import {
	isBlock,
	isModuleBlock,
	isArrowFunction,
	isEnumDeclaration,
	isClassDeclaration,
	isModuleDeclaration,
	isMethodDeclaration,
	isVariableStatement,
	isPropertyAssignment,
	isFunctionExpression,
	isFunctionDeclaration,
	isVariableDeclaration,
	isInterfaceDeclaration,
	isTypeAliasDeclaration,
	isObjectLiteralExpression,
	isImportEqualsDeclaration
} from "typescript/ast";

import type { SymbolHandle } from "./types.js";
import { declName, position, toRelative, forEachDescendant } from "./nodes.js";

export { toRelative, position };

export interface ParsedName {
	file: string;
	/** Zero-based index into same-name declarations, when disambiguated (`name#1`). */
	index?: number;
	/** Dot-separated segments of the symbol path, e.g. ["Model", "Node"]. */
	segments: string[];
}

/** A declaration with its full dotted path within the file. */
export interface NamedDeclaration {
	node: Node;
	/** Dotted name, e.g. "Model.Inner.Node". */
	path: string;
}

/**
 * The namespace/member separator in a qualified name's `name` part: `Model::Inner::Node`.
 * `::` cannot appear unquoted in a TS identifier or module specifier, so a quoted module
 * name (`"@scope.org/pkg.sub"`) keeps its dots intact instead of being split.
 */
export const NS_SEP = "::";

/**
 * Self-help appended to every qualified-name parse error so an agent that passes bad
 * syntax learns the grammar from the error itself, without consulting docs.
 */
const SYNTAX_HINT =
	'syntax: "relativePath:Name", nested with "::" (e.g. "src/a.ts:Outer::Inner", ' +
	'"src/a.ts:MyClass::method"), optional "#n" to disambiguate same-named symbols';

/** A malformed qualified name; the message ends with the grammar so the error teaches the syntax. */
export class InvalidQualifiedNameError extends Error {
	public constructor(detail: string) {
		super(`${detail}\n${SYNTAX_HINT}`);
		this.name = "InvalidQualifiedNameError";
	}
}

/** Join name segments with the namespace separator. */
export function joinSegments(segments: string[]): string {
	return segments.join(NS_SEP);
}

/** Split a name into its segments on the namespace separator. */
export function splitName(name: string): string[] {
	return name.split(NS_SEP);
}

/**
 * Split `file:name` at the first `:`. The file part is a relative, forward-slashed path
 * with no colon by contract, so the first colon is unambiguously the boundary; the name
 * part keeps any `::` segment separators that follow.
 */
function splitFileAndName(qualifiedName: string): { file: string; name: string } {
	const sep = qualifiedName.indexOf(":");

	if (sep === -1) {
		throw new InvalidQualifiedNameError(`invalid qualified name (expected file:name): ${qualifiedName}`);
	}

	return { file: qualifiedName.slice(0, sep), name: qualifiedName.slice(sep + 1) };
}

/** Parse `relPath:name`, `relPath:a::b::name`, or any of those with a trailing `#index`. */
export function parseQualifiedName(qualifiedName: string): ParsedName {
	const { file, name } = splitFileAndName(qualifiedName);

	if (file === "") {
		throw new InvalidQualifiedNameError(`invalid qualified name (empty file part): ${qualifiedName}`);
	}

	let rest = name;
	let index: number | undefined;

	const hash = rest.lastIndexOf("#");

	if (hash !== -1) {
		const parsed = Number(rest.slice(hash + 1));

		if (!Number.isInteger(parsed) || parsed < 0) {
			throw new InvalidQualifiedNameError(`invalid index in qualified name: ${qualifiedName}`);
		}

		index = parsed;
		rest = rest.slice(0, hash);
	}

	if (rest === "") {
		throw new InvalidQualifiedNameError(`invalid qualified name (empty name part): ${qualifiedName}`);
	}

	const segments = splitName(rest);

	if (segments.some((s) => s === "")) {
		throw new InvalidQualifiedNameError(`invalid qualified name (empty segment): ${qualifiedName}`);
	}

	return { file, index, segments };
}

/** Whether a statement introduces an addressable name (class, function, namespace, ...). */
function isNamedStatement(stmt: Node): boolean {
	return (
		isClassDeclaration(stmt) ||
		isFunctionDeclaration(stmt) ||
		isInterfaceDeclaration(stmt) ||
		isTypeAliasDeclaration(stmt) ||
		isEnumDeclaration(stmt) ||
		isModuleDeclaration(stmt) ||
		isImportEqualsDeclaration(stmt)
	);
}

/** Named declarations directly under a node (top-level statements or namespace body). */
function childDeclarations(statements: readonly Statement[]): NamedDeclaration[] {
	const decls: NamedDeclaration[] = [];

	for (const stmt of statements) {
		if (isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				// Destructuring patterns (`const { a, b } = ...`) have no addressable name.
				const name = declName(decl);

				if (name !== undefined) {
					decls.push({ node: decl, path: name });
				}
			}
		} else if (isNamedStatement(stmt)) {
			const name = declName(stmt);

			if (name !== undefined) {
				decls.push({ node: stmt, path: name });
			}
		}
	}

	return decls;
}

/** The function body block of a function/method/arrow-valued const, if it has a block body. */
function functionBlock(node: Node): Node | undefined {
	if (isFunctionDeclaration(node) || isMethodDeclaration(node)) {
		return node.body;
	}

	if (isVariableDeclaration(node)) {
		const init = node.initializer;

		return init !== undefined && (isArrowFunction(init) || isFunctionExpression(init)) ? init.body : undefined;
	}

	return undefined;
}

/** Statements inside a namespace, function, method, or arrow/fn-expr body, if any. */
function bodyStatements(node: Node): readonly Statement[] {
	if (isModuleDeclaration(node)) {
		return node.body !== undefined && isModuleBlock(node.body) ? node.body.statements : [];
	}

	// Nested declarations inside a function/method body (e.g. a factory's inner functions).
	const body = functionBlock(node);

	return body !== undefined && isBlock(body) ? body.statements : [];
}

/** Named members of a class or interface declaration, as child declarations. */
function memberDeclarations(node: Node): NamedDeclaration[] {
	if (!isClassDeclaration(node) && !isInterfaceDeclaration(node)) {
		return [];
	}

	const members: NamedDeclaration[] = [];

	for (const member of node.members) {
		const name = declName(member);

		if (name !== undefined) {
			members.push({ path: name, node: member });
		}
	}

	return members;
}

/**
 * Function/arrow-valued properties of object literals inside a declaration's body
 * (e.g. a factory `return { mean: () => ... }`). Lets object-literal selectors be
 * addressed and traced. Scoped to function/arrow-valued properties only.
 */
function objectLiteralFunctionProps(node: Node): NamedDeclaration[] {
	const props: NamedDeclaration[] = [];

	forEachDescendant(node, (descendant) => {
		// Shorthand method in an object literal: `{ greet(name) { ... } }`.
		if (isMethodDeclaration(descendant) && isObjectLiteralExpression(descendant.parent)) {
			const name = declName(descendant);

			if (name !== undefined && name !== "") {
				props.push({ path: name, node: descendant });
			}

			return;
		}

		if (!isPropertyAssignment(descendant)) {
			return;
		}

		const init = descendant.initializer;

		if (isArrowFunction(init) || isFunctionExpression(init)) {
			const name = declName(descendant);

			if (name !== undefined && name !== "") {
				props.push({ path: name, node: descendant });
			}
		}
	});

	return props;
}

/** All named declarations in a file, recursing into namespaces + class/interface members. */
export function allDeclarations(sourceFile: SourceFile): NamedDeclaration[] {
	const result: NamedDeclaration[] = [];

	const descend = (node: Node, fullPath: string): void => {
		for (const { path, node: child } of [...childDeclarations(bodyStatements(node)), ...memberDeclarations(node)]) {
			const childPath = joinSegments([fullPath, path]);
			result.push({ node: child, path: childPath });
			descend(child, childPath);
		}

		// Object-literal selector/handler properties (e.g. factory `return { mean: () => ... }`).
		for (const { path, node: prop } of objectLiteralFunctionProps(node)) {
			result.push({ node: prop, path: joinSegments([fullPath, path]) });
		}
	};

	for (const { node, path } of childDeclarations(sourceFile.statements)) {
		result.push({ node, path });
		descend(node, path);
	}

	return result;
}

/** Statements inside a namespace/module body only (not function/method bodies). */
function namespaceBodyStatements(node: Node): readonly Statement[] {
	if (!isModuleDeclaration(node)) {
		return [];
	}

	return node.body !== undefined && isModuleBlock(node.body) ? node.body.statements : [];
}

/**
 * Declarations for a file *outline*: top-level + namespace recursion + class/interface
 * members. Unlike allDeclarations it does NOT descend into function bodies or object
 * literals — an outline is structure, not local variables.
 */
export function outlineDeclarations(sourceFile: SourceFile): NamedDeclaration[] {
	const result: NamedDeclaration[] = [];

	const descend = (node: Node, fullPath: string): void => {
		for (const { path, node: child } of [...childDeclarations(namespaceBodyStatements(node)), ...memberDeclarations(node)]) {
			const childPath = joinSegments([fullPath, path]);
			result.push({ node: child, path: childPath });
			descend(child, childPath);
		}
	};

	for (const { node, path } of childDeclarations(sourceFile.statements)) {
		result.push({ node, path });
		descend(node, path);
	}

	return result;
}

/**
 * Find declarations matching a name path. A multi-segment path matches by exact
 * `::` path; a single segment matches the last path component at any depth.
 */
export function findNamedDeclarations(sourceFile: SourceFile, segments: string[]): NamedDeclaration[] {
	const all = allDeclarations(sourceFile);

	if (segments.length > 1) {
		const target = joinSegments(segments);

		return all.filter((d) => d.path === target);
	}

	const name = segments[0];

	return all.filter((d) => {
		const parts = splitName(d.path);

		return parts[parts.length - 1] === name;
	});
}

/** Levenshtein edit distance between two strings. */
function editDistance(a: string, b: string): number {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);

	for (let j = 1; j <= b.length; j++) {
		rows[0]![j] = j;
	}

	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
		}
	}

	return rows[a.length]![b.length]!;
}

/** Nearest declaration names in a file to a (mistyped) target — for not-found suggestions. */
export function nearestNames(sourceFile: SourceFile, target: string, limit = 3): string[] {
	const names = [
		...new Set(
			allDeclarations(sourceFile).map((d) => {
				const parts = splitName(d.path);

				return parts[parts.length - 1]!;
			})
		)
	];
	const threshold = Math.max(2, Math.ceil(target.length / 3));

	return names
		.map((name) => ({ name, dist: editDistance(name.toLowerCase(), target.toLowerCase()) }))
		.filter((c) => c.dist > 0 && c.dist <= threshold)
		.sort((a, b) => a.dist - b.dist)
		.slice(0, limit)
		.map((c) => c.name);
}

/** Build a SymbolHandle for a declaration, optionally with a disambiguation index. */
export function declarationToHandle(decl: NamedDeclaration, file: string, baseDir: string, index?: number): SymbolHandle {
	const qualifiedName = index === undefined ? `${file}:${decl.path}` : `${file}:${decl.path}#${index}`;

	return { qualifiedName, position: position(decl.node, baseDir) };
}
