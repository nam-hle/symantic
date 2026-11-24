#!/usr/bin/env node
/**
 * symantic CLI adapter. Translates CLI args <-> @symantic/core calls and prints
 * results. No analysis logic. See docs/DESIGN.md Section 1.
 *
 * Commands group by agent intent: `view` (read code) and `find` (locate/trace),
 * plus top-level addressing / whole-file facts.
 */
import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import { NS_SEP, createEngine } from "@symantic/core";
import type { SymbolHandle, AsyncSymbolEngine } from "@symantic/core";
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

		throw error;
	} finally {
		await engineInstance.dispose();
	}
}

/** Resolve a name to a single symbol, or throw NOT_FOUND / AMBIGUOUS carrying the engine's hint or candidates. */
async function resolveSymbolOrThrow(engineInstance: AsyncSymbolEngine, qualifiedName: string): Promise<SymbolHandle> {
	const result = await engineInstance.resolveSymbol(qualifiedName);

	if (result.kind === "symbol") {
		return result.symbol;
	}

	if (result.kind === "not-found") {
		const suggestions = result.suggestions ?? [];
		const suggestionHint = suggestions.length > 0 ? `did you mean: ${suggestions.join(", ")}` : undefined;

		throw new SymanticError("NOT_FOUND", `not found: ${qualifiedName}`, {
			hint: result.hint ?? suggestionHint,
			context: { symbol: qualifiedName, suggestions }
		});
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
			output({ tsconfig: tc, op: "imports" }, imps, () => renderImports(imps), args.json);
		});
	}
});

const exportsCmd = defineCommand({
	args: { json, tsconfig, file: fileArg },
	meta: { name: "exports", description: "Transitive public surface of an entry file (expands export *)" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const surf = await e.publicSurface(args.file);
			output({ tsconfig: tc, op: "exports" }, surf, () => renderCandidates(surf), args.json);
		});
	}
});

const usage = defineCommand({
	meta: { name: "usage", description: "Usage report: each public symbol of an entry with its reference counts" },
	args: {
		json,
		tsconfig,
		file: fileArg,
		"exclude-tests": { type: "boolean", description: "Omit references in test files" },
		members: { type: "boolean", description: "Also report class/interface member ref counts (Owner::member), not just top-level exports" }
	},
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const report = await e.usageReport(args.file, { members: args.members === true, excludeTests: args["exclude-tests"] === true });
			output({ op: "usage", tsconfig: tc }, report, () => renderUsageReport(report), args.json);
		});
	}
});

// ---- view: read code (structure + source) ----

const viewOutline = defineCommand({
	meta: { name: "outline", description: "Outline the structure of a file (compact tree; --json for full)" },
	args: { tsconfig, file: fileArg, json: { type: "boolean", description: "Emit full JSON instead of the compact tree" } },
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
			output({ tsconfig: tc, op: "view symbol" }, src, () => renderSource(src), args.json);
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
			output({ tsconfig: tc, op: "view members" }, members, () => renderMembers(members), args.json);
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
				output({ tsconfig: tc, op: "view body" }, src, () => renderSource(src), args.json);

				return;
			}

			const stmts = await e.outlineFunction(symbol, { depth });
			output({ tsconfig: tc, op: "view body" }, stmts, () => renderStatements(stmts), args.json);

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
		contains: {
			type: "boolean",
			description: "Match the name as a substring (case-insensitive) — the orientation entry point when you only know part of a name"
		}
	},
	async run({ args }) {
		const kinds = kindList(args.kind);

		await withEngine(args, async (e, tc) => {
			const cands = await e.searchSymbol(args.name, {
				kinds,
				contains: args.contains,
				excludeTests: args["exclude-tests"] === true,
				path: typeof args.path === "string" ? args.path : undefined
			});
			output({ tsconfig: tc, op: "find symbol" }, cands, () => renderCandidates(cands), args.json);

			if (cands.length === 0 && args.json !== true) {
				if (looksLikeFile(args.name)) {
					process.stderr.write(`hint: "${args.name}" looks like a file, not a symbol — try \`view outline <file>\` to list its declarations\n`);
				} else if (args.contains !== true) {
					process.stderr.write(`hint: no exact match for "${args.name}" — retry with --contains for substring search\n`);
				}
			}
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
			output({ tsconfig: tc, op: "find def" }, handles, () => renderHandles(handles), args.json);
		});
	}
});

const findRefs = defineCommand({
	meta: { name: "refs", description: "Find usages of a symbol" },
	args: {
		json,
		tsconfig,
		symbol: symbolArg,
		cursor: { type: "string", description: "Pagination cursor: a non-negative integer offset" },
		limit: { type: "string", description: "Max references to return, a positive integer" },
		"exclude-tests": { type: "boolean", description: "Omit references in test files" },
		context: { type: "enum", options: ["none", "snippet", "block"], description: "Surrounding source per ref (default none)" }
	},
	async run({ args }) {
		const cursor = nonNegativeInt("cursor", args.cursor);
		const limit = positiveInt("limit", args.limit);

		await withEngine(args, async (e, tc) => {
			const symbol = await resolveSymbolOrThrow(e, args.symbol);
			const usages = await e.findUsages(symbol, {
				limit,
				context: args.context,
				cursor: cursor === undefined ? undefined : String(cursor),
				excludeTests: args["exclude-tests"] === true
			});
			output({ tsconfig: tc, op: "find refs" }, usages, () => renderReferences(usages), args.json);
		});
	}
});

const findImpls = defineCommand({
	args: { json, tsconfig, symbol: symbolArg },
	meta: { name: "impls", description: "Find implementations of an interface" },
	async run({ args }) {
		await withEngine(args, async (e, tc) => {
			const handles = await e.findImplementations(await resolveSymbolOrThrow(e, args.symbol));
			output({ tsconfig: tc, op: "find impls" }, handles, () => renderHandles(handles), args.json);
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
			output({ tsconfig: tc, op: "find callers" }, tree, () => renderCallHierarchy(tree), args.json);
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
			output({ tsconfig: tc, op: "find callees" }, tree, () => renderCallHierarchy(tree), args.json);
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
	subCommands: { view, find, gain, usage, resolve, imports, _daemon: daemon, exports: exportsCmd },
	meta: { name: "symantic", version: readVersion(), description: "Semantic symbol queries for TypeScript" }
});

void runCli(main, process.argv.slice(2));
