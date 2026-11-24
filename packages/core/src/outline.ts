/**
 * Deterministic structural outline of a file. AST walk, no LLM.
 * See docs/VISION.md (outline ops), docs/DESIGN.md Section 2.
 */
import type { Node, SourceFile } from "typescript/ast";
import {
	isBlock,
	SyntaxKind,
	isStatement,
	ModifierFlags,
	isModuleBlock,
	isNamedExports,
	isArrowFunction,
	isStringLiteral,
	isClassDeclaration,
	isModuleDeclaration,
	isMethodDeclaration,
	isExportDeclaration,
	isVariableStatement,
	isPropertyAssignment,
	isFunctionExpression,
	isFunctionDeclaration,
	isVariableDeclaration,
	isTypeAliasDeclaration,
	isInterfaceDeclaration,
	isObjectLiteralExpression
} from "typescript/ast";

import { RELEASE_TAGS } from "./types.js";
import { declName, kindName, childrenOf } from "./nodes.js";
import type { Member, FileOutline, StatementNode } from "./types.js";
import { position, joinSegments, outlineDeclarations } from "./resolve.js";

/** The declaration head up to its body — single line, whitespace-collapsed. */
export function signatureOfSource(source: string): string {
	const brace = source.indexOf("{");
	const head = brace === -1 ? source : source.slice(0, brace);

	return head.trim().replace(/\s+/g, " ");
}

function typeParametersOf(node: Node): string[] | undefined {
	const holder = isVariableDeclaration(node) ? node.initializer : node;

	if (
		holder === undefined ||
		!(isClassDeclaration(holder) || isInterfaceDeclaration(holder) || isTypeAliasDeclaration(holder) || isFunctionDeclaration(holder))
	) {
		return undefined;
	}

	const params = (holder.typeParameters ?? []).map((p) => p.name.text);

	return params.length > 0 ? params : undefined;
}

/** Modifier flags carried by the node itself (variable declarations carry none). */
function flagsOf(node: Node): ModifierFlags {
	return (node as { modifierFlags?: ModifierFlags }).modifierFlags ?? ModifierFlags.None;
}

/**
 * Declaration modifiers present on a node, lower-cased: `abstract`, `static`, `readonly`,
 * `async`, `optional`, `default`. `export` is tracked separately (Member.exported).
 */
function modifiersOf(node: Node): string[] {
	const flags = flagsOf(node);
	const optional = (node as { postfixToken?: Node }).postfixToken?.kind === SyntaxKind.QuestionToken;
	const candidates: [boolean, string][] = [
		[(flags & ModifierFlags.Abstract) !== 0, "abstract"],
		[(flags & ModifierFlags.Static) !== 0, "static"],
		[(flags & ModifierFlags.Readonly) !== 0, "readonly"],
		[(flags & ModifierFlags.Async) !== 0, "async"],
		[optional, "optional"],
		[(flags & ModifierFlags.Default) !== 0, "default"]
	];

	return candidates.filter(([present]) => present).map(([, label]) => label);
}

/** JSDoc release tags on a node, in RELEASE_TAGS display order. */
export function tagsOf(node: Node): string[] {
	// A `const`/`let` declaration carries its JSDoc on the enclosing VariableStatement, not
	// the VariableDeclaration the outline walk hands us.
	const docHost = isVariableDeclaration(node) && node.parent.parent.kind === SyntaxKind.VariableStatement ? node.parent.parent : node;
	const present = new Set((docHost.jsDoc ?? []).flatMap((doc) => (doc.tags ?? []).map((tag) => tag.tagName.text.toLowerCase())));

	return RELEASE_TAGS.filter((t) => present.has(t));
}

function toMember(node: Node, name: string, baseDir: string): Member {
	const typeParameters = typeParametersOf(node);
	const modifiers = modifiersOf(node);
	const tags = tagsOf(node);

	return {
		name,
		kind: kindName(node),
		position: position(node, baseDir),
		signature: signatureOfSource(node.getText()),
		...(modifiers.length > 0 ? { modifiers } : {}),
		...(tags.length > 0 ? { tags } : {}),
		...(typeParameters !== undefined ? { typeParameters } : {})
	};
}

/** Direct child statements of a statement (into its block/body), one level down. */
function childStatements(node: Node): Node[] {
	return childrenOf(node).flatMap((child) => {
		if (isBlock(child)) {
			return [...child.statements];
		}

		return isStatement(child) ? [child] : [];
	});
}

/** The declared name a statement introduces, when it has one (fn/class decl, named var statement). */
function statementLabel(stmt: Node): string | undefined {
	if (isFunctionDeclaration(stmt) || isClassDeclaration(stmt)) {
		return stmt.name?.text;
	}

	if (isVariableStatement(stmt)) {
		const names = stmt.declarationList.declarations.map((d) => d.name.getText());

		return names.length > 0 ? names.join(", ") : undefined;
	}

	return undefined;
}

function buildStatementNode(stmt: Node, depth: number, baseDir: string): StatementNode {
	const node: StatementNode = { kind: kindName(stmt), position: position(stmt, baseDir) };
	const label = statementLabel(stmt);

	if (label !== undefined) {
		node.label = label;
	}

	if (depth > 1) {
		const children = childStatements(stmt).map((child) => buildStatementNode(child, depth - 1, baseDir));

		if (children.length > 0) {
			node.children = children;
		}
	}

	return node;
}

/** Find the body block of a function-like declaration, including arrow/fn-expr consts. */
function functionBody(decl: Node): Node | undefined {
	const direct = childrenOf(decl).find((c) => isBlock(c));

	if (direct !== undefined) {
		return direct;
	}

	// Arrow / function-expression assigned to a const: descend to the initializer's block.
	if (isVariableDeclaration(decl)) {
		const init = decl.initializer;

		if (init !== undefined && (isArrowFunction(init) || isFunctionExpression(init))) {
			return isBlock(init.body) ? init.body : undefined;
		}
	}

	return undefined;
}

/** Deterministic statement-level skeleton of a function body. */
export function buildFunctionOutline(decl: Node, depth: number, baseDir: string): StatementNode[] {
	const body = functionBody(decl);

	if (body === undefined || !isBlock(body)) {
		return [];
	}

	return body.statements.map((stmt) => buildStatementNode(stmt, depth, baseDir));
}

/** The name a namespace-body statement is addressed by (single-declaration variables included). */
function namespaceMemberName(stmt: Node): string | undefined {
	if (isVariableStatement(stmt)) {
		const [first, ...rest] = stmt.declarationList.declarations;

		return rest.length === 0 && first !== undefined ? declName(first) : undefined;
	}

	return declName(stmt);
}

/** Members of a class / interface / namespace declaration. `ownerQualifiedName` (file:Owner)
 * prefixes each member's addressable qualifiedName. */
export function buildSymbolOutline(decl: Node, baseDir: string, ownerQualifiedName?: string): Member[] {
	const withQName = (member: Member, name: string): Member =>
		ownerQualifiedName === undefined ? member : { ...member, qualifiedName: joinSegments([ownerQualifiedName, name]) };

	if (isModuleDeclaration(decl)) {
		const statements = decl.body !== undefined && isModuleBlock(decl.body) ? decl.body.statements : [];

		return statements.flatMap((stmt) => {
			const name = namespaceMemberName(stmt);

			return name === undefined ? [] : [withQName(toMember(stmt, name, baseDir), name)];
		});
	}

	// An object-literal const (`const x = { foo() {}, bar: () => {} }`) — enumerate its
	// function-valued properties, mirroring what they're addressable as via `::` (#95).
	if (isVariableDeclaration(decl)) {
		const init = decl.initializer;

		if (init === undefined || !isObjectLiteralExpression(init)) {
			return [];
		}

		return init.properties.flatMap((prop) => {
			const isFunctionValued =
				isMethodDeclaration(prop) || (isPropertyAssignment(prop) && (isArrowFunction(prop.initializer) || isFunctionExpression(prop.initializer)));
			const name = isFunctionValued ? declName(prop) : undefined;

			return name === undefined || name === "" ? [] : [withQName(toMember(prop, name, baseDir), name)];
		});
	}

	if (!isClassDeclaration(decl) && !isInterfaceDeclaration(decl)) {
		return [];
	}

	return decl.members.map((member) => {
		const name = declName(member) ?? kindName(member);

		return withQName(toMember(member, name, baseDir), name);
	});
}

/** Local names a file exports through `export { a, b as c }` / `export default a` (no `from`). */
function locallyExportedNames(sourceFile: SourceFile): Set<string> {
	const names = new Set<string>();

	for (const stmt of sourceFile.statements) {
		if (isExportDeclaration(stmt) && stmt.moduleSpecifier === undefined && stmt.exportClause !== undefined && isNamedExports(stmt.exportClause)) {
			for (const spec of stmt.exportClause.elements) {
				names.add((spec.propertyName ?? spec.name).getText());
			}
		}
	}

	return names;
}

function isExportedDeclaration(node: Node, localExports: Set<string>): boolean {
	const holder = isVariableDeclaration(node) ? node.parent.parent : node;

	if ((flagsOf(holder) & ModifierFlags.Export) !== 0) {
		return true;
	}

	const name = declName(node);

	return holder.parent.kind === SyntaxKind.SourceFile && name !== undefined && localExports.has(name);
}

export function buildFileOutline(sourceFile: SourceFile, baseDir: string): FileOutline {
	const outline: FileOutline = { others: [], exports: [], classes: [], functions: [], variables: [], interfaces: [] };
	const localExports = locallyExportedNames(sourceFile);

	// outlineDeclarations = top-level + namespaces + type members (no function-body locals).
	for (const { node, path } of outlineDeclarations(sourceFile)) {
		const exported = isExportedDeclaration(node, localExports);
		const base = toMember(node, path, baseDir);
		const member: Member = { ...base, exported, qualifiedName: `${base.position.file}:${path}` };

		if (isClassDeclaration(node)) {
			outline.classes.push(member);
		} else if (isInterfaceDeclaration(node)) {
			outline.interfaces.push(member);
		} else if (isFunctionDeclaration(node)) {
			outline.functions.push(member);
		} else if (isVariableDeclaration(node)) {
			// A const assigned a function/arrow reads as a function; everything else is a value.
			const init = node.initializer;
			const isFn = init !== undefined && (isArrowFunction(init) || isFunctionExpression(init));
			(isFn ? outline.functions : outline.variables).push(member);
		} else {
			// Namespaces, enums, type aliases, and type members — still carry export/modifier flags.
			outline.others.push(member);
		}

		if (exported) {
			outline.exports.push(member);
		}
	}

	// Re-exports: `export { X } from "..."`, `export type { X } from`, `export * from`.
	for (const exportDecl of sourceFile.statements) {
		if (!isExportDeclaration(exportDecl) || exportDecl.moduleSpecifier === undefined || !isStringLiteral(exportDecl.moduleSpecifier)) {
			continue;
		}

		const fromModule = exportDecl.moduleSpecifier.text;
		const named = exportDecl.exportClause !== undefined && isNamedExports(exportDecl.exportClause) ? exportDecl.exportClause.elements : [];

		if (named.length === 0) {
			outline.exports.push({
				kind: "ExportDeclaration",
				name: `* from ${fromModule}`,
				position: position(exportDecl, baseDir),
				signature: exportDecl.getText().replace(/\s+/g, " ")
			});
			continue;
		}

		for (const spec of named) {
			const typeOnly = exportDecl.isTypeOnly || spec.isTypeOnly;

			outline.exports.push({
				name: spec.name.getText(),
				position: position(spec, baseDir),
				kind: typeOnly ? "ExportSpecifier (type)" : "ExportSpecifier",
				signature: `export { ${spec.getText()} } from "${fromModule}"`
			});
		}
	}

	return outline;
}
