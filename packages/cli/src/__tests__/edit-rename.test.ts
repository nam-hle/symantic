import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";

import { it, expect, describe, afterEach } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(here, "..", "..", "dist", "index.js");
const FIXTURE = join(here, "..", "..", "..", "core", "src", "__tests__", "fixtures", "rename");

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = { SYMANTIC_NO_DAEMON: "1" }): Promise<RunResult> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], { cwd, timeout: 60_000, env: { ...process.env, ...env } });

		return { stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };

		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: typeof err.code === "number" ? err.code : 1 };
	}
}

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		// A killed daemon releases its files a moment later on Windows; retry instead of failing on EPERM/EBUSY.
		rmSync(dir, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
	}
});

/** A private copy of the fixture project: the committed one is never written. */
function copyFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "symantic-edit-cli-"));
	dirs.push(dir);
	cpSync(FIXTURE, dir, { recursive: true });

	return dir;
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

describe("edit rename", () => {
	it("renames across an alias import, a shorthand property, a re-export and a direct import", async () => {
		const dir = copyFixture();
		const { code, stdout } = await run(["edit", "rename", "src/foo.ts:foo", "--to", "run"], dir);

		expect(code).toBe(0);
		expect(stdout.split("\n")[0]).toBe("Renamed foo to run in 4 files");
		expect(stdout).toContain("  src/direct.ts  2 edits");
		expect(stdout).toContain("  src/use.ts  1 edit");
		expect(read(dir, "src/use.ts")).toContain('import { run as alias } from "./foo.js";');
		expect(read(dir, "src/foo.ts")).toContain('export const bag = { label: "héllo🙂", foo: run };');
		expect(read(dir, "src/index.ts")).toContain('export { run as foo } from "./foo.js";');
	}, 60_000);

	it("--dry-run reports the same result and writes nothing", async () => {
		const dir = copyFixture();
		const before = read(dir, "src/foo.ts");
		const { code, stdout } = await run(["edit", "rename", "src/foo.ts:foo", "--to", "run", "--dry-run", "--json"], dir);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			dryRun: true,
			changed: [
				{ path: "src/direct.ts", edits: 2 },
				{ path: "src/foo.ts", edits: 2 },
				{ path: "src/index.ts", edits: 1 },
				{ path: "src/use.ts", edits: 1 }
			]
		});
		expect(read(dir, "src/foo.ts")).toBe(before);
	}, 60_000);

	it("reports unchanged when the rename was already done", async () => {
		const dir = copyFixture();
		await run(["edit", "rename", "src/foo.ts:foo", "--to", "run"], dir);
		const again = await run(["edit", "rename", "src/foo.ts:foo", "--to", "run", "--json"], dir);

		expect(again.code).toBe(0);
		expect(JSON.parse(again.stdout)).toEqual({ dryRun: false, changed: [], unchanged: true });
	}, 120_000);

	it("reports unchanged when renaming a symbol to its own name", async () => {
		const dir = copyFixture();
		const { code, stdout } = await run(["edit", "rename", "src/foo.ts:foo", "--to", "foo"], dir);

		expect(code).toBe(0);
		expect(stdout).toContain("Unchanged");
		expect(read(dir, "src/foo.ts")).toContain("export function foo()");
	}, 60_000);

	it("fails with VALIDATION_ERROR naming --to for an invalid new name", async () => {
		const dir = copyFixture();
		const { code, stderr } = await run(["edit", "rename", "src/foo.ts:foo", "--to", "not valid", "--json"], dir);

		expect(code).toBe(2);
		expect(JSON.parse(stderr)).toMatchObject({ code: "VALIDATION_ERROR", context: { flag: "to" } });
		expect(read(dir, "src/foo.ts")).toContain("export function foo()");
	}, 60_000);

	it("fails with NOT_FOUND and suggestions for an unknown symbol", async () => {
		const dir = copyFixture();
		const { code, stderr } = await run(["edit", "rename", "src/foo.ts:fooo", "--to", "run", "--json"], dir);

		expect(code).toBe(3);
		expect(JSON.parse(stderr)).toMatchObject({ code: "NOT_FOUND", context: { suggestions: ["foo"] } });
	}, 60_000);

	it("requires --to", async () => {
		const dir = copyFixture();
		const { code, stderr } = await run(["edit", "rename", "src/foo.ts:foo", "--json"], dir);

		expect(code).toBe(2);
		expect(JSON.parse(stderr)).toMatchObject({ code: "VALIDATION_ERROR" });
	}, 60_000);
});

describe("edit rename and the warm daemon", () => {
	/** Kill the daemons recorded under `home`. */
	function killDaemons(home: string): void {
		const daemonDir = join(home, ".symantic", "daemon");

		for (const file of existsSync(daemonDir) ? readdirSync(daemonDir).filter((name) => name.endsWith(".json")) : []) {
			try {
				process.kill((JSON.parse(readFileSync(join(daemonDir, file), "utf8")) as { pid: number }).pid);
			} catch {
				// already gone
			}
		}
	}

	it("serves the renamed state on the next query", async () => {
		const dir = copyFixture();
		const home = mkdtempSync(join(tmpdir(), "symantic-edit-home-"));
		dirs.push(home);
		const env = { HOME: home, USERPROFILE: home, SYMANTIC_DAEMON_IDLE_MS: "60000" };

		try {
			expect((await run(["find", "def", "src/foo.ts:foo"], dir, env)).code).toBe(0);
			expect((await run(["edit", "rename", "src/foo.ts:foo", "--to", "run"], dir, env)).code).toBe(0);

			const renamed = await run(["find", "refs", "src/foo.ts:run", "--json"], dir, env);
			const old = await run(["find", "def", "src/foo.ts:foo"], dir, env);

			expect(renamed.code).toBe(0);
			expect(JSON.parse(renamed.stdout).total).toBeGreaterThanOrEqual(4);
			expect(old.code).toBe(3);
		} finally {
			killDaemons(home);
		}
	}, 120_000);
});

describe("edit rename arguments match find refs", () => {
	/** A help page's argument lines and the lines of the named options, whitespace collapsed. */
	const sections = (help: string, options: string[]): string[] => {
		const lines = help.split("\n").map((line) => line.trim().replace(/\s+/g, " "));
		const argumentsAt = lines.indexOf("ARGUMENTS");
		const positional = lines[argumentsAt + 2] ?? "";

		return [positional, ...options.map((option) => lines.find((line) => line.startsWith(option)) ?? `missing ${option}`)];
	};

	it("shares the symbol positional and the --json and --tsconfig flags, name and description", async () => {
		const cwd = copyFixture();
		const refs = sections((await run(["find", "refs", "--help"], cwd)).stdout, ["--json", "--tsconfig"]);
		const rename = sections((await run(["edit", "rename", "--help"], cwd)).stdout, ["--json", "--tsconfig"]);

		expect(refs[0]).toContain("SYMBOL");
		expect(rename).toEqual(refs);
	}, 60_000);

	it("names the destination flag --to and the preview flag --dry-run", async () => {
		const { stdout } = await run(["edit", "rename", "--help"], copyFixture());

		expect(stdout).toContain("--to=<to>");
		expect(stdout).toContain("--dry-run");
		expect(stdout).toContain("Changes: project files (writes the edited files; --dry-run writes nothing)");
	}, 60_000);
});
