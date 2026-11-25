import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";

import { it, expect, describe, afterEach } from "vitest";
import { contentHash, EditConflictError, EditOverlapError, EditRefusedError, EditWriteError } from "@symantic/core";

import { SymanticError, exitClassOf, toEnvelope } from "../errors.js";
import { isFile, hashFiles, lastSegment, renderMove, editFailure, projectPath, identifierAt, renderRename } from "../edit.js";

describe("address reading", () => {
	it("reads the last name segment", () => {
		expect(lastSegment("src/a.ts:foo")).toBe("foo");
		expect(lastSegment("src/a.ts:Outer::inner#2")).toBe("inner");
	});
});

describe("renderRename", () => {
	const changed = [
		{ path: "src/a.ts", edits: 2 },
		{ path: "src/b.ts", edits: 1 }
	];

	it("heads with the rename and lists each file with its edit count", () => {
		expect(renderRename({ changed, dryRun: false }, { from: "foo", to: "run" })).toBe(
			"Renamed foo to run in 2 files\n  src/a.ts  2 edits\n  src/b.ts  1 edit"
		);
	});

	it("says a dry run would rename, and uses the singular for one file", () => {
		expect(renderRename({ dryRun: true, changed: changed.slice(1) }, { from: "foo", to: "run" })).toBe(
			"Would rename foo to run in 1 file\n  src/b.ts  1 edit"
		);
	});

	it("says nothing changes when the result is unchanged", () => {
		expect(renderRename({ changed: [], dryRun: false, unchanged: true }, { from: "foo", to: "run" })).toBe(
			"Unchanged: renaming foo to run changes nothing"
		);
	});
});

describe("renderMove", () => {
	it("heads with the move and lists each changed file", () => {
		const changed = [{ path: "src/a.ts", edits: 2 }];

		expect(renderMove({ changed, dryRun: false }, { from: "src/a.ts", to: "src/b.ts" })).toBe(
			"Moved src/a.ts to src/b.ts, rewriting imports in 1 file\n  src/a.ts  2 edits"
		);
		expect(renderMove({ changed, dryRun: true }, { from: "src/a.ts", to: "src/b.ts" })).toContain("Would move");
		expect(renderMove({ changed: [], dryRun: false, unchanged: true }, { from: "a.ts", to: "a.ts" })).toBe("Unchanged: a.ts is already at a.ts");
	});
});

describe("projectPath", () => {
	it("normalizes a path inside the project and rejects one that leaves it", () => {
		const base = join(tmpdir(), "proj");

		expect(projectPath(base, "./src/../src/a.ts")).toBe("src/a.ts");
		expect(projectPath(base, "../a.ts")).toBeUndefined();
		expect(projectPath(base, join(tmpdir(), "elsewhere", "a.ts"))).toBeUndefined();
		expect(projectPath(base, ".")).toBeUndefined();
	});

	it("accepts an absolute path inside the project", () => {
		const base = join(tmpdir(), "proj");

		expect(projectPath(base, join(base, "src", "a.ts"))).toBe("src/a.ts");
	});
});

describe("isFile", () => {
	it("is true for a file, false for a folder or a missing path", () => {
		const dir = mkdtempSync(join(tmpdir(), "symantic-isfile-"));
		writeFileSync(join(dir, "a.ts"), "x\n");

		try {
			expect(isFile(dir, "a.ts")).toBe(true);
			expect(isFile(dir, ".")).toBe(false);
			expect(isFile(dir, "gone.ts")).toBe(false);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});

describe("editFailure conflict hints", () => {
	it("names the taken target, not drift, when a move target exists", () => {
		const error = editFailure(new EditConflictError("move target already exists: src/b.ts; nothing was written", ["src/b.ts"]), {});

		expect(toEnvelope(error as SymanticError).hint).toContain("target path is taken");
	});
});

describe("hashFiles", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("hashes the readable files once and skips a missing one", () => {
		const dir = mkdtempSync(join(tmpdir(), "symantic-hash-"));
		dirs.push(dir);
		writeFileSync(join(dir, "a.ts"), "x\n");

		expect(hashFiles(dir, ["a.ts", "a.ts", "gone.ts"])).toEqual(new Map([["a.ts", contentHash("x\n")]]));
	});
});

describe("editFailure", () => {
	it("maps a refusal to VALIDATION_ERROR with the reason", () => {
		const failure = editFailure(new EditRefusedError("not renamable"), { symbol: "src/a.ts:x" }) as SymanticError;

		expect(failure).toBeInstanceOf(SymanticError);
		expect(toEnvelope(failure)).toMatchObject({ code: "VALIDATION_ERROR", context: { symbol: "src/a.ts:x", reason: "not renamable" } });
	});

	it("carries the introduced compiler errors in the context", () => {
		const diagnostics = [{ file: "src/a.ts", code: 2451, line: 2, message: "Cannot redeclare block-scoped variable 'bar'." }];
		const failure = editFailure(new EditRefusedError("breaks", diagnostics), {}) as SymanticError;

		expect(toEnvelope(failure)).toMatchObject({ code: "VALIDATION_ERROR", context: { diagnostics } });
	});

	it("maps a drifted file to CONFLICT, exit class 6, naming the files", () => {
		const failure = editFailure(new EditConflictError("changed", ["src/a.ts"]), {}) as SymanticError;
		const envelope = toEnvelope(failure);

		expect(envelope).toMatchObject({ code: "CONFLICT", context: { files: ["src/a.ts"] } });
		expect(exitClassOf(envelope)).toBe(6);
	});

	it("maps a failed write to WRITE_FAILED, exit class 5, listing written and restored files", () => {
		const failure = editFailure(new EditWriteError("no", { failed: "b.ts", written: ["a.ts"], restored: ["a.ts"] }), {}) as SymanticError;
		const envelope = toEnvelope(failure);

		expect(envelope).toMatchObject({ code: "WRITE_FAILED", context: { failed: "b.ts", written: ["a.ts"], restored: ["a.ts"] } });
		expect(exitClassOf(envelope)).toBe(5);
	});

	it("maps overlapping edits to INTERNAL naming the files", () => {
		const failure = editFailure(new EditOverlapError("overlap", ["src/a.ts"]), {}) as SymanticError;

		expect(toEnvelope(failure)).toMatchObject({ code: "INTERNAL", context: { files: ["src/a.ts"] } });
	});

	it("passes other failures through", () => {
		const other = new Error("boom");

		expect(editFailure(other, {})).toBe(other);
		expect(editFailure("text", {})).toBe("text");
	});
});

describe("identifierAt", () => {
	it("reads the identifier at a 1-based position, counting UTF-16 columns", () => {
		const dir = mkdtempSync(join(tmpdir(), "symantic-ident-"));
		writeFileSync(join(dir, "a.ts"), 'x\nconst s = "🙂"; const naïve = 1;\n');

		try {
			expect(identifierAt(dir, { file: "a.ts", line: 2, col: 23 })).toBe("naïve");
			expect(identifierAt(dir, { file: "a.ts", line: 2, col: 1 })).toBe("const");
			expect(identifierAt(dir, { file: "a.ts", line: 2, col: 6 })).toBeUndefined();
			expect(identifierAt(dir, { file: "a.ts", line: 9, col: 1 })).toBeUndefined();
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
