import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, statSync, chmodSync, mkdirSync, existsSync, readdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { it, expect, describe, afterEach } from "vitest";

import { applyEditPlan } from "../edit/apply.js";
import { EditConflictError, EditOverlapError } from "../edit/errors.js";
import type { EditPlan, TextEdit } from "../edit/plan.js";
import { contentHash, offsetOf, applyTextEdits, toProjectPath, normalizeWorkspaceEdit } from "../edit/plan.js";

const edit = (line: number, from: number, to: number, newText: string): TextEdit => ({
	newText,
	range: { start: { line, character: from }, end: { line, character: to } }
});

describe("applyTextEdits", () => {
	it("applies several edits, last range first, regardless of input order", () => {
		expect(applyTextEdits("foo foo\nfoo", [edit(0, 0, 3, "run"), edit(1, 0, 3, "run"), edit(0, 4, 7, "run")])).toBe("run run\nrun");
	});

	it("counts UTF-16 code units, so an emoji before the edit shifts the column by two", () => {
		expect(applyTextEdits('"🙂" foo', [edit(0, 5, 8, "x")])).toBe('"🙂" x');
	});

	it("reads CRLF and lone CR as line ends", () => {
		expect(applyTextEdits("a\r\nfoo\rfoo", [edit(1, 0, 3, "x"), edit(2, 0, 3, "y")])).toBe("a\r\nx\ry");
	});

	it("clamps a position past the end of the text", () => {
		expect(offsetOf("ab", { line: 9, character: 0 })).toBe(2);
		expect(applyTextEdits("ab", [edit(0, 1, 99, "!")])).toBe("a!");
	});

	it("rejects overlapping edits with a typed error", () => {
		expect(() => applyTextEdits("abcdef", [edit(0, 0, 4, "x"), edit(0, 2, 5, "y")])).toThrow(EditOverlapError);
	});

	it("keeps array order for inserts at the same position", () => {
		expect(applyTextEdits("x", [edit(0, 0, 0, "A"), edit(0, 0, 0, "B")])).toBe("ABx");
	});

	it("applies an insert at the start of a replaced range before the replacement", () => {
		expect(applyTextEdits("foo", [edit(0, 0, 3, "bar"), edit(0, 0, 0, "// ")])).toBe("// bar");
	});

	it("drops identical duplicate edits", () => {
		expect(applyTextEdits("foo", [edit(0, 0, 3, "bar"), edit(0, 0, 3, "bar")])).toBe("bar");
	});

	it("clamps a column past the end of a line to the line content, not over the newline", () => {
		expect(applyTextEdits("ab\ncd", [edit(0, 1, 9, "X")])).toBe("aX\ncd");
		expect(applyTextEdits("ab\r\ncd", [edit(0, 1, 9, "X")])).toBe("aX\r\ncd");
	});
});

describe("toProjectPath", () => {
	it("makes a path relative to the project, keeps an outside one absolute", () => {
		expect(toProjectPath("/p/src/a.ts", "/p")).toBe("src/a.ts");
		expect(toProjectPath("/other/a.ts", "/p")).toBe("/other/a.ts");
		expect(toProjectPath("/pp/a.ts", "/p")).toBe("/pp/a.ts");
	});

	it("matches a Windows drive case-insensitively and reads backslashes", () => {
		expect(toProjectPath("c:/Proj/src/a.ts", "C:\\proj")).toBe("src/a.ts");
	});
});

describe("normalizeWorkspaceEdit", () => {
	const one = edit(0, 0, 3, "run");

	it("reads `changes`", () => {
		const plan = normalizeWorkspaceEdit({ changes: { "file:///p/src/a.ts": [one] } }, "/p");

		expect(plan).toEqual({ moves: [], files: [{ path: "src/a.ts", edits: [one] }] });
	});

	it("reads `documentChanges`, merges repeated files and carries file renames", () => {
		const plan = normalizeWorkspaceEdit(
			{
				documentChanges: [
					{ textDocument: { uri: "file:///p/src/a.ts" }, edits: [one] },
					{ textDocument: { uri: "file:///p/src/a.ts" }, edits: [edit(1, 0, 3, "run")] },
					{ kind: "rename", oldUri: "file:///p/src/b.ts", newUri: "file:///p/lib/b.ts" }
				]
			},
			"/p"
		);

		expect(plan.files).toHaveLength(1);
		expect(plan.files[0]?.edits).toHaveLength(2);
		expect(plan.moves).toEqual([{ from: "src/b.ts", to: "lib/b.ts" }]);
	});

	it("decodes Windows URIs into project-relative paths", () => {
		const plan = normalizeWorkspaceEdit({ changes: { "file:///c%3A/proj/src/a.ts": [one] } }, "c:\\proj");

		expect(plan.files[0]?.path).toBe("src/a.ts");
	});

	it("drops files without edits and attaches known base hashes", () => {
		const plan = normalizeWorkspaceEdit({ changes: { "file:///p/a.ts": [one], "file:///p/b.ts": [] } }, "/p", new Map([["a.ts", "h"]]));

		expect(plan.files).toEqual([{ path: "a.ts", edits: [one], baseHash: "h" }]);
	});

	it("refuses to create or delete files", () => {
		expect(() => normalizeWorkspaceEdit({ documentChanges: [{ kind: "delete", uri: "file:///p/a.ts" }] }, "/p")).toThrow("unsupported");
	});
});

describe("applyEditPlan", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	function project(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "symantic-apply-"));
		dirs.push(dir);

		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}

		return dir;
	}

	const plan = (hash?: string): EditPlan => ({
		moves: [],
		files: [
			{ path: "a.ts", edits: [edit(0, 0, 3, "run")], ...(hash === undefined ? {} : { baseHash: hash }) },
			{ path: "b.ts", edits: [edit(0, 4, 7, "run"), edit(1, 0, 3, "run")] }
		]
	});

	it("writes every file and reports edit counts, sorted by path", () => {
		const dir = project({ "a.ts": "foo\n", "b.ts": "x = foo\nfoo\n" });
		const result = applyEditPlan(plan(contentHash("foo\n")), { baseDir: dir });

		expect(result).toEqual({
			dryRun: false,
			changed: [
				{ path: "a.ts", edits: 1 },
				{ path: "b.ts", edits: 2 }
			]
		});
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("run\n");
		expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("x = run\nrun\n");
	});

	it("writes nothing on a dry run but reports the same result", () => {
		const dir = project({ "a.ts": "foo\n", "b.ts": "x = foo\nfoo\n" });
		const result = applyEditPlan(plan(), { baseDir: dir, dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(result.changed.map((file) => file.edits)).toEqual([1, 2]);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("foo\n");
	});

	it("reports unchanged when the files already hold the result", () => {
		const dir = project({ "a.ts": "run\n", "b.ts": "x = run\nrun\n" });

		expect(applyEditPlan(plan(), { baseDir: dir })).toEqual({ dryRun: false, changed: [], unchanged: true });
	});

	it("refuses a drifted file with CONFLICT and writes nothing", () => {
		const dir = project({ "a.ts": "foo\n", "b.ts": "x = foo\nfoo\n" });
		const stale = contentHash("foo\n");
		writeFileSync(join(dir, "a.ts"), "foo // edited meanwhile\n");

		expect(() => applyEditPlan(plan(stale), { baseDir: dir })).toThrow(EditConflictError);
		expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("x = foo\nfoo\n");
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("foo // edited meanwhile\n");
	});

	it("keeps a UTF-8 BOM out of the columns and on the file", () => {
		const dir = project({ "a.ts": "\ufefffoo\n" });
		const result = applyEditPlan(
			{ moves: [], files: [{ path: "a.ts", baseHash: contentHash("\ufefffoo\n"), edits: [edit(0, 0, 3, "run")] }] },
			{ baseDir: dir }
		);

		expect(result.changed).toEqual([{ path: "a.ts", edits: 1 }]);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("\ufeffrun\n");
	});

	it("names the file of overlapping edits and writes nothing", () => {
		const dir = project({ "a.ts": "foo\n", "b.ts": "abcdef\n" });
		const overlapping: EditPlan = {
			moves: [],
			files: [
				{ path: "a.ts", edits: [edit(0, 0, 3, "x")] },
				{ path: "b.ts", edits: [edit(0, 0, 4, "x"), edit(0, 2, 5, "y")] }
			]
		};

		expect(() => applyEditPlan(overlapping, { baseDir: dir })).toThrow(expect.objectContaining({ name: "EditOverlapError", paths: ["b.ts"] }));
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("foo\n");
	});

	describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("when a file cannot be written", () => {
		it("checks every target first: a read-only file means nothing is written", () => {
			const dir = project({ "a.ts": "foo\n", "b.ts": "foo\n" });
			chmodSync(join(dir, "b.ts"), 0o444);
			const both: EditPlan = { moves: [], files: ["a.ts", "b.ts"].map((path) => ({ path, edits: [edit(0, 0, 3, "run")] })) };

			expect(() => applyEditPlan(both, { baseDir: dir })).toThrow(expect.objectContaining({ name: "EditWriteError", failed: "b.ts", written: [] }));
			expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("foo\n");
		});

		it("restores files already written when a later write fails", () => {
			const dir = project({ "a.ts": "foo\n", "sub/b.ts": "foo\n" });
			chmodSync(join(dir, "sub"), 0o555);
			const both: EditPlan = { moves: [], files: ["a.ts", "sub/b.ts"].map((path) => ({ path, edits: [edit(0, 0, 3, "run")] })) };

			try {
				expect(() => applyEditPlan(both, { baseDir: dir })).toThrow(
					expect.objectContaining({ name: "EditWriteError", failed: "sub/b.ts", written: ["a.ts"], restored: ["a.ts"] })
				);
				expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("foo\n");
				expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
			} finally {
				chmodSync(join(dir, "sub"), 0o755);
			}
		});
	});

	it("writes through a temp file and keeps the file mode", () => {
		const dir = project({ "a.ts": "foo\n" });
		chmodSync(join(dir, "a.ts"), 0o640);
		applyEditPlan({ moves: [], files: [{ path: "a.ts", edits: [edit(0, 0, 3, "run")] }] }, { baseDir: dir });

		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("run\n");
		expect(readdirSync(dir)).toEqual(["a.ts"]);
		expect(process.platform === "win32" || statSync(join(dir, "a.ts")).mode % 0o1000 === 0o640).toBe(true);
	});

	it("moves files after editing, creating the target directory", () => {
		const dir = project({ "a.ts": "foo\n" });
		const moving: EditPlan = { files: [{ path: "a.ts", edits: [edit(0, 0, 3, "run")] }], moves: [{ from: "a.ts", to: "lib/a.ts" }] };
		const result = applyEditPlan(moving, { baseDir: dir });

		expect(result.moved).toEqual([{ from: "a.ts", to: "lib/a.ts" }]);
		expect(existsSync(join(dir, "a.ts"))).toBe(false);
		expect(readFileSync(join(dir, "lib", "a.ts"), "utf8")).toBe("run\n");
	});

	it("refuses a move onto an existing file with CONFLICT", () => {
		const dir = project({ "a.ts": "foo\n", "b.ts": "bar\n" });

		expect(() => applyEditPlan({ files: [], moves: [{ from: "a.ts", to: "b.ts" }] }, { baseDir: dir })).toThrow(EditConflictError);
		expect(existsSync(join(dir, "a.ts"))).toBe(true);
	});
});
