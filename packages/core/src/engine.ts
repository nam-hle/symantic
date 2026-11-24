/**
 * symantic core engine, built on the TypeScript 7 JS API (`typescript/sync`): one `tsc --api`
 * child process holds the warm project, the checker and the language service. Resolves symbols and
 * answers read-only queries; transport-agnostic — knows nothing about MCP/CLI.
 * See docs/DESIGN.md Section 1 (architecture) + Section 2 (API).
 */
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { API, SymbolFlags } from "typescript/sync";
import type { Node, SourceFile } from "typescript/ast";
import type { Project, Snapshot, Symbol as CompilerSymbol } from "typescript/sync";
import {
	SyntaxKind,
	isStatement,
	isIdentifier,
	isAsExpression,
	isNamedImports,
	isQualifiedName,
	isHeritageClause,
	isNamespaceImport,
	isClassDeclaration,
	isTypeReferenceNode,
	isImportDeclaration,
	isSatisfiesExpression,
	isFunctionDeclaration,
	isVariableDeclaration,
	isInterfaceDeclaration,
	isParenthesizedExpression,
	isObjectLiteralExpression,
	isPropertyAccessExpression,
	isExpressionWithTypeArguments
} from "typescript/ast";

import { shortKind } from "./render.js";
import { isTestFile } from "./test-file.js";
import { withTagComment } from "./types.js";
import { readRegionFrom } from "./region.js";
import { parsePageCursor } from "./cursor.js";
import { classifyReference } from "./usages.js";
import type { NamedDeclaration } from "./resolve.js";
import type { SymbolEngine } from "./symbol-engine.js";
import type { CallResolver } from "./call-hierarchy.js";
import { buildCallHierarchy } from "./call-hierarchy.js";
import { tagsOf, buildFileOutline, signatureOfSource, buildSymbolOutline, buildFunctionOutline } from "./outline.js";
import { nodeKey, kindName, position, declName, lineAndCol, nameNodeOf, firstAncestor, normalizeSlashes, forEachDescendant } from "./nodes.js";
import {
	NS_SEP,
	splitName,
	toRelative,
	joinSegments,
	nearestNames,
	allDeclarations,
	parseQualifiedName,
	declarationToHandle,
	findNamedDeclarations
} from "./resolve.js";
import type {
	Member,
	CallNode,
	Candidate,
	Reference,
	ImportInfo,
	FileOutline,
	ContextLevel,
	SymbolHandle,
	UsagesResult,
	SourceResult,
	RegionResult,
	ResolveResult,
	SearchOptions,
	ReferenceKind,
	StatementNode,
	SymbolContext,
	UsageReportEntry,
	FindUsagesOptions,
	UsageReportOptions,
	CallHierarchyOptions,
	OutlineFunctionOptions
} from "./types.js";

export interface EngineOptions {
	/** Path to a tsconfig.json. */
	tsConfigPath: string;
}

/** The warm compiler session: API process, current snapshot and the project inside it. */
interface Session {
	api: API;
	project: Project;
	snapshot: Snapshot;
	/** Project source files on disk (library and node_modules files excluded), with change stamps. */
	stamps: Map<string, string>;
}

/** Declaration kinds whose name token is the declaration itself rather than a use of it. */
const DECLARATION_KINDS = new Set<SyntaxKind>([
	SyntaxKind.ClassDeclaration,
	SyntaxKind.FunctionDeclaration,
	SyntaxKind.InterfaceDeclaration,
	SyntaxKind.TypeAliasDeclaration,
	SyntaxKind.EnumDeclaration,
	SyntaxKind.EnumMember,
	SyntaxKind.ModuleDeclaration,
	SyntaxKind.VariableDeclaration,
	SyntaxKind.Parameter,
	SyntaxKind.MethodDeclaration,
	SyntaxKind.MethodSignature,
	SyntaxKind.PropertyDeclaration,
	SyntaxKind.PropertySignature,
	SyntaxKind.GetAccessor,
	SyntaxKind.SetAccessor,
	SyntaxKind.PropertyAssignment,
	SyntaxKind.TypeParameter,
	SyntaxKind.BindingElement
]);

/** Whether a project file name belongs to the user's code (not a library or a dependency). */
function isProjectFile(fileName: string): boolean {
	return !normalizeSlashes(fileName).includes("/node_modules/");
}

/** Text of the line a node starts on, trimmed. */
function lineTextAt(node: Node): string {
	const sourceFile = node.getSourceFile();
	const { line } = lineAndCol(sourceFile, node.getStart());

	return (sourceFile.text.split("\n")[line - 1] ?? "").trim();
}

/**
 * Surrounding source for a reference node at the requested detail level:
 * `none` → undefined; `snippet` → the node's own line, trimmed; `block` → the enclosing
 * statement's text (whitespace-collapsed), falling back to the snippet.
 */
function contextFor(node: Node, level: ContextLevel): string | undefined {
	if (level === "none") {
		return undefined;
	}

	const snippet = lineTextAt(node);

	if (level === "snippet") {
		return snippet;
	}

	const statement = firstAncestor(node, (a) => isStatement(a));

	return statement !== undefined ? statement.getText().replace(/\s+/g, " ") : snippet;
}

/** Nearest ancestor (incl. self) that is a named, addressable declaration. */
function namedAncestor(node: Node): Node | undefined {
	for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
		if (isVariableDeclaration(current) || isClassDeclaration(current) || isFunctionDeclaration(current) || isInterfaceDeclaration(current)) {
			return current;
		}
	}

	return undefined;
}

/** Strip parentheses, `as` and `satisfies` wrappers off an expression. */
function unwrapExpression(node: Node): Node {
	let current = node;

	while (isParenthesizedExpression(current) || isAsExpression(current) || isSatisfiesExpression(current)) {
		current = current.expression;
	}

	return current;
}

/** The type position a reference sits in, climbing out of `ns.Type` / `a.b.Type` names. */
function enclosingTypeReference(ref: Node): Node | undefined {
	let current = ref;

	while (isQualifiedName(current.parent) || isPropertyAccessExpression(current.parent)) {
		current = current.parent;
	}

	return isTypeReferenceNode(current.parent) ? current.parent : undefined;
}

/**
 * The declaration that implements/extends the symbol a reference points at, if the reference sits
 * in a heritage clause (`implements X`, `extends X`) or types an object literal (`const x: X = {}`).
 */
function implementorOf(ref: Node): Node | undefined {
	let expression = ref;

	while (isPropertyAccessExpression(expression.parent) && expression.parent.name === expression) {
		expression = expression.parent;
	}

	// `extends Base` heritage elements are expressions; `implements X` / `extends X` on interfaces
	// are type references.
	if (isExpressionWithTypeArguments(expression.parent) && isHeritageClause(expression.parent.parent)) {
		return namedAncestor(expression.parent.parent.parent);
	}

	const typeRef = enclosingTypeReference(ref);

	if (typeRef === undefined) {
		return undefined;
	}

	const holder = typeRef.parent;

	if (isHeritageClause(holder)) {
		return namedAncestor(holder.parent);
	}

	if (isVariableDeclaration(holder) && holder.type === typeRef && holder.initializer !== undefined) {
		return isObjectLiteralExpression(unwrapExpression(holder.initializer)) ? holder : undefined;
	}

	if ((isAsExpression(holder) || isSatisfiesExpression(holder)) && holder.type === typeRef && isObjectLiteralExpression(unwrapExpression(holder))) {
		return namedAncestor(holder);
	}

	return undefined;
}

/** `Outer::Inner::name` path of a declaration through its enclosing namespaces and types. */
function dottedPath(node: Node): string | undefined {
	const own = declName(node);

	if (own === undefined) {
		return undefined;
	}

	const outer: string[] = [];

	for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
		if (current.kind === SyntaxKind.ModuleDeclaration || isClassDeclaration(current) || isInterfaceDeclaration(current)) {
			const name = declName(current);

			if (name !== undefined) {
				outer.unshift(name);
			}
		}
	}

	return joinSegments([...outer, own]);
}

export class Engine implements SymbolEngine {
	#session: Session | undefined;
	readonly #tsConfigPath: string;
	readonly #baseDir: string;

	public constructor(options: EngineOptions) {
		this.#tsConfigPath = normalizeSlashes(resolvePath(options.tsConfigPath));
		this.#baseDir = this.#tsConfigPath.replace(/\/[^/]*$/, "");
	}

	/** Lazily spawn the compiler process and open the project on first use. */
	#warm(): Session {
		if (this.#session === undefined) {
			const api = new API({ cwd: this.#baseDir });

			try {
				this.#session = this.#openSession(api, api.createSnapshot({ openProjects: [this.#tsConfigPath] }));
			} catch (error) {
				api.close();
				throw error;
			}
		}

		return this.#session;
	}

	#openSession(api: API, snapshot: Snapshot): Session {
		const project = snapshot.getConfiguredProject(this.#tsConfigPath);

		if (project === undefined) {
			throw new Error(`could not load project: ${this.#tsConfigPath}`);
		}

		const stamps = new Map<string, string>();

		for (const fileName of project.program.getSourceFileNames()) {
			const stamp = stampOf(fileName);

			if (isProjectFile(fileName) && stamp !== undefined) {
				stamps.set(fileName, stamp);
			}
		}

		return { api, stamps, project, snapshot };
	}

	get #project(): Project {
		return this.#warm().project;
	}

	/** Release the compiler process. Safe to call twice; the engine re-warms on next use. */
	public dispose(): void {
		const session = this.#session;
		this.#session = undefined;

		if (session !== undefined) {
			session.snapshot.dispose();
			session.api.close();
		}
	}

	/** Re-read files changed out-of-band before answering. See DESIGN open-Q (staleness). */
	public refreshIfStale(): void {
		const session = this.#session;

		if (session === undefined) {
			return;
		}

		const changed: string[] = [];
		const deleted: string[] = [];

		for (const [fileName, stamp] of session.stamps) {
			const current = stampOf(fileName);

			if (current === undefined) {
				deleted.push(fileName);
			} else if (current !== stamp) {
				changed.push(fileName);
			}
		}

		if (changed.length === 0 && deleted.length === 0) {
			return;
		}

		// openProjects must be repeated: without it the update keeps the old program untouched.
		const next = session.snapshot.update({ openProjects: [this.#tsConfigPath], fileNotifications: { changed, deleted } });
		session.snapshot.dispose();
		this.#session = this.#openSession(session.api, next);
	}

	/** Number of project source files — 0 signals a non-loadable (base) tsconfig. */
	public sourceFileCount(): number {
		return this.#warm().stamps.size;
	}

	#getSourceFile(relPath: string): SourceFile | undefined {
		const { stamps, project } = this.#warm();
		const wanted = normalizeSlashes(relPath).replace(/^\.\//, "");

		for (const candidate of [resolvePath(this.#baseDir, relPath), resolvePath(relPath)]) {
			const found = project.program.getSourceFile(normalizeSlashes(candidate));

			if (found !== undefined) {
				return found;
			}
		}

		const match = [...stamps.keys()].find((f) => normalizeSlashes(f).endsWith(`/${wanted}`));

		return match === undefined ? undefined : project.program.getSourceFile(match);
	}

	/** Like #getSourceFile but throws a clear error when the file isn't in the project. */
	#requireSourceFile(relPath: string): SourceFile {
		const sourceFile = this.#getSourceFile(relPath);

		if (!sourceFile) {
			throw new Error(`file not found in project: ${relPath} (is it covered by the tsconfig, and is the path correct?)`);
		}

		return sourceFile;
	}

	/** Declaration nodes of a compiler symbol. */
	#nodesOf(symbol: CompilerSymbol): Node[] {
		const project = this.#project;

		return symbol.declarations.flatMap((handle) => {
			const node = handle.resolve(project);

			return node === undefined ? [] : [node];
		});
	}

	/** The declarations an import / re-export binding ends up at, following aliases. */
	#aliasTargets(symbol: CompilerSymbol | undefined): Node[] {
		if (symbol === undefined) {
			return [];
		}

		const { checker } = this.#project;
		const target = (symbol.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

		return checker.isUnknownSymbol(target) ? [] : this.#nodesOf(target);
	}

	/** The compiler symbol a file binds `name` to through an import or an export (barrel). */
	#boundSymbol(sourceFile: SourceFile, name: string): CompilerSymbol | undefined {
		const { checker } = this.#project;

		for (const stmt of sourceFile.statements) {
			if (!isImportDeclaration(stmt) || stmt.importClause === undefined) {
				continue;
			}

			const clause = stmt.importClause;
			const bindings = clause.namedBindings;
			const binders: Node[] = [
				...(clause.name !== undefined ? [clause.name] : []),
				...(bindings !== undefined && isNamespaceImport(bindings) ? [bindings.name] : []),
				...(bindings !== undefined && isNamedImports(bindings) ? bindings.elements.map((el) => el.name) : [])
			];
			const bound = binders.find((binder) => isIdentifier(binder) && binder.text === name);

			if (bound !== undefined) {
				return checker.getSymbolAtLocation(bound);
			}
		}

		const moduleSymbol = checker.getSymbolOfSourceFile(sourceFile.fileName);

		return moduleSymbol === undefined ? undefined : checker.getExportsOfModule(moduleSymbol).find((exported) => exported.name === name);
	}

	/**
	 * Declarations a path names in a file. A single segment not declared locally is followed through
	 * the file's imports and re-exports (`export { X } from`, `export *`) to its true declaration(s).
	 */
	#namedDeclarations(sourceFile: SourceFile, segments: string[]): NamedDeclaration[] {
		const local = findNamedDeclarations(sourceFile, segments);

		if (local.length > 0 || segments.length > 1) {
			return local;
		}

		const name = segments[0]!;

		return this.#aliasTargets(this.#boundSymbol(sourceFile, name))
			.filter((node) => declName(node) !== undefined)
			.map((node) => ({ node, path: name }));
	}

	/**
	 * qualified-name -> symbol | candidates. `relPath:name`, where name is a `::` path
	 * into nested namespaces (`Model::Inner::Node`); a bare segment matches at any
	 * depth. Ambiguous -> candidates (caller disambiguates by `::` path or `#index`).
	 * Never silently guesses.
	 */
	public resolveSymbol(qualifiedName: string): ResolveResult {
		const { file, index, segments } = parseQualifiedName(qualifiedName);
		const sourceFile = this.#getSourceFile(file);

		if (!sourceFile) {
			return { kind: "not-found" };
		}

		const decls = this.#namedDeclarations(sourceFile, segments);

		if (decls.length === 0) {
			// A caller who used `.` instead of `::` between segments gets a bare miss; if the
			// dotted form would resolve under `::`, point them at the right separator (#101).
			const dotted = segments.find((s) => s.includes("."));

			if (dotted !== undefined) {
				const reSplit = segments.flatMap((s) => s.split("."));

				if (this.#namedDeclarations(sourceFile, reSplit).length > 0) {
					const joined = joinSegments(reSplit);

					return { kind: "not-found", hint: `segments nest with \`${NS_SEP}\`, not \`.\` — did you mean ${file}:${joined}?` };
				}
			}

			const suggestions = nearestNames(sourceFile, segments[segments.length - 1]!);

			return suggestions.length > 0 ? { suggestions, kind: "not-found" } : { kind: "not-found" };
		}

		const base = this.#baseDir;

		if (index !== undefined) {
			const picked = decls[index];

			if (!picked) {
				return { kind: "not-found" };
			}

			return { kind: "symbol", symbol: declarationToHandle(picked, file, base, index) };
		}

		if (decls.length > 1) {
			return {
				kind: "ambiguous",
				candidates: decls.map((decl, i) => {
					// Distinct `::` paths self-disambiguate; only same-path collisions need #index.
					const samePathCount = decls.filter((d) => d.path === decl.path).length;
					const handle = declarationToHandle(decl, file, base, samePathCount > 1 ? i : undefined);

					return {
						position: handle.position,
						kind: kindName(decl.node),
						qualifiedName: handle.qualifiedName
					};
				})
			};
		}

		return { kind: "symbol", symbol: declarationToHandle(decls[0]!, file, base) };
	}

	/**
	 * Repo-wide search for declarations named `name`, across all source files and
	 * namespace depths. Exact last-segment match by default; substring (case-insensitive)
	 * with `contains`. Returns candidates the caller can target for refs/def.
	 */
	public searchSymbol(name: string, options?: SearchOptions): Candidate[] {
		const matches = (declName: string): boolean =>
			options?.contains === true ? declName.toLowerCase().includes(name.toLowerCase()) : declName === name;

		const candidates: Candidate[] = [];
		const base = this.#baseDir;
		const { stamps, project } = this.#warm();
		const kindSet = options?.kinds !== undefined && options.kinds.length > 0 ? new Set(options.kinds) : undefined;
		const pathNeedle = options?.path !== undefined && options.path !== "" ? options.path.toLowerCase() : undefined;

		for (const fileName of [...stamps.keys()].sort()) {
			const rel = toRelative(fileName, base);

			if (options?.excludeTests === true && isTestFile(rel)) {
				continue;
			}

			if (pathNeedle !== undefined && !rel.toLowerCase().includes(pathNeedle)) {
				continue;
			}

			const sourceFile = project.program.getSourceFile(fileName);

			if (sourceFile === undefined || !textMayContain(sourceFile.text, name, options?.contains === true)) {
				continue;
			}

			for (const decl of allDeclarations(sourceFile)) {
				const segments = splitName(decl.path);

				if (!matches(segments[segments.length - 1]!)) {
					continue;
				}

				const kind = kindName(decl.node);

				if (kindSet !== undefined && !kindSet.has(shortKind(kind))) {
					continue;
				}

				candidates.push({ kind, position: position(decl.node, base), qualifiedName: `${rel}:${decl.path}` });
			}
		}

		return candidates;
	}

	/** Resolve a handle back to its declaration node(s). */
	#declarationsFor(symbol: SymbolHandle): Node[] {
		const { file, index, segments } = parseQualifiedName(symbol.qualifiedName);
		const sourceFile = this.#getSourceFile(file);

		if (!sourceFile) {
			return [];
		}

		const decls = this.#namedDeclarations(sourceFile, segments);

		if (index !== undefined) {
			const picked = decls[index];

			return picked ? [picked.node] : [];
		}

		return decls.map((d) => d.node);
	}

	/**
	 * Every reference node the compiler reports for the symbol a declaration names, the declaration
	 * itself included. The compiler finds uses per declaration meaning (an interface's type uses
	 * exclude its namespace), so a merged symbol is searched from each of its declarations.
	 */
	#referencesTo(decl: Node): Node[] {
		const { project } = this.#warm();
		const merged = project.checker.getSymbolOfNode(decl);
		const mergedDecls = merged === undefined || merged.declarations.length < 2 ? [] : this.#nodesOf(merged);
		const seen = new Set<string>();
		const nodes: Node[] = [];

		for (const searched of [decl, ...mergedDecls]) {
			const target = nameNodeOf(searched) ?? searched;

			for (const entry of project.languageService.getReferencedSymbolsForNode(target, target.getStart())) {
				for (const handle of entry.references) {
					const node = handle.resolve(project);

					if (node !== undefined && !seen.has(nodeKey(node))) {
						seen.add(nodeKey(node));
						nodes.push(node);
					}
				}
			}
		}

		return nodes;
	}

	/** Kind of a reference site; the symbol's own declaration name is its own kind. */
	#kindOfReference(node: Node): ReferenceKind {
		const kind = classifyReference(node);
		const isDeclarationName = kind === "read" && DECLARATION_KINDS.has(node.parent.kind) && nameNodeOf(node.parent) === node;

		return isDeclarationName ? "declaration" : kind;
	}

	/** All references to a symbol (declaration included), classified by kind. Bounded by `limit`/`cursor`. */
	public findUsages(symbol: SymbolHandle, options?: FindUsagesOptions): UsagesResult {
		const decls = this.#declarationsFor(symbol);
		const base = this.#baseDir;
		const context = options?.context ?? "none";

		const seen = new Set<string>();
		// Keep the node alongside the record so context can be computed for the page only.
		const all = decls
			.flatMap((decl) => this.#referencesTo(decl))
			.map((node) => {
				const pos = position(node, base);

				return { node, position: pos, test: isTestFile(pos.file), kind: this.#kindOfReference(node) };
			})
			.filter((ref) => {
				const key = `${ref.position.file}:${ref.position.line}:${ref.position.col}`;

				if (seen.has(key)) {
					return false;
				}

				seen.add(key);

				return options?.excludeTests === true ? ref.test !== true : true;
			});

		const offset = parsePageCursor(options?.cursor);
		const limit = options?.limit;
		const pageRecords = limit === undefined ? all.slice(offset) : all.slice(offset, offset + limit);
		const nextOffset = offset + pageRecords.length;
		const nextCursor = nextOffset < all.length ? String(nextOffset) : undefined;

		const page: Reference[] = pageRecords.map(({ node, test, kind, position: pos }) => {
			const ctx = contextFor(node, context);

			return { test, kind, position: pos, ...(ctx !== undefined ? { context: ctx } : {}) };
		});

		return { nextCursor, references: page, total: all.length };
	}

	/** Declarations a call/new expression resolves to: the resolved signature, else the callee's symbol. */
	#callTargets(call: Node): Node[] {
		const { project } = this.#warm();
		const { checker } = project;
		const signature = checker.getResolvedSignature(call);
		const declaration = checker.isUnknownSignature(signature) ? undefined : signature.declaration?.resolve(project);

		if (declaration !== undefined) {
			return [declaration];
		}

		const expression = (call as { expression?: Node }).expression;
		const callee = expression !== undefined && isPropertyAccessExpression(expression) ? expression.name : expression;

		return callee !== undefined && isIdentifier(callee) ? this.#aliasTargets(checker.getSymbolAtLocation(callee)) : [];
	}

	/** Callers (incoming) or callees (outgoing) of a symbol, walked to a bounded depth. */
	public callHierarchy(symbol: SymbolHandle, options?: CallHierarchyOptions): CallNode[] {
		const direction = options?.direction ?? "incoming";
		const depth = options?.depth ?? 2;
		const resolver: CallResolver = {
			targetsOf: (call) => this.#callTargets(call),
			usesOf: (decl) => this.#referencesTo(decl).filter((ref) => this.#kindOfReference(ref) !== "declaration")
		};

		return this.#declarationsFor(symbol).flatMap((decl) => buildCallHierarchy(decl, { depth, direction }, { resolver, baseDir: this.#baseDir }));
	}

	/** Implementors of an interface / abstract class: heritage-clause and object-literal uses. */
	public findImplementations(symbol: SymbolHandle): SymbolHandle[] {
		const base = this.#baseDir;
		const seen = new Set<string>();
		const handles: SymbolHandle[] = [];

		for (const decl of this.#declarationsFor(symbol)) {
			for (const ref of this.#referencesTo(decl)) {
				const implementor = implementorOf(ref);
				const name = implementor === undefined ? undefined : declName(implementor);

				if (implementor === undefined || name === undefined) {
					continue;
				}

				const pos = position(implementor, base);
				const qualifiedName = `${pos.file}:${name}`;

				if (!seen.has(qualifiedName)) {
					seen.add(qualifiedName);
					handles.push({ qualifiedName, position: pos });
				}
			}
		}

		return handles;
	}

	/**
	 * All declaration sites of a resolved symbol: the named declarations plus, when no `#index`
	 * narrows it, every other declaration the compiler merged into the same symbol (overloads,
	 * interface + namespace, module augmentation in another file).
	 */
	public findDefinition(symbol: SymbolHandle): SymbolHandle[] {
		const { file, index, segments } = parseQualifiedName(symbol.qualifiedName);
		const path = joinSegments(segments);
		const base = this.#baseDir;
		const named = this.#declarationsFor(symbol);
		const handles = named.map((node) => declarationToHandle({ node, path }, file, base));

		if (index !== undefined) {
			return handles;
		}

		const { checker } = this.#project;
		const known = new Set(named.map(nodeKey));

		for (const node of named) {
			const merged = checker.getSymbolOfNode(node);

			for (const other of merged === undefined ? [] : this.#nodesOf(merged)) {
				const otherPath = dottedPath(other);

				if (known.has(nodeKey(other)) || otherPath === undefined) {
					continue;
				}

				known.add(nodeKey(other));
				const otherPosition = position(other, base);
				handles.push({ position: otherPosition, qualifiedName: `${otherPosition.file}:${otherPath}` });
			}
		}

		return handles;
	}

	/** Exact source of each declaration of a symbol (signature + body). */
	public symbolSource(symbol: SymbolHandle): SourceResult[] {
		const { file, segments } = parseQualifiedName(symbol.qualifiedName);
		const path = joinSegments(segments);
		const base = this.#baseDir;

		return this.#declarationsFor(symbol).map((node) => {
			const handle = declarationToHandle({ node, path }, file, base);

			return { position: handle.position, qualifiedName: handle.qualifiedName, source: withTagComment(tagsOf(node), node.getText()) };
		});
	}

	/** A verbatim slice of a file by 1-based inclusive line range. */
	public readRegion(file: string, startLine: number, endLine: number): RegionResult {
		const sourceFile = this.#requireSourceFile(file);

		return readRegionFrom(sourceFile.fileName, file, startLine, endLine);
	}

	/** A symbol's source + signature + outgoing callees + referenced type names, in one call. */
	public symbolContext(symbol: SymbolHandle): SymbolContext {
		const sources = this.symbolSource(symbol);
		const first = sources[0];
		const source = first?.source ?? "";
		const [decl] = this.#declarationsFor(symbol);

		return {
			source,
			signature: signatureOfSource(source),
			position: first?.position ?? symbol.position,
			typeRefs: decl === undefined ? [] : typeRefsIn(decl),
			qualifiedName: first?.qualifiedName ?? symbol.qualifiedName,
			callees: this.callHierarchy(symbol, { depth: 1, direction: "outgoing" })
		};
	}

	/** Structural "table of contents" for a file. Deterministic AST walk. */
	public outlineFile(path: string): FileOutline {
		return buildFileOutline(this.#requireSourceFile(path), this.#baseDir);
	}

	/**
	 * The transitive public surface of an entry file: resolves `export *` and re-export
	 * chains to the concrete exported symbols, each pointed at its true declaration.
	 */
	public publicSurface(path: string): Candidate[] {
		const sourceFile = this.#requireSourceFile(path);
		const { checker } = this.#project;
		const moduleSymbol = checker.getSymbolOfSourceFile(sourceFile.fileName);
		const base = this.#baseDir;
		const seen = new Set<string>();
		const surface: Candidate[] = [];

		for (const exported of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
			for (const decl of this.#aliasTargets(exported)) {
				const pos = position(decl, base);
				const key = `${pos.file}:${exported.name}`;

				if (seen.has(key)) {
					continue;
				}

				seen.add(key);
				surface.push({ position: pos, qualifiedName: key, kind: kindName(decl) });
			}
		}

		// The checker's export table has no stable order worth exposing; read it by location.
		return surface.sort(byPosition);
	}

	/**
	 * Usage report for every public symbol of an entry file: each symbol with its total
	 * reference count and a `consumed` count (excluding import / re-export references — a
	 * proxy for real consumption). One call replaces surface + per-symbol refs.
	 */
	public usageReport(path: string, options?: UsageReportOptions): UsageReportEntry[] {
		const entryFor = (handle: SymbolHandle, kind: string): UsageReportEntry => {
			const { references } = this.findUsages(handle, { excludeTests: options?.excludeTests });
			const uses = references.filter((r) => r.kind !== "declaration");
			const consumed = uses.filter((r) => r.kind !== "import" && r.kind !== "re-export").length;

			return { kind, consumed, total: uses.length, position: handle.position, qualifiedName: handle.qualifiedName };
		};

		const entries: UsageReportEntry[] = [];

		for (const symbol of this.publicSurface(path)) {
			entries.push(entryFor(symbol, symbol.kind));

			// Opt-in: also report each class/interface member, so a dead public *method*
			// (invisible to the top-level surface) is surfaced too (#119).
			if (options?.members === true) {
				for (const member of this.membersByName(symbol.qualifiedName)) {
					if (member.qualifiedName === undefined) {
						continue;
					}

					const resolved = this.resolveSymbol(member.qualifiedName);

					if (resolved.kind === "symbol") {
						entries.push(entryFor(resolved.symbol, member.kind));
					}
				}
			}
		}

		return entries;
	}

	/** The import statements of a file — module wiring, deterministic. */
	public listImports(path: string): ImportInfo[] {
		const sourceFile = this.#requireSourceFile(path);
		const base = this.#baseDir;
		const imports: ImportInfo[] = [];

		for (const stmt of sourceFile.statements) {
			if (!isImportDeclaration(stmt)) {
				continue;
			}

			const clause = stmt.importClause;
			const bindings = clause?.namedBindings;
			const namespace = bindings !== undefined && isNamespaceImport(bindings) ? bindings.name.text : undefined;
			const defaultImport = clause?.name?.text;

			imports.push({
				module: (stmt.moduleSpecifier as { text?: string }).text ?? stmt.moduleSpecifier.getText(),
				named: bindings !== undefined && isNamedImports(bindings) ? bindings.elements.map((el) => (el.propertyName ?? el.name).getText()) : [],
				...(defaultImport !== undefined ? { default: defaultImport } : {}),
				...(namespace !== undefined ? { namespace } : {}),
				position: position(stmt, base)
			});
		}

		return imports;
	}

	/** Members of a class / interface / namespace. Deterministic AST walk. */
	public outlineSymbol(symbol: SymbolHandle): Member[] {
		const base = this.#baseDir;

		return this.#declarationsFor(symbol).flatMap((decl) => buildSymbolOutline(decl, base, symbol.qualifiedName));
	}

	/**
	 * Members of a name, folding a declaration merge (e.g. `interface X` + `namespace X`)
	 * into one list. Resolving such a name with `resolveSymbol` reports `ambiguous`, but for
	 * members the merged declarations are one logical symbol — outline them all together.
	 */
	public membersByName(qualifiedName: string): Member[] {
		const { file, segments } = parseQualifiedName(qualifiedName);
		const sourceFile = this.#getSourceFile(file);

		if (!sourceFile) {
			return [];
		}

		const base = this.#baseDir;

		return this.#namedDeclarations(sourceFile, segments).flatMap((decl) => buildSymbolOutline(decl.node, base, qualifiedName));
	}

	/** Statement-level skeleton of a function body. `depth` controls nesting (default 1). */
	public outlineFunction(symbol: SymbolHandle, options?: OutlineFunctionOptions): StatementNode[] {
		const depth = options?.depth ?? 1;
		const base = this.#baseDir;

		return this.#declarationsFor(symbol).flatMap((decl) => buildFunctionOutline(decl, depth, base));
	}
}

/** Order candidates by file, then line, then column. */
function byPosition(a: Candidate, b: Candidate): number {
	return a.position.file.localeCompare(b.position.file) || a.position.line - b.position.line || a.position.col - b.position.col;
}

/** Distinct named types referenced inside a declaration (syntactic, names only). */
function typeRefsIn(decl: Node): string[] {
	const names = new Set<string>();

	forEachDescendant(decl, (node) => {
		if (isTypeReferenceNode(node)) {
			names.add(node.typeName.getText());
		}
	});

	return [...names];
}

/** Cheap pre-check so a repo-wide search only decodes files that can possibly match. */
function textMayContain(text: string, name: string, caseInsensitive: boolean): boolean {
	return caseInsensitive ? text.toLowerCase().includes(name.toLowerCase()) : text.includes(name);
}

/** Change stamp (mtime + size) of a file, or undefined when the file is gone. */
function stampOf(fileName: string): string | undefined {
	try {
		const { size, mtimeMs } = statSync(fileName);

		return `${mtimeMs}:${size}`;
	} catch {
		return undefined;
	}
}
