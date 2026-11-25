import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, rmSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { it, expect, describe, afterEach } from "vitest";

import { planMove } from "../edit/move.js";
import { applyEditPlan } from "../edit/apply.js";
import { EditConflictError } from "../edit/errors.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "move");

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

/** A private copy of the fixture project: the committed one is never written. */
function copyFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "symantic-move-"));
	dirs.push(dir);
	cpSync(FIXTURE, dir, { recursive: true });

	return dir;
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const FROM = "src/util/helper.ts";
const TO = "src/core/deep/helper.ts";

describe("planMove + applyEditPlan against the language server", () => {
	it("rewrites importers in other folders, keeping the .js extension, and the moved file's own imports", async () => {
		const dir = copyFixture();
		const plan = await planMove({ baseDir: dir, from: FROM, to: TO });
		const result = applyEditPlan(plan, { baseDir: dir });

		expect(result.moved).toEqual([{ from: FROM, to: TO }]);
		expect(result.changed.map((file) => file.path)).toEqual(["src/app/main.ts", "src/index.ts", "src/near.ts", FROM]);
		expect(read(dir, "src/app/main.ts")).toContain('from "../core/deep/helper.js"');
		expect(read(dir, "src/index.ts")).toContain('from "./core/deep/helper.js"');
		expect(read(dir, "src/near.ts")).toContain('from "./core/deep/helper.js"');
		expect(existsSync(join(dir, FROM))).toBe(false);
		expect(read(dir, TO)).toContain('from "../../lib/base.js"');
		expect(read(dir, TO)).toContain('from "../../util/shape.js"');
	}, 60_000);

	it("dry run reports the same files and writes nothing", async () => {
		const dir = copyFixture();
		const before = read(dir, "src/near.ts");
		const plan = await planMove({ baseDir: dir, from: FROM, to: TO });
		const result = applyEditPlan(plan, { baseDir: dir, dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(result.changed).toHaveLength(4);
		expect(read(dir, "src/near.ts")).toBe(before);
		expect(existsSync(join(dir, FROM))).toBe(true);
		expect(existsSync(join(dir, TO))).toBe(false);
	}, 60_000);

	it("refuses an existing target as a conflict and writes nothing", async () => {
		const dir = copyFixture();
		const before = read(dir, "src/near.ts");
		const plan = await planMove({ baseDir: dir, from: FROM, to: "src/util/shape.ts" });

		expect(() => applyEditPlan(plan, { baseDir: dir })).toThrow(EditConflictError);
		expect(read(dir, "src/near.ts")).toBe(before);
		expect(existsSync(join(dir, FROM))).toBe(true);
	}, 60_000);

	it("restores the edited files when the move itself fails", async () => {
		const dir = copyFixture();
		const before = read(dir, "src/near.ts");
		const plan = await planMove({ baseDir: dir, from: FROM, to: TO });

		// a file where the target folder must go makes mkdir fail after every edit was written
		writeFileSync(join(dir, "src", "core"), "not a folder");

		expect(() => applyEditPlan(plan, { baseDir: dir })).toThrow(/restored 4 of 4/);
		expect(read(dir, "src/near.ts")).toBe(before);
		expect(read(dir, FROM)).toContain('from "../lib/base.js"');
	}, 60_000);

	it("a repeated move fails on the missing source file", async () => {
		const dir = copyFixture();
		applyEditPlan(await planMove({ baseDir: dir, from: FROM, to: TO }), { baseDir: dir });

		await expect(planMove({ baseDir: dir, from: FROM, to: TO })).rejects.toThrow(/ENOENT/);
	}, 60_000);
});
