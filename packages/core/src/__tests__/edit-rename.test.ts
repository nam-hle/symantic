import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { it, expect, describe, afterEach } from "vitest";

import { applyEditPlan } from "../edit/apply.js";
import { Engine } from "../index.js";
import { EditConflictError, EditRefusedError } from "../edit/errors.js";
import { contentHash } from "../edit/plan.js";
import { planRename, isValidIdentifier } from "../edit/rename.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rename");

const dirs: string[] = [];
const engines: Engine[] = [];

afterEach(() => {
	for (const engine of engines.splice(0)) {
		engine.dispose();
	}

	for (const dir of dirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

/** A private copy of the fixture project: the committed one is never written. */
function copyFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "symantic-rename-"));
	dirs.push(dir);
	cpSync(FIXTURE, dir, { recursive: true });

	return dir;
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

/** Name position of `address`, from the engine, the way the CLI finds it. */
function namePosition(dir: string, address: string): { line: number; col: number } {
	const engine = new Engine({ tsConfigPath: join(dir, "tsconfig.json") });
	engines.push(engine);
	const resolved = engine.resolveSymbol(address);

	if (resolved.kind !== "symbol") {
		throw new Error(`cannot resolve ${address}`);
	}

	const position = engine.symbolNamePosition(resolved.symbol);

	if (position === undefined) {
		throw new Error(`no name for ${address}`);
	}

	return position;
}

describe("planRename + applyEditPlan against the language server", () => {
	it("renames across an import alias, a shorthand property, a re-export and a direct import", async () => {
		const dir = copyFixture();
		const position = namePosition(dir, "src/foo.ts:foo");
		const plan = await planRename({ baseDir: dir, newName: "run", file: "src/foo.ts", position });
		const result = applyEditPlan(plan, { baseDir: dir });

		expect(result.changed.map((file) => file.path)).toEqual(["src/direct.ts", "src/foo.ts", "src/index.ts", "src/use.ts"]);
		expect(read(dir, "src/use.ts")).toContain('import { run as alias } from "./foo.js";');
		expect(read(dir, "src/direct.ts")).toContain("export const again = run();");
		expect(read(dir, "src/index.ts")).toContain('export { run as foo } from "./foo.js";');
		expect(read(dir, "src/foo.ts")).toContain('export const bag = { label: "héllo🙂", foo: run };');
		expect(read(dir, "src/foo.ts")).toContain("export function run(): number {");
	}, 30_000);

	it("finds the identifier after an emoji on the same line (UTF-16 columns)", async () => {
		const dir = copyFixture();
		const position = namePosition(dir, "src/foo.ts:foo");
		const plan = await planRename({ baseDir: dir, newName: "run", file: "src/foo.ts", position });

		expect(applyEditPlan(plan, { baseDir: dir }).changed.length).toBeGreaterThan(0);
		expect(read(dir, "src/foo.ts")).toContain('export const bag = { label: "héllo🙂", foo: run };');
	}, 30_000);

	it("writes nothing on a dry run", async () => {
		const dir = copyFixture();
		const position = namePosition(dir, "src/foo.ts:foo");
		const plan = await planRename({ baseDir: dir, newName: "run", file: "src/foo.ts", position });
		const before = read(dir, "src/use.ts");

		expect(applyEditPlan(plan, { baseDir: dir, dryRun: true }).changed).toHaveLength(4);
		expect(read(dir, "src/use.ts")).toBe(before);
	}, 30_000);

	it("refuses with CONFLICT when a file changed after the plan was computed", async () => {
		const dir = copyFixture();
		const position = namePosition(dir, "src/foo.ts:foo");
		const baseHashes = new Map([["src/use.ts", contentHash(read(dir, "src/use.ts"))]]);
		const plan = await planRename({ baseDir: dir, baseHashes, newName: "run", file: "src/foo.ts", position });

		writeFileSync(join(dir, "src/use.ts"), `${read(dir, "src/use.ts")}// edited meanwhile\n`);

		expect(() => applyEditPlan(plan, { baseDir: dir })).toThrow(EditConflictError);
		expect(read(dir, "src/foo.ts")).toContain("export function foo()");
	}, 30_000);

	it("keeps columns right across files that start with a UTF-8 BOM", async () => {
		const dir = copyFixture();

		for (const file of ["src/foo.ts", "src/use.ts"]) {
			writeFileSync(join(dir, file), `\ufeff${read(dir, file)}`);
		}

		const position = namePosition(dir, "src/foo.ts:foo");
		const plan = await planRename({ baseDir: dir, newName: "run", file: "src/foo.ts", position });
		applyEditPlan(plan, { baseDir: dir });

		expect(read(dir, "src/use.ts")).toBe('\ufeffimport { run as alias } from "./foo.js";\n\nexport const total = alias() + 1;\n');
		expect(read(dir, "src/foo.ts").startsWith("\ufeffexport function run(): number {")).toBe(true);
		expect(read(dir, "src/direct.ts")).toContain("export const again = run();");
	}, 30_000);

	it("hashes every file of the plan, including ones the caller did not name", async () => {
		const dir = copyFixture();
		const position = namePosition(dir, "src/foo.ts:foo");
		const plan = await planRename({ baseDir: dir, newName: "run", file: "src/foo.ts", position });

		expect(plan.files.map((file) => file.path).sort()).toEqual(["src/direct.ts", "src/foo.ts", "src/index.ts", "src/use.ts"]);

		for (const file of plan.files) {
			expect(file.baseHash).toBe(contentHash(read(dir, file.path)));
		}
	}, 30_000);

	it("refuses to rename a library symbol", async () => {
		const dir = copyFixture();
		writeFileSync(join(dir, "src/lib.ts"), "export const biggest = Math.max(1, 2);\n");

		await expect(planRename({ baseDir: dir, newName: "min", file: "src/lib.ts", position: { line: 1, col: 24 } })).rejects.toThrow(EditRefusedError);
	}, 30_000);

	it("refuses a position that holds no identifier", async () => {
		const dir = copyFixture();

		await expect(planRename({ baseDir: dir, newName: "run", file: "src/foo.ts", position: { line: 2, col: 1 } })).rejects.toThrow(EditRefusedError);
	}, 30_000);
});

describe("isValidIdentifier", () => {
	it("accepts identifiers, including unicode and $ _ names", () => {
		for (const name of ["run", "_x", "$el", "naïve", "a1"]) {
			expect(isValidIdentifier(name)).toBe(true);
		}
	});

	it("rejects empty, leading digit, punctuation, spaces and reserved words", () => {
		for (const name of ["", "1a", "a-b", "a b", "class", "a.b"]) {
			expect(isValidIdentifier(name)).toBe(false);
		}
	});
});
