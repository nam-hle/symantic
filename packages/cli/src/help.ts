/**
 * What `--help` says beyond citty's usage: examples first, the effect of the command, the shape
 * of its `--json` output, and the exit codes. Keyed by the command path ("" is the root).
 */
interface CommandHelp {
	/** Runnable examples with realistic addresses. */
	examples: string[];
	/** The `--json` result shape; absent for commands without `--json`. */
	json?: string;
	/** Overrides the default read-only effect line. */
	changes?: string;
}

const POSITION = "position: { file, line, col }";
const LIST = (item: string, extra = ""): string => `{ items: [${item}], total, next?, hint? }${extra}`;
const CANDIDATE = `{ kind, ${POSITION}, qualifiedName }`;
const HANDLE = `{ ${POSITION}, qualifiedName }`;
const CALL_NODE = `{ ${POSITION}, qualifiedName, calls: [...] }`;

/** Every query appends a gain-ledger line and may start the warm daemon; nothing in the project changes. */
const QUERY_CHANGES =
	"Changes: nothing in the project. Each query appends one line to the gain ledger (~/.symantic/gain.jsonl) and may start a warm background daemon.";

const HELP: Record<string, CommandHelp> = {
	"": {
		examples: ["symantic view outline src/a.ts", "symantic find refs src/a.ts:Foo", "symantic find symbol Foo --contains"]
	},
	view: {
		examples: ["symantic view outline src/a.ts", "symantic view symbol src/a.ts:Foo", "symantic view body src/a.ts:run --source"]
	},
	find: {
		examples: ["symantic find symbol Foo", "symantic find refs src/a.ts:Foo --exclude-tests", "symantic find callers src/a.ts:run --depth 3"]
	},
	resolve: {
		examples: ["symantic resolve src/a.ts:Foo", "symantic resolve src/a.ts:Foo::bar", "symantic resolve src/a.ts:Foo#1"],
		json: `{ kind: "symbol", symbol: ${HANDLE} } or { kind: "ambiguous", candidates: [${CANDIDATE}] }`
	},
	imports: {
		examples: ["symantic imports src/a.ts"],
		json: LIST(`{ module, named: [], default?, namespace?, ${POSITION} }`)
	},
	exports: {
		examples: ["symantic exports src/index.ts", "symantic exports src/index.ts --limit 20 --json"],
		json: LIST(CANDIDATE)
	},
	usage: {
		examples: ["symantic usage src/index.ts", "symantic usage src/index.ts --members --exclude-tests"],
		json: LIST(`{ kind, total, consumed, ${POSITION}, qualifiedName }`)
	},
	"view outline": {
		examples: ["symantic view outline src/a.ts", "symantic view outline src/a.ts --json"],
		json: "{ exports, classes, functions, variables, interfaces, others } (each a list of members: { name, kind, signature, position, exported?, modifiers?, tags?, qualifiedName? })"
	},
	"view file": {
		examples: ["symantic view file src/a.ts", "symantic view file src/a.ts --body"],
		json: "the outline object, or { outline, sources: [{ qualifiedName, position, source }] } with --body"
	},
	"view symbol": {
		examples: ["symantic view symbol src/a.ts:Foo", "symantic view symbol src/a.ts:Foo::bar --json"],
		json: LIST(`{ qualifiedName, ${POSITION}, source }`)
	},
	"view members": {
		examples: ["symantic view members src/a.ts:Foo", "symantic view members src/a.ts:Model::Node"],
		json: LIST(`{ name, kind, signature, ${POSITION}, exported?, modifiers?, tags?, qualifiedName? }`)
	},
	"view body": {
		examples: ["symantic view body src/a.ts:run", "symantic view body src/a.ts:run --depth 2", "symantic view body src/a.ts:run --source"],
		json: LIST(`{ kind, label?, ${POSITION}, children? }`, " (with --source: items are { qualifiedName, position, source })")
	},
	"view region": {
		examples: ["symantic view region src/a.ts:10-30"],
		json: "{ file, startLine, endLine, source }"
	},
	"view context": {
		examples: ["symantic view context src/a.ts:run", "symantic view context src/a.ts:run --json"],
		json: `{ qualifiedName, ${POSITION}, signature, source, typeRefs: [], callees: [${CALL_NODE}] }`
	},
	"find symbol": {
		examples: ["symantic find symbol Foo", "symantic find symbol parse --contains --kind fn,cls --exclude-tests"],
		json: LIST(CANDIDATE)
	},
	"find def": {
		examples: ["symantic find def src/a.ts:Foo", "symantic find def src/a.ts:Foo --json"],
		json: LIST(HANDLE)
	},
	"find refs": {
		examples: ["symantic find refs src/a.ts:Foo", "symantic find refs src/a.ts:Foo --exclude-tests --context snippet --limit 20"],
		json: LIST(`{ kind, test?, context?, ${POSITION} }`)
	},
	"find impls": {
		examples: ["symantic find impls src/a.ts:Shape"],
		json: LIST(HANDLE)
	},
	"find callers": {
		examples: ["symantic find callers src/a.ts:run", "symantic find callers src/a.ts:run --depth 3"],
		json: LIST(CALL_NODE)
	},
	"find callees": {
		examples: ["symantic find callees src/a.ts:run", "symantic find callees src/a.ts:run --depth 3"],
		json: LIST(CALL_NODE)
	},
	gain: {
		examples: ["symantic gain", "symantic gain --by-project", "symantic gain --history"],
		changes: "Changes: nothing. Reads the gain ledger (~/.symantic/gain.jsonl); it does not add a line for itself.",
		json: "{ queries, savedPct, savedTokens, symanticTokens, baselineTokens, topOps: [{ op, count }], byProject?: [...] }"
	}
};

const EXIT_CODE_TABLE = [
	"EXIT CODES",
	"",
	"  0  success (a query that matches nothing is still success)",
	"  1  unexpected error",
	"  2  usage error: unknown flag or command, bad value, ambiguous address",
	"  3  not found: the address, file or project does not exist"
].join("\n");

const section = (title: string, lines: string[]): string => [title, "", ...lines.map((line) => `  ${line}`)].join("\n");

/**
 * Assemble the help page for a command: citty's description line, EXAMPLES, then citty's usage
 * (required arguments are marked there), then the effect, the JSON shape and the exit codes.
 */
export function composeHelp(usage: string, path: string[], isLeaf: boolean): string {
	const help = HELP[path.join(" ")];
	const split = usage.indexOf("\n\n");
	const head = split === -1 ? usage : usage.slice(0, split);
	const rest = split === -1 ? "" : usage.slice(split + 2);
	const examples = help === undefined ? [] : [section("EXAMPLES", help.examples)];
	const trailer =
		isLeaf && help !== undefined ? [help.changes ?? QUERY_CHANGES, ...(help.json === undefined ? [] : [`--json fields: ${help.json}`])] : [];

	return [head, ...examples, rest.trimEnd(), ...trailer, EXIT_CODE_TABLE].filter((part) => part !== "").join("\n\n");
}
