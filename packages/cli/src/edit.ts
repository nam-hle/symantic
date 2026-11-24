/**
 * Shared pieces of the `edit` commands: address rewriting, text rendering of an edit result,
 * the file hashes a plan is checked against, and the mapping of core edit failures onto error codes.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { contentHash } from "@symantic/core";
import type { EditResult } from "@symantic/core";

import { SymanticError } from "./errors.js";

/** The last `::` segment of an address, without its file and `#index`: `src/a.ts:Foo::bar#1` gives `bar`. */
export function lastSegment(address: string): string {
	return /([^:#]*)(?:#\d+)?$/.exec(address)?.[1] ?? address;
}

/** The address with its last name segment replaced: `src/a.ts:Foo::bar#1` and `run` give `src/a.ts:Foo::run#1`. */
export function withNewName(address: string, name: string): string {
	const match = /^(.*?)[^:#]*(#\d+)?$/.exec(address);

	return `${match?.[1] ?? ""}${name}${match?.[2] ?? ""}`;
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
			context: { ...context, reason: error.message },
			hint: "only symbols declared in the project can be renamed; check the address with `symantic resolve <file>:<name>`"
		});
	}

	if (error.name === "EditConflictError") {
		const files = (error as Error & { paths?: string[] }).paths ?? [];

		return new SymanticError("CONFLICT", error.message, {
			context: { ...context, files },
			hint: "a file changed while the edit was computed; nothing was written, rerun the command"
		});
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
