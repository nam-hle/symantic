/**
 * Shared pieces of the `edit` commands: address rewriting, text rendering of an edit result,
 * the file hashes a plan is checked against, and the mapping of core edit failures onto error codes.
 */
import { resolve, relative, isAbsolute } from "node:path";
import { statSync, readFileSync } from "node:fs";

import { contentHash } from "@symantic/core";
import type { EditResult } from "@symantic/core";

import { SymanticError } from "./errors.js";

/** The last `::` segment of an address, without its file and `#index`: `src/a.ts:Foo::bar#1` gives `bar`. */
export function lastSegment(address: string): string {
	return /([^:#]*)(?:#\d+)?$/.exec(address)?.[1] ?? address;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Text form of a rename result: a headline, then each changed file with its edit count. */
export function renderRename(result: EditResult, change: { from: string; to: string }): string {
	if (result.unchanged === true) {
		return `Unchanged: renaming ${change.from} to ${change.to} changes nothing`;
	}

	const verb = result.dryRun ? "Would rename" : "Renamed";
	const head = `${verb} ${change.from} to ${change.to} in ${plural(result.changed.length, "file")}`;

	return [head, ...result.changed.map((file) => `  ${file.path}  ${plural(file.edits, "edit")}`)].join("\n");
}

/** Text form of a move result: a headline, then each changed file with its edit count. */
export function renderMove(result: EditResult, change: { from: string; to: string }): string {
	if (result.unchanged === true) {
		return `Unchanged: ${change.from} is already at ${change.to}`;
	}

	const verb = result.dryRun ? "Would move" : "Moved";
	const head = `${verb} ${change.from} to ${change.to}, rewriting imports in ${plural(result.changed.length, "file")}`;

	return [head, ...result.changed.map((file) => `  ${file.path}  ${plural(file.edits, "edit")}`)].join("\n");
}

/** `path` (relative to the project directory) as a forward-slashed project path; undefined when it leaves the project. */
export function projectPath(baseDir: string, path: string): string | undefined {
	const relativePath = relative(baseDir, resolve(baseDir, path)).replace(/\\/g, "/");

	return relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath) ? undefined : relativePath;
}

/** Whether a regular file exists at the project-relative `path`. */
export function isFile(baseDir: string, path: string): boolean {
	try {
		return statSync(resolve(baseDir, path)).isFile();
	} catch {
		return false;
	}
}

/** The identifier written at a 1-based position of a project file, or undefined when none starts there. */
export function identifierAt(baseDir: string, at: { file: string; line: number; col: number }): string | undefined {
	const line = readFileSync(resolve(baseDir, at.file), "utf8").split(/\r\n|\r|\n/)[at.line - 1] ?? "";

	return /^[\p{ID_Continue}$]+/u.exec(line.slice(at.col - 1))?.[0];
}

/** Content hashes of project files (paths relative to `baseDir`); files that cannot be read are left out. */
export function hashFiles(baseDir: string, paths: Iterable<string>): Map<string, string> {
	const hashes = new Map<string, string>();

	for (const path of new Set(paths)) {
		try {
			hashes.set(path, contentHash(readFileSync(resolve(baseDir, path), "utf8")));
		} catch {
			// a file that vanished is the applier's problem, not a reason to stop planning
		}
	}

	return hashes;
}

/** The CLI error for a failure of the edit machinery; other errors pass through unchanged. */
export function editFailure(error: unknown, context: Record<string, unknown>): unknown {
	if (!(error instanceof Error)) {
		return error;
	}

	if (error.name === "EditRefusedError") {
		return new SymanticError("VALIDATION_ERROR", `cannot rename: ${error.message}`, {
			context: {
				...context,
				reason: error.message,
				...((error as { diagnostics?: unknown }).diagnostics === undefined ? {} : { diagnostics: (error as { diagnostics?: unknown }).diagnostics })
			},
			hint: "only symbols declared in the project can be renamed, and a rename must not introduce compiler errors; check the address with `symantic resolve <file>:<name>`"
		});
	}

	if (error.name === "EditConflictError") {
		const files = (error as Error & { paths?: string[] }).paths ?? [];

		return new SymanticError("CONFLICT", error.message, {
			context: { ...context, files },
			hint: error.message.startsWith("move target already exists")
				? "the target path is taken; pick a free one with --to or move the existing file first"
				: "a file changed while the edit was computed; nothing was written, rerun the command"
		});
	}

	if (error.name === "EditWriteError") {
		const { failed, written, restored } = error as Error & { failed: string; written: string[]; restored: string[] };

		return new SymanticError("WRITE_FAILED", error.message, { context: { ...context, failed, written, restored } });
	}

	if (error.name === "EditOverlapError") {
		const files = (error as Error & { paths?: string[] }).paths ?? [];

		return new SymanticError("INTERNAL", error.message, {
			context: { ...context, files },
			hint: "the language server produced overlapping edits; nothing was written. Report it with the command that failed"
		});
	}

	return error;
}
