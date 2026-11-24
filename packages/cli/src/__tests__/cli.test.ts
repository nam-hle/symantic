import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
/**
 * Integration tests for the symantic CLI adapter.
 *
 * Tests spawn the built binary (packages/cli/dist/index.js) as a child process.
 * Prerequisite: `pnpm build` must have been run before executing these tests.
 * The nadle `testUnit` task depends on `build`, so this is guaranteed in CI.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";

import { it, expect, describe } from "vitest";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the CLI entry point built artifact. */
const CLI_BIN = join(__dirname, "..", "..", "dist", "index.js");

/** Absolute path to the sample fixture tsconfig. */
const TSCONFIG = join(__dirname, "..", "..", "..", "core", "src", "__tests__", "fixtures", "sample", "tsconfig.json");

/** Run the CLI with the given args (optionally from `cwd`), returning stdout, stderr, exit code. */
async function run(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		// Daemon-free: these tests exercise the in-process path; daemon behavior is covered in daemon.test.ts.
		const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
			cwd,
			timeout: 20_000,
			env: { ...process.env, SYMANTIC_NO_DAEMON: "1" }
		});

		return { stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };

		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			code: typeof err.code === "number" ? err.code : 1
		};
	}
}

/** The sample fixture directory (contains tsconfig.json) — for tsconfig auto-discovery. */
const FIXTURE_DIR = join(__dirname, "..", "..", "..", "core", "src", "__tests__", "fixtures", "sample");

/**
 * Run the CLI with the home dir pointed at `home` so the gain ledger lands in an
 * isolated dir. `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere,
 * so set both.
 */
async function runWithHome(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
			timeout: 20_000,
			env: { ...process.env, HOME: home, USERPROFILE: home, SYMANTIC_NO_DAEMON: "1" }
		});

		return { stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };

		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: typeof err.code === "number" ? err.code : 1 };
	}
}

/** Run the CLI with colour-suppressing env vars removed, as a plain pipe would see it. */
async function runPiped(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, SYMANTIC_NO_DAEMON: "1" };
	delete env["NO_COLOR"];
	delete env["TERM"];
	delete env["TEST"];
	delete env["CI"];

	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], { env, timeout: 20_000 });

		return { stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };

		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: typeof err.code === "number" ? err.code : 1 };
	}
}

const ESC = String.fromCharCode(27);

describe("CLI integration", () => {
	describe("output off a terminal", () => {
		it("prints no ANSI escape on stdout or stderr when piped", async () => {
			const help = await runPiped(["--help"]);
			const bogus = await runPiped(["bogus"]);

			expect(help.stdout).not.toContain(ESC);
			expect(bogus.stdout).not.toContain(ESC);
			expect(bogus.stderr).not.toContain(ESC);
		}, 20_000);

		it("sends the usage text of a failed parse to stderr, not stdout", async () => {
			const { code, stdout, stderr } = await runPiped(["bogus"]);

			expect(code).toBe(2);
			expect(stdout).toBe("");
			expect(stderr).not.toContain("USAGE");
			expect(stderr).toContain("Unknown command");
		}, 20_000);

		it("treats --help beside an unknown command as a failed parse, and ignores --help after --", async () => {
			const bogus = await runPiped(["bogus", "--help"]);
			const nested = await runPiped(["find", "bogus", "--help"]);
			const terminated = await runPiped(["find", "--", "--help"]);

			for (const result of [bogus, nested, terminated]) {
				expect(result.code).not.toBe(0);
				expect(result.stdout).toBe("");
			}
		}, 30_000);

		it("keeps --help usage on stdout with exit 0", async () => {
			const { code, stdout } = await runPiped(["find", "--help"]);

			expect(code).toBe(0);
			expect(stdout).toContain("USAGE");
		}, 20_000);
	});

	describe("flag validation", () => {
		const REFS = ["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle"];

		it("rejects an unknown flag instead of ignoring it", async () => {
			const refs = await run([...REFS, "--bogus"]);
			const gainRun = await run(["gain", "--bogus"]);

			expect(refs.code).toBe(2);
			expect(refs.stderr).toContain("Unknown option --bogus");
			expect(refs.stdout).toBe("");
			expect(gainRun.code).toBe(2);
			expect(gainRun.stderr).toContain("Unknown option --bogus");
		}, 20_000);

		it("still accepts known flags in every spelling", async () => {
			const spaced = await run([...REFS, "--limit", "1"]);
			const equals = await run([...REFS, "--limit=1"]);
			const negated = await run([...REFS, "--no-json"]);

			expect([spaced.code, equals.code, negated.code]).toEqual([0, 0, 0]);
		}, 30_000);

		it.each(["abc", "0", "-3", "1.5"])(
			"rejects --limit %s naming the flag and the value",
			async (value) => {
				const { code, stdout, stderr } = await run([...REFS, "--limit", value]);

				expect(code).toBe(2);
				expect(stdout).toBe("");
				expect(stderr).toContain("--limit");
				expect(stderr).toContain(`"${value}"`);
				expect(stderr).toContain("positive integer");
			},
			20_000
		);

		it("rejects a junk --cursor but accepts 0", async () => {
			const bad = await run([...REFS, "--cursor", "abc"]);
			const zero = await run([...REFS, "--cursor", "0"]);

			expect(bad.code).toBe(2);
			expect(bad.stderr).toContain("--cursor");
			expect(zero.code).toBe(0);
		}, 20_000);

		it("rejects --depth abc on view body and find callers", async () => {
			const body = await run(["view", "body", "--tsconfig", TSCONFIG, "src/consumer.ts:totalArea", "--depth", "abc"]);
			const callers = await run(["find", "callers", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle", "--depth", "abc"]);

			expect(body.code).toBe(2);
			expect(body.stderr).toContain("--depth");
			expect(callers.code).toBe(2);
			expect(callers.stderr).toContain("--depth");
		}, 20_000);

		it("rejects --context outside none|snippet|block and lists the allowed values", async () => {
			const { code, stderr } = await run([...REFS, "--context", "weird"]);

			expect(code).toBe(2);
			expect(stderr).toContain("--context");
			expect(stderr).toContain("weird");
			expect(stderr).toContain("snippet");
		}, 20_000);

		it("rejects an unknown --kind and lists the allowed values", async () => {
			const { code, stderr } = await run(["find", "symbol", "--tsconfig", TSCONFIG, "makeCircle", "--kind", "fn,bogus"]);

			expect(code).toBe(2);
			expect(stderr).toContain("--kind");
			expect(stderr).toContain("bogus");
			expect(stderr).toContain("iface");
		}, 20_000);

		it("accepts a valid --kind list", async () => {
			const { code, stdout } = await run(["find", "symbol", "--tsconfig", TSCONFIG, "makeCircle", "--kind", "fn, cls"]);

			expect(code).toBe(0);
			expect(stdout).toContain("makeCircle");
		}, 20_000);

		it("shows the allowed values in --help", async () => {
			const refs = await run(["find", "refs", "--help"]);
			const symbol = await run(["find", "symbol", "--help"]);

			expect(refs.stdout).toContain("none|snippet|block");
			expect(symbol.stdout).toContain("iface");
		}, 20_000);
	});

	describe("error envelope", () => {
		interface Envelope {
			hint: string;
			code: string;
			status: string;
			message: string;
			context: Record<string, unknown>;
		}

		const envelopeOf = (stderr: string): Envelope => JSON.parse(stderr) as Envelope;

		it("reports a symbol that does not resolve as NOT_FOUND, exit 3", async () => {
			const { code, stdout, stderr } = await run(["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:Nope", "--json"]);
			const envelope = envelopeOf(stderr);

			expect([code, stdout]).toEqual([3, ""]);
			expect(envelope).toMatchObject({ status: "error", code: "NOT_FOUND", context: { symbol: "src/shapes.ts:Nope" } });
			expect(envelope.hint).not.toBe("");
		}, 20_000);

		it("reports an ambiguous symbol as AMBIGUOUS with its candidates, exit 2", async () => {
			const { code, stderr } = await run(["find", "refs", "--tsconfig", TSCONFIG, "src/dup.ts:thing", "--json"]);
			const envelope = envelopeOf(stderr);

			expect(code).toBe(2);
			expect(envelope.code).toBe("AMBIGUOUS");
			expect((envelope.context["candidates"] as { qualifiedName: string }[]).map((c) => c.qualifiedName)).toEqual([
				"src/dup.ts:thing#0",
				"src/dup.ts:thing#1"
			]);
			expect(envelope.hint).toContain("src/dup.ts:thing#0");
		}, 20_000);

		it("prints ambiguity as one line plus a hint in text mode", async () => {
			const { stderr } = await run(["find", "refs", "--tsconfig", TSCONFIG, "src/dup.ts:thing"]);

			expect(stderr.trim().split("\n")).toHaveLength(2);
			expect(stderr).toMatch(/^error: .*ambiguous/);
			expect(stderr).toContain("hint: retry with one of: src/dup.ts:thing#0");
			expect(stderr).not.toContain('"kind"');
		}, 20_000);

		it("reports a missing tsconfig as NO_PROJECT, exit 3", async () => {
			const { code, stderr } = await run(["find", "refs", "--tsconfig", "/nonexistent/tsconfig.json", "a.ts:A", "--json"]);

			expect(code).toBe(3);
			expect(envelopeOf(stderr)).toMatchObject({ code: "NO_PROJECT", context: { tsconfig: "/nonexistent/tsconfig.json" } });
		}, 20_000);

		it("reports a malformed region as VALIDATION_ERROR naming the value, exit 2", async () => {
			const { code, stderr } = await run(["view", "region", "--tsconfig", TSCONFIG, "src/shapes.ts:bad", "--json"]);

			expect(code).toBe(2);
			expect(envelopeOf(stderr)).toMatchObject({ code: "VALIDATION_ERROR", context: { argument: "target", value: "src/shapes.ts:bad" } });
		}, 20_000);

		it.each([
			["resolve", ["resolve", "noColon"]],
			["resolve with a bad index", ["resolve", "src/shapes.ts:Circle#abc"]],
			["view symbol with an empty segment", ["view", "symbol", "src/shapes.ts:Circle::#x"]]
		])(
			"reports a malformed qualified name (%s) as VALIDATION_ERROR with the syntax as hint",
			async (_name, command) => {
				const direct = await run([...command, "--tsconfig", TSCONFIG, "--json"]);

				expect(direct.code).toBe(2);
				expect(envelopeOf(direct.stderr)).toMatchObject({ code: "VALIDATION_ERROR" });
				expect(envelopeOf(direct.stderr).hint).toContain('syntax: "relativePath:Name"');
				expect(envelopeOf(direct.stderr).message).not.toContain("syntax:");
			},
			20_000
		);

		it.each(["50-10", "0-5", "5-0"])(
			"reports the region range %s as VALIDATION_ERROR naming the value",
			async (range) => {
				const { code, stderr } = await run(["view", "region", "--tsconfig", TSCONFIG, `src/shapes.ts:${range}`, "--json"]);

				expect(code).toBe(2);
				expect(envelopeOf(stderr)).toMatchObject({ code: "VALIDATION_ERROR", context: { argument: "target", value: `src/shapes.ts:${range}` } });
			},
			20_000
		);

		it("words the region address as file:start-end", async () => {
			const bad = await run(["view", "region", "--tsconfig", TSCONFIG, "src/shapes.ts:bad"]);
			const help = await run(["view", "region", "--help"]);

			expect(bad.stderr).toContain("src/a.ts:10-30");
			expect(`${help.stdout}${bad.stderr}`).not.toContain("Lstart-Lend");
		}, 20_000);

		it.each([["--json=true"], ["--json=1"], ["--json"]])(
			"emits the error as JSON under %s, as the success path would",
			async (flag) => {
				const { stderr } = await run(["find", "refs", "src/shapes.ts:Circle", "--tsconfig", TSCONFIG, "--limit", "abc", flag]);

				expect(envelopeOf(stderr)).toMatchObject({ code: "VALIDATION_ERROR" });
			},
			20_000
		);

		it.each([["--json=false"], ["--json=0"], ["--no-json"]])(
			"emits the error as text under %s",
			async (flag) => {
				const { stderr } = await run(["find", "refs", "src/shapes.ts:Circle", "--tsconfig", TSCONFIG, "--limit", "abc", flag]);

				expect(stderr).toMatch(/^error: /);
			},
			20_000
		);

		it("answers --help beside an unknown command with UNKNOWN_COMMAND and availableCommands", async () => {
			const { code, stdout, stderr } = await run(["find", "bogus", "--help", "--json"]);

			expect([code, stdout]).toEqual([2, ""]);
			expect(envelopeOf(stderr)).toMatchObject({ code: "UNKNOWN_COMMAND", context: { command: "bogus" } });
			expect(envelopeOf(stderr).context["availableCommands"]).toContain("refs");
		}, 20_000);

		it("reports a bad flag value and an unknown flag with the offending input", async () => {
			const limit = await run(["find", "refs", "src/a.ts:A", "--limit", "abc", "--json"]);
			const unknown = await run(["find", "refs", "src/a.ts:A", "--bogus", "--json"]);

			expect(envelopeOf(limit.stderr)).toMatchObject({ code: "VALIDATION_ERROR", context: { flag: "limit", value: "abc" } });
			expect(envelopeOf(unknown.stderr)).toMatchObject({ code: "UNKNOWN_OPTION", context: { option: "--bogus" } });
			expect([limit.code, unknown.code]).toEqual([2, 2]);
		}, 20_000);

		it("lists availableCommands for a group without a verb, with nothing on stdout", async () => {
			const { code, stdout, stderr } = await run(["find", "--json"]);
			const envelope = envelopeOf(stderr);

			expect([code, stdout]).toEqual([2, ""]);
			expect(envelope.code).toBe("MISSING_COMMAND");
			expect(envelope.context["availableCommands"]).toEqual(expect.arrayContaining(["refs", "def", "symbol"]));
		}, 20_000);

		it("lists availableCommands for an unknown command, hiding internal ones", async () => {
			const { code, stderr } = await run(["bogus", "--json"]);
			const envelope = envelopeOf(stderr);

			expect(code).toBe(2);
			expect(envelope).toMatchObject({ code: "UNKNOWN_COMMAND", context: { command: "bogus" } });
			expect(envelope.context["availableCommands"]).toContain("view");
			expect(envelope.context["availableCommands"]).not.toContain("_daemon");
		}, 20_000);

		it("reports a missing positional as VALIDATION_ERROR, exit 2, in text mode too", async () => {
			const json = await run(["find", "refs", "--json"]);
			const text = await run(["find", "refs"]);

			expect(json.code).toBe(2);
			expect(envelopeOf(json.stderr)).toMatchObject({ code: "VALIDATION_ERROR", context: { argument: "SYMBOL" } });
			expect(text.stdout).toBe("");
			expect(text.stderr).toContain("hint:");
		}, 20_000);

		it("documents the exit codes in --help", async () => {
			const { code, stdout } = await run(["--help"]);

			expect(code).toBe(0);
			expect(stdout).toContain("EXIT CODES");
			expect(stdout).toMatch(/2 {2}usage error/);
			expect(stdout).toMatch(/3 {2}not found/);
		}, 20_000);
	});

	describe("--engine (removed)", () => {
		it("fails clearly instead of silently ignoring the flag", async () => {
			const { code, stderr } = await run(["resolve", "--tsconfig", TSCONFIG, "--engine", "lsp", "src/shapes.ts:makeCircle"]);

			expect(code).toBe(2);
			expect(stderr).toContain("--engine was removed");
		}, 20_000);
	});

	describe("resolve", () => {
		it("resolves a known symbol and prints text by default", async () => {
			const { code, stdout } = await run(["resolve", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle"]);

			expect(code).toBe(0);
			expect(stdout).toContain("src/shapes.ts:makeCircle");
			expect(stdout).not.toContain('"kind"'); // no JSON field names
		}, 20_000);

		it("resolve --json returns JSON kind:symbol", async () => {
			const { code, stdout } = await run(["resolve", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle", "--json"]);

			expect(code).toBe(0);
			const result = JSON.parse(stdout) as { kind: string };
			expect(result.kind).toBe("symbol");
		}, 20_000);

		it("returns kind:not-found for an unknown symbol (exit 0)", async () => {
			const { code, stdout } = await run(["resolve", "--tsconfig", TSCONFIG, "src/shapes.ts:Nope"]);

			// resolve always emits text and exits 0 — it's a query result, not an error
			expect(code).toBe(0);
			expect(stdout).toContain("not found");
		}, 20_000);
	});

	describe("def (definition)", () => {
		it("returns non-zero exit and clean stderr (no stack trace) for a missing symbol", async () => {
			const { code, stderr } = await run(["find", "def", "--tsconfig", TSCONFIG, "src/shapes.ts:Nope"]);

			expect(code).toBe(3);
			// Clean error: no "at " stack trace frames
			expect(stderr).not.toMatch(/\bat\s+\S/);
		}, 20_000);
	});

	describe("view family", () => {
		it("view outline prints the compact tree", async () => {
			const { code, stdout } = await run(["view", "outline", "--tsconfig", TSCONFIG, "src/shapes.ts"]);

			expect(code).toBe(0);
			expect(stdout).toContain("Circle");
		}, 20_000);

		it("view symbol prints source verbatim (no escaped newlines) by default", async () => {
			const { code, stdout } = await run(["view", "symbol", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle"]);

			expect(code).toBe(0);
			expect(stdout).toContain("export function makeCircle");
			expect(stdout).not.toContain("\\n"); // real newlines, not escaped
		}, 20_000);

		it("view region prints a line range", async () => {
			const { code, stdout } = await run(["view", "region", "--tsconfig", TSCONFIG, "src/shapes.ts:1-3"]);

			expect(code).toBe(0);
			expect(stdout).toContain("Shape");
		}, 20_000);

		it("view context prints labeled sections by default", async () => {
			const { code, stdout } = await run(["view", "context", "--tsconfig", TSCONFIG, "src/consumer.ts:totalArea"]);

			expect(code).toBe(0);
			expect(stdout).toContain("sig:");
			expect(stdout).toContain("types:");
			expect(stdout).toContain("Circle");
			expect(stdout).not.toContain('"qualifiedName"'); // no JSON field names
		}, 20_000);

		it("view context --json returns structured JSON", async () => {
			const { code, stdout } = await run(["view", "context", "--tsconfig", TSCONFIG, "src/consumer.ts:totalArea", "--json"]);

			expect(code).toBe(0);
			const ctx = JSON.parse(stdout) as { typeRefs: string[]; callees: unknown[] };
			expect(ctx.typeRefs).toContain("Circle");
			expect(Array.isArray(ctx.callees)).toBe(true);
		}, 20_000);

		it("view file --body prints each export's source", async () => {
			const { code, stdout } = await run(["view", "file", "--tsconfig", TSCONFIG, "src/nested.ts", "--body"]);

			expect(code).toBe(0);
			expect(stdout).toContain("export namespace Model");
		}, 20_000);

		it("view file --body prints each namespace member exactly once", async () => {
			const { code, stdout } = await run(["view", "file", "--tsconfig", TSCONFIG, "src/nested.ts", "--body"]);

			expect(code).toBe(0);
			// Members nested in namespaces appear only inside their namespace's source,
			// never re-printed standalone.
			expect(stdout.match(/deep: boolean/g)).toHaveLength(1);
			expect(stdout.match(/live: boolean/g)).toHaveLength(1);
		}, 20_000);

		it("view body --source prints the function source instead of the skeleton", async () => {
			const { code, stdout } = await run(["view", "body", "--tsconfig", TSCONFIG, "src/consumer.ts:totalArea", "--source"]);

			expect(code).toBe(0);
			expect(stdout).toContain("export function totalArea");
			expect(stdout).not.toContain("ForStatement"); // skeleton node kinds absent
		}, 20_000);

		it("view body hints at --source when the skeleton is short", async () => {
			const { code, stderr } = await run(["view", "body", "--tsconfig", TSCONFIG, "src/consumer.ts:describeArea"]);

			expect(code).toBe(0);
			expect(stderr).toContain("--source");
		}, 20_000);
	});

	describe("find family", () => {
		it("find callees lists outgoing calls (exit 0)", async () => {
			const { code } = await run(["find", "callees", "--tsconfig", TSCONFIG, "src/consumer.ts:totalArea"]);

			expect(code).toBe(0);
		}, 20_000);

		it("find symbol searches by name", async () => {
			const { code, stdout } = await run(["find", "symbol", "--tsconfig", TSCONFIG, "makeCircle"]);

			expect(code).toBe(0);
			expect(stdout).toContain("makeCircle");
		}, 20_000);

		it("find symbol hints toward view outline for a filename-shaped query", async () => {
			const { code, stderr } = await run(["find", "symbol", "--tsconfig", TSCONFIG, "some-missing-module"]);

			expect(code).toBe(0);
			expect(stderr).toContain("view outline");
		}, 20_000);

		it("find def hints toward :: when a member is addressed with a dot (#101)", async () => {
			const { code, stderr } = await run(["find", "def", "--tsconfig", TSCONFIG, "src/nested.ts:Model.Node"]);

			expect(code).toBe(3);
			expect(stderr).toContain("Model::Node");
			expect(stderr).toContain("::");
		}, 20_000);

		it("find def follows an import from an external module to its declaration (#100)", async () => {
			const { code, stdout } = await run(["find", "def", "--tsconfig", TSCONFIG, "src/external.ts:Node"]);

			expect(code).toBe(0);
			expect(stdout).toContain("ast.d.ts");
		}, 20_000);

		it("find refs prints address-first text by default", async () => {
			const { code, stdout } = await run(["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle"]);

			expect(code).toBe(0);
			expect(stdout).toMatch(/^src\/ {2}\(\d+\)$/m); // per-dir group header with count
			expect(stdout).toMatch(/^ {2}consumer\.ts:\d+:\d+\t/m); // indented basename row, addr<TAB>kind
			expect(stdout).not.toContain('"references"'); // no JSON field names
		}, 20_000);

		it("find refs --json prints structured JSON", async () => {
			const { code, stdout } = await run(["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle", "--json"]);

			expect(code).toBe(0);
			const parsed = JSON.parse(stdout) as { references: unknown[] };
			expect(Array.isArray(parsed.references)).toBe(true);
		}, 20_000);
	});

	describe("--version", () => {
		it("prints the package version (semver), not 0.0.0", async () => {
			const { code, stdout } = await run(["--version"]);

			expect(code).toBe(0);
			expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
			expect(stdout.trim()).not.toBe("0.0.0");
		}, 10_000);
	});

	describe("0-file project warning", () => {
		const BASE_CONFIG_DIR = join(__dirname, "..", "..", "..", "core", "src", "__tests__", "fixtures", "base-config");

		it("warns on stderr when the discovered tsconfig yields no source files", async () => {
			const { code, stderr } = await run(["find", "symbol", "fooMarker"], BASE_CONFIG_DIR);

			expect(code).toBe(0);
			expect(stderr).toContain("0 source files");
			expect(stderr).toContain("--tsconfig");
		}, 20_000);

		it("does not warn for a project with source files", async () => {
			const { stderr } = await run(["find", "symbol", "makeCircle", "--tsconfig", TSCONFIG]);

			expect(stderr).not.toContain("0 source files");
		}, 20_000);
	});

	describe("tsconfig auto-discovery (--tsconfig optional)", () => {
		it("discovers the nearest tsconfig.json from cwd when --tsconfig is omitted", async () => {
			// Run from the fixture dir (which has a tsconfig.json) without --tsconfig.
			const { code, stdout } = await run(["resolve", "src/shapes.ts:makeCircle"], FIXTURE_DIR);

			expect(code).toBe(0);
			expect(stdout).toContain("src/shapes.ts:makeCircle");
		}, 20_000);
	});

	describe("view file --body", () => {
		it("prints each namespace member exactly once", async () => {
			const { code, stdout } = await run(["view", "file", "--tsconfig", TSCONFIG, "src/nested.ts", "--body"]);

			expect(code).toBe(0);
			expect(stdout).toContain("export namespace Model");
			expect(stdout.match(/deep: boolean/g)).toHaveLength(1);
			expect(stdout.match(/live: boolean/g)).toHaveLength(1);
		}, 20_000);
	});

	describe("gain", () => {
		it("records a query to the ledger and reports a summary", async () => {
			const home = mkdtempSync(join(tmpdir(), "symantic-gain-cli-"));

			const query = await runWithHome(home, ["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle"]);
			expect(query.code).toBe(0);

			const ledger = readFileSync(join(home, ".symantic", "gain.jsonl"), "utf8").trim();
			expect(ledger).not.toBe("");
			expect(JSON.parse(ledger.split("\n")[0]!)).toMatchObject({ op: "find refs" });

			const gain = await runWithHome(home, ["gain"]);
			expect(gain.code).toBe(0);
			expect(gain.stdout).toContain("queries:");
			expect(gain.stdout).toContain("find refs");
		}, 20_000);
	});
});
