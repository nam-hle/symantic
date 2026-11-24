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

/** Splits a printed command line into words, undoing the single quotes `next` puts around unsafe values (Windows paths). */
function shellWords(line: string): string[] {
	return [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(([, quoted, bare]) => quoted?.replaceAll("'\\''", "'") ?? bare ?? "");
}

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

		it("reports an unknown symbol as NOT_FOUND, exit 3, nothing on stdout", async () => {
			const { code, stdout, stderr } = await run(["resolve", "--tsconfig", TSCONFIG, "src/shapes.ts:Nope"]);

			expect([code, stdout]).toEqual([3, ""]);
			expect(stderr).toContain("not found");
		}, 20_000);
	});

	describe("not found versus empty (#139)", () => {
		const MISSING = "src/shapes.ts:makeCirle";

		it.each([
			["resolve", ["resolve"]],
			["view members", ["view", "members"]],
			["view symbol", ["view", "symbol"]],
			["find refs", ["find", "refs"]],
			["find def", ["find", "def"]],
			["find impls", ["find", "impls"]],
			["find callers", ["find", "callers"]]
		])(
			"%s on a mistyped symbol is NOT_FOUND with did-you-mean, exit 3",
			async (_name, command) => {
				const json = await run([...command, "--tsconfig", TSCONFIG, MISSING, "--json"]);
				const text = await run([...command, "--tsconfig", TSCONFIG, MISSING]);
				const envelope = JSON.parse(json.stderr) as { code: string; context: { suggestions: string[] } };

				expect([json.code, text.code]).toEqual([3, 3]);
				expect(json.stdout).toBe("");
				expect(text.stdout).toBe("");
				expect(envelope.code).toBe("NOT_FOUND");
				expect(envelope.context.suggestions.join(" ")).toContain("makeCircle");
				expect(text.stderr).toContain("did you mean");
				expect(text.stderr).toContain("makeCircle");
			},
			30_000
		);

		it.each([
			["view outline", ["view", "outline"]],
			["view file", ["view", "file"]],
			["imports", ["imports"]],
			["exports", ["exports"]],
			["usage", ["usage"]]
		])(
			"%s on a file outside the project is NOT_FOUND, exit 3",
			async (_name, command) => {
				const { code, stdout, stderr } = await run([...command, "--tsconfig", TSCONFIG, "src/nope.ts", "--json"]);

				expect([code, stdout]).toEqual([3, ""]);
				expect(JSON.parse(stderr)).toMatchObject({ code: "NOT_FOUND", context: { file: "src/nope.ts" } });
			},
			20_000
		);

		it("view members on a real symbol still succeeds", async () => {
			const { code, stdout } = await run(["view", "members", "--tsconfig", TSCONFIG, "src/shapes.ts:Circle"]);

			expect(code).toBe(0);
			expect(stdout).toContain("area");
		}, 20_000);

		it.each([
			["find callers", ["find", "callers", "src/consumer.ts:describeArea"], "--depth"],
			["find callees", ["find", "callees", "src/shapes.ts:Box"], "--depth"],
			["find impls", ["find", "impls", "src/shapes.ts:Box"], "find refs"],
			["find symbol", ["find", "symbol", "Nopething"], "--contains"]
		])(
			"%s that matches nothing exits 0 and hints how to widen, in text and json",
			async (_name, command, widen) => {
				const text = await run([...command, "--tsconfig", TSCONFIG]);
				const json = await run([...command, "--tsconfig", TSCONFIG, "--json"]);

				expect([text.code, json.code]).toEqual([0, 0]);
				expect(text.stderr).toContain("hint:");
				expect(text.stderr).toContain(widen);
				expect(json.stderr).toBe("");
				expect(JSON.parse(json.stdout)).toMatchObject({ items: [], total: 0, hint: expect.stringContaining(widen) });
			},
			30_000
		);
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
			const parsed = JSON.parse(stdout) as { items: unknown[]; total: number };
			expect(Array.isArray(parsed.items)).toBe(true);
			expect(parsed.total).toBeGreaterThan(0);
		}, 20_000);
	});

	describe("help of every command (#140)", () => {
		/** The subcommand names a help page lists under COMMANDS; empty for a leaf. */
		const commandsListedIn = (help: string): string[] => {
			const lines = help.split("\n");
			const start = lines.indexOf("COMMANDS");

			if (start === -1) {
				return [];
			}

			const after = lines.slice(start + 1);
			const end = after.findIndex((line) => line.startsWith("Use "));

			return after
				.slice(0, end)
				.filter((line) => line.trim() !== "")
				.map((line) => line.trim().split(/\s+/)[0]!);
		};

		const walk = async (path: string[]): Promise<Array<{ path: string[]; help: string; group: boolean }>> => {
			const { code, stdout } = await run([...path, "--help"]);
			expect(code).toBe(0);
			const children = commandsListedIn(stdout);

			if (children.length === 0) {
				return [{ path, help: stdout, group: false }];
			}

			const nested = await Promise.all(children.map((child) => walk([...path, child])));

			return [{ path, help: stdout, group: true }, ...nested.flat()];
		};

		it("walks the command tree and finds every command", async () => {
			const pages = await walk([]);
			const leaves = pages.filter((page) => !page.group).map((page) => page.path.join(" "));

			expect(leaves).toEqual(
				expect.arrayContaining([
					"resolve",
					"imports",
					"exports",
					"usage",
					"gain",
					"view outline",
					"view file",
					"view symbol",
					"view members",
					"view body",
					"view region",
					"view context",
					"find symbol",
					"find def",
					"find refs",
					"find impls",
					"find callers",
					"find callees"
				])
			);
			expect(leaves).not.toContain("_daemon");
		}, 120_000);

		it("leads every page with EXAMPLES that name the command and ends it with the exit codes", async () => {
			const problems: string[] = [];

			for (const { path, help } of await walk([])) {
				const name = ["symantic", ...path].join(" ");
				const examples = help.slice(Math.max(help.indexOf("EXAMPLES"), 0), help.indexOf("USAGE"));

				if (!help.includes("EXAMPLES") || help.indexOf("EXAMPLES") > help.indexOf("USAGE")) {
					problems.push(`${name}: EXAMPLES do not lead`);
				}

				if (!new RegExp(`^ {2}${name}( |$)`, "m").test(examples)) {
					problems.push(`${name}: no example runs it`);
				}

				if (!help.includes("EXIT CODES")) {
					problems.push(`${name}: no exit codes`);
				}
			}

			expect(problems).toEqual([]);
		}, 120_000);

		it("states on every leaf what it changes, and its --json fields", async () => {
			const problems: string[] = [];

			for (const { path, help, group } of await walk([])) {
				const name = ["symantic", ...path].join(" ");

				if (!group && !/Changes: (nothing|project files)/.test(help)) {
					problems.push(`${name}: no Changes line`);
				}

				if (!group && !help.includes("--json fields: ")) {
					problems.push(`${name}: no --json fields`);
				}
			}

			expect(problems).toEqual([]);
		}, 120_000);

		it("marks required arguments on every leaf that has them", async () => {
			const problems: string[] = [];

			for (const { path, help, group } of await walk([])) {
				const usageLine = help.split("\n").find((line) => line.startsWith("USAGE"));

				if (!group && usageLine?.includes("<") === true && !help.includes("(Required)")) {
					problems.push(["symantic", ...path].join(" "));
				}
			}

			expect(problems).toEqual([]);
		}, 120_000);

		it("notes the gain ledger on gain and on queries", async () => {
			const gainHelp = await run(["gain", "--help"]);
			const refsHelp = await run(["find", "refs", "--help"]);

			expect(gainHelp.stdout).toContain("Reads the gain ledger");
			expect(refsHelp.stdout).toContain("gain ledger");
		}, 20_000);
	});

	describe("bounded lists (#137)", () => {
		interface ListJson {
			next?: string;
			total: number;
			items: Array<Record<string, unknown>>;
		}

		const lists: Array<[string, string[]]> = [
			["find symbol", ["find", "symbol", "e", "--contains"]],
			["find refs", ["find", "refs", "src/shapes.ts:makeCircle"]],
			["exports", ["exports", "src/barrel.ts"]],
			["usage", ["usage", "src/shapes.ts"]]
		];

		it.each([["find", "symbol"], ["find", "refs"], ["exports"], ["usage"]])(
			"%s declares its default limit and order in --help",
			async (...words) => {
				const { stdout } = await run([...words.filter((word) => typeof word === "string"), "--help"]);

				expect(stdout).toContain("default 50");
				expect(stdout).toMatch(/ordered by/i);
			},
			20_000
		);

		it.each(lists)(
			"%s cut by --limit 1 says so and offers a runnable next command",
			async (_name, command) => {
				const text = await run([...command, "--tsconfig", TSCONFIG, "--limit", "1"]);
				const json = await run([...command, "--tsconfig", TSCONFIG, "--limit", "1", "--json"]);
				const parsed = JSON.parse(json.stdout) as ListJson;

				expect(text.code).toBe(0);
				expect(text.stdout).toMatch(/1 of \d+ shown\. Narrow with .+, or raise --limit/);
				expect(parsed.items).toHaveLength(1);
				expect(parsed.total).toBeGreaterThan(1);
				expect(parsed.next).toMatch(/^symantic .* --cursor 1 --limit 1/);
				expect(parsed.next).toContain(command[0]);
				expect(text.stdout).toContain(`next: ${parsed.next?.replace(" --json", "")}`);
			},
			30_000
		);

		it.each(lists)(
			"%s: following next walks the whole list in order, without gaps",
			async (_name, command) => {
				const all = JSON.parse((await run([...command, "--tsconfig", TSCONFIG, "--limit", "1000", "--json"])).stdout) as ListJson;
				const collected: unknown[] = [];
				let page = JSON.parse((await run([...command, "--tsconfig", TSCONFIG, "--limit", "1", "--json"])).stdout) as ListJson;

				collected.push(...page.items);

				while (page.next !== undefined && collected.length < all.total) {
					const args = shellWords(page.next).slice(1);
					page = JSON.parse((await run(args)).stdout) as ListJson;
					collected.push(...page.items);
				}

				expect(all.next).toBeUndefined();
				expect(collected).toEqual(all.items);
			},
			60_000
		);

		it("find symbol and find refs return a deterministic order: by file, then position", async () => {
			const symbols = JSON.parse(
				(await run(["find", "symbol", "e", "--contains", "--tsconfig", TSCONFIG, "--limit", "1000", "--json"])).stdout
			) as ListJson;
			const refs = JSON.parse((await run(["find", "refs", "src/shapes.ts:Circle", "--tsconfig", TSCONFIG, "--json"])).stdout) as ListJson;
			const positionKey = (item: Record<string, unknown>): string => {
				const position = item["position"] as { file: string; line: number; col: number };

				return `${position.file}\u0000${String(position.line).padStart(8, "0")}\u0000${String(position.col).padStart(8, "0")}`;
			};

			for (const list of [symbols, refs]) {
				const keys = list.items.map(positionKey);
				expect(keys).toEqual([...keys].sort());
			}
		}, 30_000);

		it.each([
			["find symbol", ["find", "symbol", "e", "--contains"]],
			["find refs", ["find", "refs", "src/shapes.ts:makeCircle"]],
			["exports", ["exports", "src/barrel.ts"]],
			["usage", ["usage", "src/shapes.ts"]]
		])(
			"%s with a --cursor past the end says so and offers the first page, in text and json",
			async (_name, command) => {
				const text = await run([...command, "--tsconfig", TSCONFIG, "--cursor", "9999"]);
				const json = JSON.parse((await run([...command, "--tsconfig", TSCONFIG, "--cursor", "9999", "--json"])).stdout) as ListJson & {
					hint?: string;
				};

				expect(text.code).toBe(0);
				expect(text.stdout).toMatch(/cursor 9999 is past the end \(total \d+\)/);
				expect(text.stdout).toMatch(/next: symantic .*--limit 50/);
				expect(text.stdout).not.toContain("--cursor 9999 ");
				expect(json.items).toEqual([]);
				expect(json.hint).toMatch(/^cursor 9999 is past the end \(total \d+\)$/);
				expect(json.next).toMatch(/^symantic /);
				expect(json.next).not.toContain("--cursor");
			},
			30_000
		);

		it("shows no cut-off note when everything fits", async () => {
			const text = await run(["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle"]);
			const json = JSON.parse((await run(["find", "refs", "--tsconfig", TSCONFIG, "src/shapes.ts:makeCircle", "--json"])).stdout) as ListJson;

			expect(text.stdout).not.toContain("shown.");
			expect(json.next).toBeUndefined();
		}, 20_000);

		it("rejects a junk --cursor on find symbol", async () => {
			const { code, stderr } = await run(["find", "symbol", "e", "--tsconfig", TSCONFIG, "--cursor", "abc", "--json"]);

			expect(code).toBe(2);
			expect(JSON.parse(stderr)).toMatchObject({ code: "VALIDATION_ERROR", context: { flag: "cursor", value: "abc" } });
		}, 20_000);
	});

	describe("--json is one object per command (#136)", () => {
		const cases: Array<[string, string[]]> = [
			["find symbol", ["find", "symbol", "makeCircle"]],
			["find def", ["find", "def", "src/shapes.ts:makeCircle"]],
			["find refs", ["find", "refs", "src/shapes.ts:makeCircle"]],
			["find impls", ["find", "impls", "src/shapes.ts:Shape"]],
			["find callers", ["find", "callers", "src/consumer.ts:averageArea"]],
			["find callees", ["find", "callees", "src/consumer.ts:averageArea"]],
			["exports", ["exports", "src/shapes.ts"]],
			["imports", ["imports", "src/consumer.ts"]],
			["usage", ["usage", "src/shapes.ts"]],
			["view members", ["view", "members", "src/shapes.ts:Circle"]],
			["view symbol", ["view", "symbol", "src/shapes.ts:makeCircle"]],
			["view body", ["view", "body", "src/consumer.ts:totalArea"]]
		];

		it.each(cases)(
			"%s emits { items, total } with a matching count",
			async (_name, command) => {
				const { code, stdout } = await run([...command, "--tsconfig", TSCONFIG, "--json"]);
				const parsed = JSON.parse(stdout) as { items: unknown[]; total: number };

				expect(code).toBe(0);
				expect(Array.isArray(parsed)).toBe(false);
				expect(Array.isArray(parsed.items)).toBe(true);
				expect(parsed.total).toBe(parsed.items.length);
				expect(parsed.items.length).toBeGreaterThan(0);
			},
			20_000
		);

		it("view outline takes the shared --json flag and stays one object", async () => {
			const help = await run(["view", "outline", "--help"]);
			const { stdout } = await run(["view", "outline", "--tsconfig", TSCONFIG, "src/shapes.ts", "--json"]);

			expect(help.stdout).toContain("Emit structured JSON instead of text");
			expect(Array.isArray(JSON.parse(stdout))).toBe(false);
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
