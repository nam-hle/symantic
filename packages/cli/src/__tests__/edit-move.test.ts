import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdtempSync, readFileSync } from "node:fs";

import { it, expect, describe, afterEach } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(here, "..", "..", "dist", "index.js");
const FIXTURE = join(here, "..", "..", "..", "core", "src", "__tests__", "fixtures", "move");

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(args: string[], cwd: string): Promise<RunResult> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
			cwd,
			timeout: 60_000,
			env: { ...process.env, SYMANTIC_NO_DAEMON: "1" }
		});

		return { stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };

		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: typeof err.code === "number" ? err.code : 1 };
	}
}

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
	}
});

/** A private copy of the fixture project: the committed one is never written. */
function copyFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "symantic-move-cli-"));
	dirs.push(dir);
	cpSync(FIXTURE, dir, { recursive: true });

	return dir;
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const FROM = "src/util/helper.ts";
const TO = "src/core/deep/helper.ts";

describe("edit move", () => {
	it("moves the file into a new folder and rewrites importers and the file's own imports", async () => {
		const dir = copyFixture();
		const { code, stdout } = await run(["edit", "move", FROM, "--to", TO], dir);

		expect(code).toBe(0);
		expect(stdout.split("\n")[0]).toBe(`Moved ${FROM} to ${TO}, rewriting imports in 4 files`);
		expect(stdout).toContain("  src/app/main.ts  1 edit");
		expect(stdout).toContain(`  ${FROM}  2 edits`);
		expect(read(dir, "src/app/main.ts")).toContain('from "../core/deep/helper.js"');
		expect(read(dir, "src/index.ts")).toContain('from "./core/deep/helper.js"');
		expect(existsSync(join(dir, FROM))).toBe(false);
		expect(read(dir, TO)).toContain('from "../../lib/base.js"');
	}, 60_000);

	it("--dry-run reports the same result and writes nothing", async () => {
		const dir = copyFixture();
		const { code, stdout } = await run(["edit", "move", FROM, "--to", TO, "--dry-run", "--json"], dir);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			dryRun: true,
			changed: [
				{ path: "src/app/main.ts", edits: 1 },
				{ path: "src/index.ts", edits: 1 },
				{ path: "src/near.ts", edits: 1 },
				{ path: FROM, edits: 2 }
			],
			moved: [{ from: FROM, to: TO }]
		});
		expect(existsSync(join(dir, FROM))).toBe(true);
		expect(existsSync(join(dir, TO))).toBe(false);
	}, 60_000);

	it("renames in place: only the importers change", async () => {
		const dir = copyFixture();
		const { code } = await run(["edit", "move", "src/util/shape.ts", "--to", "src/util/form.ts"], dir);

		expect(code).toBe(0);
		expect(read(dir, FROM)).toContain('from "./form.js"');
		expect(existsSync(join(dir, "src/util/form.ts"))).toBe(true);
	}, 60_000);

	it("fails with CONFLICT (exit 6) for an existing target and writes nothing", async () => {
		const dir = copyFixture();
		const { code, stderr } = await run(["edit", "move", FROM, "--to", "src/util/shape.ts", "--json"], dir);

		expect(code).toBe(6);
		expect(JSON.parse(stderr)).toMatchObject({ code: "CONFLICT", context: { files: ["src/util/shape.ts"] } });
		expect(read(dir, "src/near.ts")).toContain('from "./util/helper.js"');
		expect(existsSync(join(dir, FROM))).toBe(true);
	}, 60_000);

	it("fails cleanly with NOT_FOUND when the same move runs twice", async () => {
		const dir = copyFixture();
		await run(["edit", "move", FROM, "--to", TO], dir);
		const again = await run(["edit", "move", FROM, "--to", TO, "--json"], dir);

		expect(again.code).toBe(3);
		expect(JSON.parse(again.stderr)).toMatchObject({ code: "NOT_FOUND", context: { file: FROM } });
		expect(read(dir, "src/near.ts")).toContain('from "./core/deep/helper.js"');
		expect(existsSync(join(dir, TO))).toBe(true);
	}, 120_000);

	it("reports unchanged when the target is the source", async () => {
		const dir = copyFixture();
		const { code, stdout } = await run(["edit", "move", FROM, "--to", `./${FROM}`], dir);

		expect(code).toBe(0);
		expect(stdout).toContain("Unchanged");
	}, 60_000);

	it("rejects a target outside the project", async () => {
		const dir = copyFixture();
		const { code, stderr } = await run(["edit", "move", FROM, "--to", "../outside.ts", "--json"], dir);

		expect(code).toBe(2);
		expect(JSON.parse(stderr)).toMatchObject({ code: "VALIDATION_ERROR" });
		expect(existsSync(join(dir, FROM))).toBe(true);
	}, 60_000);

	it("rejects a source outside the project", async () => {
		const dir = copyFixture();
		const { code, stderr } = await run(["edit", "move", "../x.ts", "--to", TO, "--json"], dir);

		expect(code).toBe(2);
		expect(JSON.parse(stderr)).toMatchObject({ code: "VALIDATION_ERROR" });
	}, 60_000);

	it("requires --to and documents it with the shared names", async () => {
		const dir = copyFixture();
		const missing = await run(["edit", "move", FROM, "--json"], dir);
		const help = await run(["edit", "move", "--help"], dir);

		expect(missing.code).toBe(2);
		expect(help.stdout).toContain("--to=<to>");
		expect(help.stdout).toContain("--dry-run");
	}, 60_000);
});
