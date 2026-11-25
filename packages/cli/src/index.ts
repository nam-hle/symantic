#!/usr/bin/env node
/**
 * symantic CLI adapter. Translates CLI args <-> @symantic/core calls and prints
 * results. No analysis logic. See docs/DESIGN.md Section 1.
 *
 * Commands group by agent intent: `view` (read code) and `find` (locate/trace),
 * plus top-level addressing / whole-file facts.
 */
import { dirname } from "node:path";
import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import { NS_SEP, planMove, planRename, createEngine, applyEditPlan, isValidIdentifier } from "@symantic/core";
import type { EditResult, SymbolHandle, AsyncSymbolEngine } from "@symantic/core";
import {
	renderSource,
	renderRegion,
	renderResolve,
	renderHandles,
	renderMembers,
	renderContext,
	renderImports,
	renderReferences,
	renderCandidates,
	renderStatements,
	renderFileOutline,
	renderUsageReport,
	renderCallHierarchy
} from "@symantic/core";

import { gain } from "./gain/command.js";
import { readVersion } from "./version.js";
import { recordGain } from "./gain/track.js";
import { runCli } from "./run-main.js";
import { SymanticError } from "./errors.js";
import { hashFiles, lastSegment, renderMove, editFailure, isFile, projectPath, identifierAt, renderRename } from "./edit.js";
import { DEFAULT_LIMIT, slicePage, continuation } from "./paging.js";
import type { Continuation, FlagValues } from "./paging.js";
import { SHORT_KINDS, kindList, positiveInt, nonNegativeInt } from "./flags.js";
import { resolveTsconfig } from "./tsconfig.js";
import { daemonEngine } from "./daemon/client.js";
import { runDaemonServer } from "./daemon/server.js";

/** Identifies the query for the gain ledger: its op label and the project tsconfig. */
interface GainMeta {
	op: string;
	tsconfig: string;
}

/**
 * Print text via `render` by default, or pretty JSON of `value` when jsonFlag is set,
 * then record the query's estimated token savings to the gain ledger (on by default).
 */
function output(gain: GainMeta, value: unknown, render: () => string, jsonFlag: boolean | undefined): void {
	const emitted = jsonFlag === true ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`;
	process.stdout.write(emitted);
	recordGain(gain.op, value, emitted, gain.tsconfig);
}

const tsconfig = { type: "string", description: "Path to the project tsconfig.json (default: nearest one found upward from cwd)" } as const;
const json = { type: "boolean", description: "Emit structured JSON instead of text" } as const;
/** `--to` is the destination of every edit command; `what` says what it holds for this one. */
const toFlag = (what: string) => ({ type: "string", required: true, description: `Destination of the edit: ${what}` }) as const;
/** The one preview flag of the edit commands. */
const dryRun = { type: "boolean", description: "Compute and report the edit without writing any file" } as const;

/**
 * Run a command body with a fresh engine over the resolved tsconfig (explicit `--tsconfig`,
 * else the nearest one upward from cwd), disposing it after. The resolved path is passed to
 * the body so the gain ledger records the real project. Failures propagate to `runCli`, which
 * reports them as one envelope; the engine is disposed first.
 */
async function withEngine(args: { tsconfig?: string }, fn: (engine: AsyncSymbolEngine, tsConfigPath: string) => Promise<void>): Promise<void> {
	let tsConfigPath: string;

	try {
		tsConfigPath = resolveTsconfig(args.tsconfig);
	} catch (error) {
		throw new SymanticError("NO_PROJECT", error instanceof Error ? error.message : String(error));
	}

	if (!existsSync(tsConfigPath)) {
		throw new SymanticError("NO_PROJECT", `tsconfig not found: ${tsConfigPath}`, { context: { tsconfig: tsConfigPath } });
	}

	// Warm daemon first (#113) — repeat invocations skip the full project load. Falls back
	// to a fresh in-process engine when the daemon is disabled or unreachable.
	const engineInstance = (await daemonEngine(tsConfigPath, readVersion())) ?? createEngine({ tsConfigPath });

	try {
		if ((await engineInstance.sourceFileCount()) === 0) {
			process.stderr.write(
				`warning: project loaded 0 source files from ${tsConfigPath} — likely a shared base config; pass a per-package tsconfig via --tsconfig\n`
			);
		}

		await fn(engineInstance, tsConfigPath);
	} catch (error) {
		// The engine words its load failure as plain text; give it the project code.
		if (error instanceof Error && error.message.startsWith("could not load project")) {
			throw new SymanticError("NO_PROJECT", error.message, { context: { tsconfig: tsConfigPath } });
		}

		if (error instanceof Error && error.name === "InvalidQualifiedNameError") {
			// The engine appends the grammar after the first line; it is the hint, not the message.
			const [message = "", ...grammar] = error.message.split("\n");

			throw new SymanticError("VALIDATION_ERROR", message, { hint: grammar.join("\n") || undefined, context: { argument: "symbol" } });
		}

		const missingFile = error instanceof Error ? /^file not found in project: (\S+)/.exec(error.message) : null;

		if (missingFile !== null) {
			throw new SymanticError("NOT_FOUND", `file not found in project: ${missingFile[1]}`, {
				context: { file: missingFile[1] },
				hint: "check the path (relative to the tsconfig directory) and that the tsconfig covers the file"
			});
		}

		throw error;
	} finally {
		await engineInstance.dispose();
	}
}

/** The NOT_FOUND error for an address that did not resolve, with the engine's hint or did-you-mean names. */
function notFoundError(qualifiedName: string, miss: { hint?: string; suggestions?: string[] }): SymanticError {
	const suggestions = miss.suggestions ?? [];
	const suggestionHint = suggestions.length > 0 ? `did you mean: ${suggestions.join(", ")}` : undefined;

	return new SymanticError("NOT_FOUND", `not found: ${qualifiedName}`, {
		hint: miss.hint ?? suggestionHint,
		context: { symbol: qualifiedName, suggestions }
	});
}

interface ListOptions {
	/** The command's `--json` flag. */
	json: boolean | undefined;
	/** Shown only when the list is empty: how to widen the query. */
	hint?: string;
	/** Count of all matches when `items` is a cut-off page of them. */
	total?: number;
	/** Set when `items` is a page that stops short of `total`: the notice and the next page's command. */
	cut?: Continuation;
}

/**
 * Print a list result as one object, `{ items, total, next? }`, so counts, hints and cut-off notes
 * have a place. A cut result says so on stdout (a silent cut reads as the whole answer). An empty
 * list is a valid answer: its widening hint is a `hint` field in JSON and a stderr line in text.
 */
function outputList<T>(gain: GainMeta, items: T[], render: () => string, options: ListOptions): void {
	const total = options.total ?? items.length;
	// A cursor past the end of a non-empty list is empty too: its notice doubles as the hint field.
	const pastEnd = items.length === 0 && total > 0 && options.cut !== undefined;
	const hint = total === 0 ? options.hint : pastEnd ? options.cut?.note : undefined;
	const value = { items, total, ...(options.cut === undefined ? {} : { next: options.cut.next }), ...(hint === undefined ? {} : { hint }) };
	const renderCut = (): string => (options.cut === undefined ? render() : `${render()}\n${options.cut.note}\nnext: ${options.cut.next}`);
	output(gain, value, renderCut, options.json);

	// Text mode already prints a past-the-end notice on stdout with the cut line.
	if (hint !== undefined && !pastEnd && options.json !== true) {
		process.stderr.write(`hint: ${hint}\n`);
	}
}

interface PagedListSpec<T> {
	all: T[];
	offset: number;
	limit: number;
	hint?: string;
	gain: GainMeta;
	json: boolean | undefined;
	render: (items: T[]) => string;
	call: { words: string[]; flags: FlagValues; narrowWith: string };
}

/** Print the `[offset, offset + limit)` window of an ordered list, with the cut-off notice and next command. */
function outputPaged<T>(spec: PagedListSpec<T>): void {
	const page = slicePage(spec.all, spec.offset, spec.limit);
	const cut = continuation({ offset: spec.offset, limit: spec.limit, shown: page.items.length, total: page.total }, spec.call);
	outputList(spec.gain, page.items, () => spec.render(page.items), { cut, json: spec.json, hint: spec.hint, total: page.total });
}

/** `--limit` flag shared by the list commands; `order` states how the list is sorted. */
const limitFlag = (order: string) =>
	({ type: "string", description: `Max items to return, a positive integer (default ${DEFAULT_LIMIT}). Ordered by ${order}` }) as const;

/** `--cursor` flag shared by the list commands: how many items of the ordered list to skip. */
const cursorFlag = { type: "string", description: "Items to skip, a non-negative integer; the `next` command of a cut result sets it" } as const;

/** Resolve a name to a single symbol, or throw NOT_FOUND / AMBIGUOUS carrying the engine's hint or candidates. */
async function resolveSymbolOrThrow(engineInstance: AsyncSymbolEngine, qualifiedName: string): Promise<SymbolHandle> {
	const result = await engineInstance.resolveSymbol(qualifiedName);

	if (result.kind === "symbol") {
		return result.symbol;
	}

	if (result.kind === "not-found") {
		throw notFoundError(qualifiedName, result);
	}

	const addresses = result.candidates.map((candidate) => candidate.qualifiedName);

	throw new SymanticError("AMBIGUOUS", `"${qualifiedName}" is ambiguous: ${addresses.length} declarations match`, {
		hint: `retry with one of: ${addresses.join(", ")}`,
		context: { symbol: qualifiedName, candidates: result.candidates }
	});
}

const symbolArg = { required: true, type: "positional", description: "file:name[#index]" } as const;
const fileArg = { required: true, type: "positional", description: "Relative file path" } as const;

// ---- top-level: addressing + whole-file facts ----

const resolve = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "resolve", description: "Resolve a qualified name to a symbol or candidates" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const r = await e.resolveSymbol(args.symbol);

			if (r.kind === "not-found") {
				throw notFoundError(args.symbol, r);
			}

			output({ tsconfig: tc, op: "resolve" }, r, () => renderResolve(r), args.json);
		});
	}
});

const imports = defineCommand({
	args: { json, tsconfig, file: fileArg },
	meta: { name: "imports", description: "List the import statements of a file" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const imps = await e.listImports(args.file);
			outputList({ tsconfig: tc, op: "imports" }, imps, () => renderImports(imps), { json: args.json });
		});
	}
});

const exportsCmd = defineCommand({
	args: { json, tsconfig, file: fileArg, limit: limitFlag("file, line, column of the declaration"), cursor: cursorFlag },
	meta: { name: "exports", description: "Transitive public surface of an entry file (expands export *)" },
	async run({ args }) {
		const offset = nonNegativeInt("cursor", args.cursor) ?? 0;
		const limit = positiveInt("limit", args.limit) ?? DEFAULT_LIMIT;

		await withEngine(args, async (e, tc) => {
			outputPaged({
				limit,
				offset,
				json: args.json,
				all: await e.publicSurface(args.file),
				render: renderCandidates,
				gain: { tsconfig: tc, op: "exports" },
				call: { words: ["exports", args.file], flags: { tsconfig: args.tsconfig, json: args.json }, narrowWith: "a narrower entry file" }
			});
		});
	}
});

const usage = defineCommand({
	meta: { name: "usage", description: "Usage report: each public symbol of an entry with its reference counts" },
	args: {
		json,
		tsconfig,
		file: fileArg,
		cursor: cursorFlag,
		limit: limitFlag("the entry file's public surface order: file, line, column of the declaration"),
		"exclude-tests": { type: "boolean", description: "Omit references in test files" },
		members: { type: "boolean", description: "Also report class/interface member ref counts (Owner::member), not just top-level exports" }
	},
	async run({ args }) {
		const offset = nonNegativeInt("cursor", args.cursor) ?? 0;
		const limit = positiveInt("limit", args.limit) ?? DEFAULT_LIMIT;

		await withEngine(args, async (e, tc) => {
			outputPaged({
				limit,
				offset,
				json: args.json,
				render: renderUsageReport,
				gain: { op: "usage", tsconfig: tc },
				all: await e.usageReport(args.file, { members: args.members === true, excludeTests: args["exclude-tests"] === true }),
				call: {
					narrowWith: "--exclude-tests or a narrower entry file",
					words: ["usage", args.file],
					flags: { members: args.members, tsconfig: args.tsconfig, json: args.json, "exclude-tests": args["exclude-tests"] }
				}
			});
		});
	}
});

// ---- view: read code (structure + source) ----

const viewOutline = defineCommand({
	meta: { name: "outline", description: "Outline the structure of a file (compact tree)" },
	args: { json, tsconfig, file: fileArg },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const outline = await e.outlineFile(args.file);
			output({ tsconfig: tc, op: "view outline" }, outline, () => renderFileOutline(args.file, outline), args.json);
		});
	}
});

const viewFile = defineCommand({
	meta: { name: "file", description: "Token-lean whole file: outline, plus --body for each export's source" },
	args: { json, tsconfig, file: fileArg, body: { type: "boolean", description: "Include each export's source" } },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const outline = await e.outlineFile(args.file);

			if (args.body !== true) {
				output({ tsconfig: tc, op: "view file" }, outline, () => renderFileOutline(args.file, outline), args.json);

				return;
			}

			// Top-level exports only: a nested member's source is already inside its
			// namespace's source, so fetching it too would print it twice.
			const handles = outline.exports.flatMap((m) =>
				m.qualifiedName !== undefined && !m.name.includes(NS_SEP) ? [{ position: m.position, qualifiedName: m.qualifiedName }] : []
			);
			const sources = (await Promise.all(handles.map((h) => e.symbolSource(h)))).flat();
			const tree = renderFileOutline(args.file, outline);
			const body = sources.map((s) => s.source).join("\n\n");
			output({ tsconfig: tc, op: "view file" }, { outline, sources }, () => `${tree}\n${body}`, args.json);
		});
	}
});

const viewSymbol = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "symbol", description: "Print the exact source of a declaration" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const src = await e.symbolSource(await resolveSymbolOrThrow(e, args.symbol));
			outputList({ tsconfig: tc, op: "view symbol" }, src, () => renderSource(src), { json: args.json });
		});
	}
});

const viewMembers = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "members", description: "Outline the members of a class/interface/namespace" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			// membersByName resolves the name itself and folds a declaration merge
			// (interface+namespace) into one list, instead of erroring on ambiguity.
			const members = await e.membersByName(args.symbol);

			// An address that does not resolve must not read as a class with no members.
			if (members.length === 0) {
				const resolved = await e.resolveSymbol(args.symbol);

				if (resolved.kind === "not-found") {
					throw notFoundError(args.symbol, resolved);
				}
			}

			outputList({ tsconfig: tc, op: "view members" }, members, () => renderMembers(members), {
				json: args.json,
				hint: "the declaration has no members; `view symbol` prints its source"
			});
		});
	}
});

/** At or below this statement count the skeleton carries little over the source itself. */
const SHORT_BODY_STATEMENTS = 3;

const viewBody = defineCommand({
	meta: { name: "body", description: "Outline the statement skeleton of a function (--source for the code itself)" },
	args: {
		json,
		tsconfig,
		symbol: symbolArg,
		depth: { type: "string", description: "Nesting depth, a positive integer (default 1)" },
		source: { type: "boolean", description: "Print the function source instead of the statement skeleton" }
	},
	async run({ args }) {
		const depth = positiveInt("depth", args.depth);

		await withEngine(args, async (e, tc) => {
			const symbol = await resolveSymbolOrThrow(e, args.symbol);

			if (args.source === true) {
				const src = await e.symbolSource(symbol);
				outputList({ tsconfig: tc, op: "view body" }, src, () => renderSource(src), { json: args.json });

				return;
			}

			const stmts = await e.outlineFunction(symbol, { depth });
			outputList({ tsconfig: tc, op: "view body" }, stmts, () => renderStatements(stmts), { json: args.json });

			if (stmts.length <= SHORT_BODY_STATEMENTS && args.json !== true) {
				process.stderr.write("hint: short body — `view body --source` (or `view symbol`) shows the code itself\n");
			}
		});
	}
});

const viewRegion = defineCommand({
	meta: { name: "region", description: "Print an addressed line range: file:start-end" },
	args: {
		json,
		tsconfig,
		target: { required: true, type: "positional", description: "file:start-end, 1-based inclusive lines (e.g. src/a.ts:10-30)" }
	},
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const m = /^(.*):(\d+)-(\d+)$/.exec(args.target);

			if (m === null || Number(m[2]) < 1 || Number(m[2]) > Number(m[3])) {
				throw new SymanticError("VALIDATION_ERROR", `expected file:start-end with 1 <= start <= end (e.g. src/a.ts:10-30), got "${args.target}"`, {
					context: { argument: "target", value: args.target, expected: "file:start-end, 1 <= start <= end" }
				});
			}

			const region = await e.readRegion(m[1]!, Number(m[2]), Number(m[3]));
			output({ tsconfig: tc, op: "view region" }, region, () => renderRegion(region), args.json);
		});
	}
});

const viewContext = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "context", description: "Source + signature + callees + referenced types" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const ctx = await e.symbolContext(await resolveSymbolOrThrow(e, args.symbol));
			output({ tsconfig: tc, op: "view context" }, ctx, () => renderContext(ctx), args.json);
		});
	}
});

// ---- find: locate + trace ----

const findSymbol = defineCommand({
	meta: { name: "symbol", description: "Search for a symbol by name across the whole project" },
	args: {
		json,
		tsconfig,
		name: { required: true, type: "positional", description: "Symbol name" },
		path: { type: "string", description: "Keep only hits whose file path contains this substring — scope to a subtree" },
		"exclude-tests": { type: "boolean", description: "Omit hits in test files — cuts orientation noise on test-heavy projects" },
		kind: { type: "string", description: `Keep only these short kinds, comma-separated: ${SHORT_KINDS.join("|")}` },
		limit: limitFlag("file path, then declaration order in the file"),
		cursor: cursorFlag,
		contains: {
			type: "boolean",
			description: "Match the name as a substring (case-insensitive) — the orientation entry point when you only know part of a name"
		}
	},
	async run({ args }) {
		const kinds = kindList(args.kind);
		const offset = nonNegativeInt("cursor", args.cursor) ?? 0;
		const limit = positiveInt("limit", args.limit) ?? DEFAULT_LIMIT;

		await withEngine(args, async (e, tc) => {
			const cands = await e.searchSymbol(args.name, {
				kinds,
				contains: args.contains,
				excludeTests: args["exclude-tests"] === true,
				path: typeof args.path === "string" ? args.path : undefined
			});
			const narrowing = [
				kinds === undefined ? "" : "--kind",
				args.path === undefined ? "" : "--path",
				args["exclude-tests"] === true ? "--exclude-tests" : ""
			].filter((flag) => flag !== "");
			const hints = [
				looksLikeFile(args.name)
					? `"${args.name}" looks like a file, not a symbol — try \`view outline <file>\` to list its declarations`
					: args.contains !== true
						? `no exact match for "${args.name}" — retry with --contains for substring search`
						: narrowing.length === 0
							? `no declaration name contains "${args.name}" — check the spelling`
							: "",
				narrowing.length > 0 ? `the filters ${narrowing.join(", ")} narrow the search — drop one to widen it` : ""
			].filter((hint) => hint !== "");
			outputPaged({
				limit,
				offset,
				all: cands,
				json: args.json,
				render: renderCandidates,
				hint: hints.join("; "),
				gain: { tsconfig: tc, op: "find symbol" },
				call: {
					words: ["find", "symbol", args.name],
					narrowWith: "--kind, --path or --exclude-tests",
					flags: {
						path: args.path,
						kind: args.kind,
						json: args.json,
						contains: args.contains,
						tsconfig: args.tsconfig,
						"exclude-tests": args["exclude-tests"]
					}
				}
			});
		});
	}
});

/** A query that reads like a file path/stem rather than a symbol: has a slash, a .ts(x) suffix, or is kebab-case. */
function looksLikeFile(query: string): boolean {
	return query.includes("/") || /\.tsx?$/.test(query) || (/-/.test(query) && query === query.toLowerCase());
}

const findDef = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "def", description: "Find the declaration site(s) of a symbol" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const handles = await e.findDefinition(await resolveSymbolOrThrow(e, args.symbol));
			outputList({ tsconfig: tc, op: "find def" }, handles, () => renderHandles(handles), { json: args.json });
		});
	}
});

const findRefs = defineCommand({
	meta: { name: "refs", description: "Find usages of a symbol" },
	args: {
		json,
		tsconfig,
		symbol: symbolArg,
		cursor: cursorFlag,
		limit: limitFlag("file path, then line and column"),
		"exclude-tests": { type: "boolean", description: "Omit references in test files" },
		context: { type: "enum", options: ["none", "snippet", "block"], description: "Surrounding source per ref (default none)" }
	},
	async run({ args }) {
		const offset = nonNegativeInt("cursor", args.cursor) ?? 0;
		const limit = positiveInt("limit", args.limit) ?? DEFAULT_LIMIT;

		await withEngine(args, async (e, tc) => {
			const symbol = await resolveSymbolOrThrow(e, args.symbol);
			const usages = await e.findUsages(symbol, {
				limit,
				context: args.context,
				cursor: String(offset),
				excludeTests: args["exclude-tests"] === true
			});
			const cut = continuation(
				{ limit, offset, shown: usages.references.length, total: usages.total },
				{
					narrowWith: "--exclude-tests",
					words: ["find", "refs", args.symbol],
					flags: { context: args.context, json: args.json, tsconfig: args.tsconfig, "exclude-tests": args["exclude-tests"] }
				}
			);
			// The cut-off line below replaces the core renderer's "(more: cursor N)" suffix.
			outputList({ tsconfig: tc, op: "find refs" }, usages.references, () => renderReferences({ ...usages, nextCursor: undefined }), {
				cut,
				json: args.json,
				total: usages.total,
				hint:
					args["exclude-tests"] === true
						? "no references outside test files — drop --exclude-tests to include them"
						: "no references in the project — `find def` confirms the declaration, `find callers` traces calls"
			});
		});
	}
});

const findImpls = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "impls", description: "Find implementations of an interface" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const handles = await e.findImplementations(await resolveSymbolOrThrow(e, args.symbol));
			outputList({ tsconfig: tc, op: "find impls" }, handles, () => renderHandles(handles), {
				json: args.json,
				hint: "no implementations in the project — `find refs` shows where the symbol is used"
			});
		});
	}
});

const findCallers = defineCommand({
	meta: { name: "callers", description: "Incoming call hierarchy: who calls this symbol" },
	args: { json, tsconfig, symbol: symbolArg, depth: { type: "string", description: "Levels to walk, a positive integer (default 2)" } },
	async run({ args }) {
		const depth = positiveInt("depth", args.depth);

		await withEngine(args, async (e, tc) => {
			const symbol = await resolveSymbolOrThrow(e, args.symbol);
			const tree = await e.callHierarchy(symbol, { depth, direction: "incoming" });
			outputList({ tsconfig: tc, op: "find callers" }, tree, () => renderCallHierarchy(tree), {
				json: args.json,
				hint: "no callers found — raise --depth, or `find refs` for non-call uses"
			});
		});
	}
});

const findCallees = defineCommand({
	meta: { name: "callees", description: "Outgoing call hierarchy: what this symbol calls" },
	args: { json, tsconfig, symbol: symbolArg, depth: { type: "string", description: "Levels to walk, a positive integer (default 2)" } },
	async run({ args }) {
		const depth = positiveInt("depth", args.depth);

		await withEngine(args, async (e, tc) => {
			const symbol = await resolveSymbolOrThrow(e, args.symbol);
			const tree = await e.callHierarchy(symbol, { depth, direction: "outgoing" });
			outputList({ tsconfig: tc, op: "find callees" }, tree, () => renderCallHierarchy(tree), {
				json: args.json,
				hint: "no callees found — raise --depth, or `view body` for the statements"
			});
		});
	}
});

const view = defineCommand({
	meta: { name: "view", description: "Read code: structure + source" },
	subCommands: {
		file: viewFile,
		body: viewBody,
		symbol: viewSymbol,
		region: viewRegion,
		outline: viewOutline,
		members: viewMembers,
		context: viewContext
	}
});

const find = defineCommand({
	meta: { name: "find", description: "Locate + trace symbols" },
	subCommands: { def: findDef, refs: findRefs, impls: findImpls, symbol: findSymbol, callers: findCallers, callees: findCallees }
});

// ---- edit: change code through the language server ----

const editRename = defineCommand({
	meta: { name: "rename", description: "Rename a symbol everywhere the compiler would" },
	args: { json, tsconfig, symbol: symbolArg, to: toFlag("the new name, a valid identifier"), "dry-run": dryRun },
	async run({ args }) {
		const newName = args.to;
		const oldName = lastSegment(args.symbol);

		if (!isValidIdentifier(newName)) {
			throw new SymanticError("VALIDATION_ERROR", `--to expects a valid identifier, got "${newName}"`, {
				context: { flag: "to", value: newName, expected: "a valid identifier" }
			});
		}

		await withEngine(args, async (e, tc) => {
			const baseDir = dirname(tc);
			const emit = (result: EditResult): void => {
				process.stdout.write(`${args.json === true ? JSON.stringify(result, null, 2) : renderRename(result, { from: oldName, to: newName })}\n`);
			};
			const symbol = await resolveSymbolOrThrow(e, args.symbol);
			const at = await e.symbolNamePosition(symbol);

			if (at === undefined) {
				throw new SymanticError("VALIDATION_ERROR", `cannot rename ${args.symbol}: the declaration has no name`, {
					context: { symbol: args.symbol }
				});
			}

			// The compiler would still rewrite `{ foo }` to `{ foo: foo }`; the same name is no edit at all.
			if (identifierAt(baseDir, at) === newName) {
				emit({ changed: [], unchanged: true, dryRun: args["dry-run"] === true });

				return;
			}

			try {
				const { references } = await e.findUsages(symbol);
				const baseHashes = hashFiles(baseDir, [at.file, ...references.map((reference) => reference.position.file)]);
				const plan = await planRename({ baseDir, baseHashes, newName, file: at.file, position: at });
				const result = applyEditPlan(plan, { baseDir, dryRun: args["dry-run"] === true });

				// The daemon re-stamps files on every call; asking now makes the next query see the edit.
				if (!result.dryRun && result.changed.length > 0) {
					await e.refreshIfStale();
				}

				emit(result);
			} catch (error) {
				throw editFailure(error, { symbol: args.symbol });
			}
		});
	}
});

const editMove = defineCommand({
	meta: { name: "move", description: "Move or rename a file and rewrite every import of it" },
	args: { json, tsconfig, file: fileArg, to: toFlag("the new path of the file, relative to the project"), "dry-run": dryRun },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const baseDir = dirname(tc);
			const from = projectPath(baseDir, args.file);
			const to = projectPath(baseDir, args.to);

			if (from === undefined || to === undefined) {
				const flag = from === undefined ? "<file>" : "--to";

				throw new SymanticError("VALIDATION_ERROR", `${flag} must be a path inside the project, got "${from === undefined ? args.file : args.to}"`, {
					context: { file: args.file, to: args.to, project: baseDir }
				});
			}

			if (!isFile(baseDir, from)) {
				throw new SymanticError("NOT_FOUND", `no such file: ${from}`, {
					context: { file: from },
					hint: "check the path (it may already have been moved); `symantic view outline <file>` reads a file of the project"
				});
			}

			const emit = (result: EditResult): void => {
				process.stdout.write(`${args.json === true ? JSON.stringify(result, null, 2) : renderMove(result, { from, to })}\n`);
			};

			if (from === to) {
				emit({ changed: [], unchanged: true, dryRun: args["dry-run"] === true });

				return;
			}

			try {
				const plan = await planMove({ baseDir, from, to });
				const result = applyEditPlan(plan, { baseDir, dryRun: args["dry-run"] === true });

				if (!result.dryRun) {
					await e.refreshIfStale();
				}

				emit(result);
			} catch (error) {
				throw editFailure(error, { file: from, to });
			}
		});
	}
});

const edit = defineCommand({
	meta: { name: "edit", description: "Change code: rename a symbol or move a file across the project" },
	subCommands: { move: editMove, rename: editRename }
});

/** Hidden daemon entry point — spawned detached by daemonEngine, never typed by hand. */
const daemon = defineCommand({
	meta: { hidden: true, name: "_daemon", description: "(internal) run the warm-engine daemon for a tsconfig" },
	args: {
		tsconfig: { type: "string", required: true, description: "Project tsconfig the daemon serves" }
	},
	async run({ args }) {
		const idleRaw = process.env["SYMANTIC_DAEMON_IDLE_MS"];
		const idleMs = idleRaw !== undefined && idleRaw !== "" ? Number(idleRaw) : undefined;
		await runDaemonServer({
			idleMs,
			version: readVersion(),
			tsConfigPath: args.tsconfig
		});
	}
});

const main = defineCommand({
	subCommands: { view, find, edit, gain, usage, resolve, imports, _daemon: daemon, exports: exportsCmd },
	meta: { name: "symantic", version: readVersion(), description: "Semantic symbol queries for TypeScript" }
});

void runCli(main, process.argv.slice(2));
