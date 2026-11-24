/**
 * Call-hierarchy traversal — incoming callers or outgoing callees of a symbol, walked to a
 * bounded depth. Deterministic: compiler references for callers, resolved call signatures
 * for callees.
 */
import type { Node } from "typescript/ast";
import {
	SyntaxKind,
	isArrowFunction,
	isNewExpression,
	isCallExpression,
	isClassDeclaration,
	isMethodDeclaration,
	isPropertyAssignment,
	isFunctionExpression,
	isPropertyDeclaration,
	isFunctionDeclaration,
	isVariableDeclaration
} from "typescript/ast";

import { position } from "./resolve.js";
import type { CallNode } from "./types.js";
import { declName, fileNameOf, firstAncestor, forEachDescendant } from "./nodes.js";

/** What the walk needs from the compiler: uses of a declaration, targets of a call. */
export interface CallResolver {
	/** Reference nodes that use a declaration (declaration sites excluded). */
	usesOf(decl: Node): Node[];
	/** Declarations a call/new expression resolves to (unfiltered). */
	targetsOf(call: Node): Node[];
}

/** What the walk reports against: the base dir for relative positions and the compiler resolver. */
export interface CallContext {
	baseDir: string;
	resolver: CallResolver;
}

/** Whether a node can carry the name of a function value (`const f = () => {}`, `{ f: () => {} }`). */
function isNameHolder(node: Node): boolean {
	return isVariableDeclaration(node) || isPropertyDeclaration(node) || isPropertyAssignment(node) || node.kind === SyntaxKind.PropertySignature;
}

/** The nearest enclosing function-like declaration of a node (named where possible). */
function enclosingNamed(node: Node): Node | undefined {
	return firstAncestor(node, (a) => isFunctionDeclaration(a) || isMethodDeclaration(a) || isArrowFunction(a) || isFunctionExpression(a));
}

/**
 * The declaration to report for an enclosing function: arrow / function-expression bound to a
 * name reports the name-bearing declaration (variable, class property, or object-literal
 * property), not the function expression itself — otherwise the caller reads "(anonymous)" (#118).
 */
function reportable(fn: Node): Node {
	if ((isArrowFunction(fn) || isFunctionExpression(fn)) && isNameHolder(fn.parent)) {
		return fn.parent;
	}

	return fn;
}

/** A name for a node used in the hierarchy (the declaration's name, best effort). */
function nodeName(node: Node): string {
	return declName(node) ?? "(anonymous)";
}

function toNode(decl: Node, baseDir: string): CallNode {
	const pos = position(decl, baseDir);

	return { calls: [], position: pos, qualifiedName: `${pos.file}:${nodeName(decl)}` };
}

/** Functions that call `decl` (one level), as their enclosing named declarations. */
function callersOf(decl: Node, resolver: CallResolver): Node[] {
	const declKey = identityKey(decl);
	const callers: Node[] = [];

	for (const ref of resolver.usesOf(decl)) {
		const enclosing = enclosingNamed(ref);

		if (enclosing === undefined) {
			continue;
		}

		const caller = reportable(enclosing);

		if (identityKey(caller) !== declKey) {
			callers.push(caller);
		}
	}

	return callers;
}

/**
 * A declaration that lives in `node_modules` or a TypeScript `lib.*.d.ts` — i.e. a
 * built-in (`String`, `Error`, `Array`, …) or third-party intrinsic, not the user's
 * code. These are noise as call-hierarchy edges and are filtered out.
 */
function isExternalDeclaration(decl: Node): boolean {
	const path = fileNameOf(decl);

	return path.includes("/node_modules/") || /\/lib\.[^/]*\.d\.ts$/.test(path);
}

/** Map a resolved call target to the declaration the hierarchy reports, if it is reportable. */
function calleeDeclaration(target: Node): Node | undefined {
	if (target.kind === SyntaxKind.Constructor) {
		return isClassDeclaration(target.parent) ? target.parent : undefined;
	}

	if (isArrowFunction(target) || isFunctionExpression(target) || target.kind === SyntaxKind.FunctionType) {
		return isNameHolder(target.parent) ? target.parent : undefined;
	}

	const reportableKinds = [
		SyntaxKind.FunctionDeclaration,
		SyntaxKind.MethodDeclaration,
		SyntaxKind.MethodSignature,
		SyntaxKind.GetAccessor,
		SyntaxKind.SetAccessor,
		SyntaxKind.ClassDeclaration,
		SyntaxKind.VariableDeclaration,
		SyntaxKind.PropertyDeclaration,
		SyntaxKind.PropertyAssignment,
		SyntaxKind.PropertySignature
	];

	return reportableKinds.includes(target.kind) ? target : undefined;
}

/** Declarations that `decl` calls (one level), resolved from its body's call expressions. */
function calleesOf(decl: Node, resolver: CallResolver): Node[] {
	const callees: Node[] = [];

	forEachDescendant(decl, (node) => {
		if (!isCallExpression(node) && !isNewExpression(node)) {
			return;
		}

		for (const target of resolver.targetsOf(node)) {
			const callee = isExternalDeclaration(target) ? undefined : calleeDeclaration(target);

			if (callee !== undefined) {
				callees.push(callee);
			}
		}
	});

	return callees;
}

/** Stable identity for the cycle guard: source position, not the node object. */
function identityKey(node: Node): string {
	return `${fileNameOf(node)}:${node.getStart()}`;
}

export function buildCallHierarchy(decl: Node, options: { depth: number; direction: "incoming" | "outgoing" }, context: CallContext): CallNode[] {
	const { depth, direction } = options;
	const { baseDir, resolver } = context;
	const seen = new Set<string>();

	const walk = (current: Node, remaining: number): CallNode[] => {
		if (remaining <= 0) {
			return [];
		}

		const next = direction === "incoming" ? callersOf(current, resolver) : calleesOf(current, resolver);
		const result: CallNode[] = [];

		for (const node of next) {
			const key = identityKey(node);

			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			const callNode = toNode(node, baseDir);
			callNode.calls = walk(node, remaining - 1);
			result.push(callNode);
		}

		return result;
	};

	return walk(decl, depth);
}
