#!/usr/bin/env node
/**
 * symantic MCP server. Exposes the read-only core ops as MCP tools over stdio,
 * holding a warm engine per tsconfig across calls. Thin adapter —
 * no analysis logic. See docs/DESIGN.md Section 1.
 *
 * Tool names group by intent: view_* (read code), find_* (locate/trace), plus
 * top-level resolve/imports/exports/usage_report.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
	Member,
	CallNode,
	Candidate,
	ImportInfo,
	SymbolHandle,
	UsagesResult,
	SourceResult,
	RegionResult,
	ResolveResult,
	StatementNode,
	SymbolContext,
	UsageReportEntry,
	AsyncSymbolEngine
} from "@symantic/core";
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
	renderUsageReport,
	renderFileOutline,
	renderCallHierarchy
} from "@symantic/core";

import { readVersion } from "./version.js";
import { EnginePool } from "./engine-pool.js";

type ToolResult = { content: { type: "text"; text: string }[] };

/**
 * The warm-engine pool: bounds the cache, serializes per-engine calls, and disposes on
 * shutdown. See engine-pool.ts (epic #84 / M3).
 */
const pool = new EnginePool();

/** The engine for a tsconfig, serialized per engine. */
function engineFor(tsConfig: string): AsyncSymbolEngine {
	return pool.engineFor(tsConfig);
}

function json(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function text(value: string): ToolResult {
	return { content: [{ text: value, type: "text" }] };
}

/** Text content by default, or pretty JSON when jsonFlag is set. */
function out(value: unknown, rendered: string, jsonFlag: boolean | undefined): ToolResult {
	return jsonFlag === true ? json(value) : text(rendered);
}

/** Guard: distinguishes a ResolveResult (not-found/ambiguous) from an op result. */
function isResolveResult(x: unknown): x is ResolveResult {
	return (
		typeof x === "object" && x !== null && "kind" in x && ((x as ResolveResult).kind === "not-found" || (x as ResolveResult).kind === "ambiguous")
	);
}

/** Resolve a symbol then run an op; if not a single symbol, return the resolve result. */
async function resolveOr(
	tc: string,
	qualifiedName: string,
	op: (engine: AsyncSymbolEngine, symbol: SymbolHandle) => Promise<unknown>
): Promise<unknown | ResolveResult> {
	const engine = engineFor(tc);
	const result = await engine.resolveSymbol(qualifiedName);

	return result.kind === "symbol" ? op(engine, result.symbol) : result;
}

const tsConfig = z.string().describe("Path to the project tsconfig.json");
const symbolArg = z.string().describe("Qualified name: relPath:Name (dotted for namespaces/members, Name#index to disambiguate)");
const fileArg = z.string().describe("Source file path, relative to the tsconfig directory");
const jsonArg = z.boolean().optional().describe("Return structured JSON instead of text");

const server = new McpServer({ name: "symantic", version: readVersion() });

/** The superset of arguments any symantic tool accepts (all optional; per-tool schema validates). */
interface ToolArgs {
	name?: string;
	file?: string;
	json?: boolean;
	limit?: number;
	depth?: number;
	symbol?: string;
	cursor?: string;
	tsConfig: string;
	endLine?: number;
	contains?: boolean;
	startLine?: number;
	excludeTests?: boolean;
	direction?: "incoming" | "outgoing";
	context?: "none" | "snippet" | "block";
}

interface ToolSchema {
	description: string;
	inputSchema: Record<string, z.ZodTypeAny>;
}

type RegisterTool = (name: string, schema: ToolSchema, handler: (args: ToolArgs) => ToolResult | Promise<ToolResult>) => void;

/**
 * Register a tool under one or more names. The SDK's registerTool is generic over the exact
 * zod shape; we widen to a uniform (ToolArgs) handler here — each tool's own inputSchema still
 * validates args at the protocol boundary.
 */
const register = server.registerTool.bind(server) as unknown as RegisterTool;

/** The removed `engine` argument: accepted by the schema only to reject it with a clear message. */
const removedEngineArg = z.never({ message: "engine was removed: symantic has a single engine now" }).optional().describe("Removed; do not pass");

function tool(names: string[], schema: ToolSchema, handler: (args: ToolArgs) => ToolResult | Promise<ToolResult>): void {
	for (const name of names) {
		register(name, { ...schema, inputSchema: { ...schema.inputSchema, engine: removedEngineArg } }, handler);
	}
}

// ---- top-level: addressing + whole-file facts ----

tool(
	["resolve"],
	{
		inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg },
		description: "Resolve a qualified name to a symbol, or candidates if ambiguous."
	},
	async ({ symbol, json: j, tsConfig: tc }) => {
		const r = await engineFor(tc).resolveSymbol(symbol!);

		return out(r, renderResolve(r), j);
	}
);

tool(
	["imports"],
	{ inputSchema: { tsConfig, file: fileArg, json: jsonArg }, description: "The import statements of a file (module wiring)." },
	async ({ file, json: j, tsConfig: tc }) => {
		const r = await engineFor(tc).listImports(file!);

		return out(r, renderImports(r as ImportInfo[]), j);
	}
);

tool(
	["exports"],
	{
		inputSchema: { tsConfig, file: fileArg, json: jsonArg },
		description: "Transitive public surface of an entry file (expands export *)."
	},
	async ({ file, json: j, tsConfig: tc }) => {
		const r = await engineFor(tc).publicSurface(file!);

		return out(r, renderCandidates(r as Candidate[]), j);
	}
);

tool(
	["usage_report"],
	{
		inputSchema: { tsConfig, file: fileArg, json: jsonArg, excludeTests: z.boolean().optional() },
		description: "Each public symbol of an entry with its reference counts (for dead-code analysis)."
	},
	async ({ file, json: j, tsConfig: tc, excludeTests }) => {
		const r = await engineFor(tc).usageReport(file!, { excludeTests });

		return out(r, renderUsageReport(r as UsageReportEntry[]), j);
	}
);

// ---- view: read code (structure + source) ----

tool(
	["view_outline"],
	{
		inputSchema: { tsConfig, file: fileArg, json: jsonArg },
		description: "Structural outline of a file (compact tree by default; full JSON with json=true)."
	},
	async ({ file, json: j, tsConfig: tc }) => {
		const outline = await engineFor(tc).outlineFile(file!);

		return out(outline, renderFileOutline(file!, outline), j);
	}
);

tool(
	["view_symbol"],
	{
		inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg },
		description: "Exact source of a declaration (signature + body)."
	},
	async ({ symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.symbolSource(s));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderSource(r as SourceResult[]), j);
	}
);

tool(
	["view_context"],
	{
		inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg },
		description: "Source + signature + outgoing callees + referenced type names."
	},
	async ({ symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.symbolContext(s));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderContext(r as SymbolContext), j);
	}
);

tool(
	["view_region"],
	{
		description: "A verbatim file slice by 1-based inclusive line range.",
		inputSchema: { tsConfig, file: fileArg, json: jsonArg, endLine: z.number(), startLine: z.number() }
	},
	async ({ file, endLine, json: j, startLine, tsConfig: tc }) => {
		const r = await engineFor(tc).readRegion(file!, startLine!, endLine!);

		return out(r, renderRegion(r as RegionResult), j);
	}
);

tool(
	["view_members"],
	{ description: "Members of a class / interface / namespace.", inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg } },
	async ({ symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.outlineSymbol(s));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderMembers(r as Member[]), j);
	}
);

tool(
	["view_body"],
	{
		description: "Statement-level skeleton of a function body.",
		inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg, depth: z.number().optional() }
	},
	async ({ depth, symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.outlineFunction(s, { depth }));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderStatements(r as StatementNode[]), j);
	}
);

// ---- find: locate + trace ----

tool(
	["find_symbol"],
	{
		inputSchema: { tsConfig, json: jsonArg, name: z.string(), contains: z.boolean().optional() },
		description: "Find a symbol by name across the whole project (exact, or substring with contains)."
	},
	async ({ name, json: j, contains, tsConfig: tc }) => {
		const r = await engineFor(tc).searchSymbol(name!, { contains });

		return out(r, renderCandidates(r as Candidate[]), j);
	}
);

tool(
	["find_def"],
	{ description: "Find the declaration site(s) of a symbol.", inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg } },
	async ({ symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.findDefinition(s));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderHandles(r as SymbolHandle[]), j);
	}
);

tool(
	["find_refs"],
	{
		description: "Find references to a symbol, classified by kind; optionally exclude tests or attach context.",
		inputSchema: {
			tsConfig,
			json: jsonArg,
			symbol: symbolArg,
			limit: z.number().optional(),
			cursor: z.string().optional(),
			excludeTests: z.boolean().optional(),
			context: z.enum(["none", "snippet", "block"]).optional().describe("Surrounding source per ref (default none)")
		}
	},
	async ({ limit, symbol, cursor, context, json: j, tsConfig: tc, excludeTests }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.findUsages(s, { limit, cursor, context, excludeTests }));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderReferences(r as UsagesResult), j);
	}
);

tool(
	["find_impls"],
	{ description: "Find implementations of an interface.", inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg } },
	async ({ symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.findImplementations(s));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderHandles(r as SymbolHandle[]), j);
	}
);

tool(
	["find_callers"],
	{
		description: "Incoming call hierarchy: who calls this symbol, to a depth.",
		inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg, depth: z.number().optional() }
	},
	async ({ depth, symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.callHierarchy(s, { depth, direction: "incoming" }));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderCallHierarchy(r as CallNode[]), j);
	}
);

tool(
	["find_callees"],
	{
		description: "Outgoing call hierarchy: what this symbol calls, to a depth.",
		inputSchema: { tsConfig, json: jsonArg, symbol: symbolArg, depth: z.number().optional() }
	},
	async ({ depth, symbol, json: j, tsConfig: tc }) => {
		const r = await resolveOr(tc, symbol!, (e, s) => e.callHierarchy(s, { depth, direction: "outgoing" }));

		return out(r, isResolveResult(r) ? renderResolve(r) : renderCallHierarchy(r as CallNode[]), j);
	}
);

// Dispose warm engines (and their compiler subprocess) on shutdown.
function shutdownOn(signal: "SIGINT" | "SIGTERM"): void {
	process.once(signal, () => {
		void pool.disposeAll().finally(() => {
			// Re-raise with no listener so Node's default terminates the process (avoids process.exit).
			process.kill(process.pid, signal);
		});
	});
}

shutdownOn("SIGINT");
shutdownOn("SIGTERM");

await server.connect(new StdioServerTransport());
