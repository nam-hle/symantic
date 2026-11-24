/**
 * The applier: checks an edit plan against what is on disk, edits every file in memory, and only
 * then writes. Any drifted file aborts the whole plan before the first write.
 */
import { constants, rmSync, statSync, mkdirSync, existsSync, accessSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";

import { EditConflictError, EditOverlapError, EditWriteError } from "./errors.js";
import { stripBom, withBomOf, contentHash, applyTextEdits } from "./plan.js";
import type { EditPlan, FileMove, TextEdit } from "./plan.js";

export interface ApplyOptions {
	/** Compute and report the result without writing. */
	dryRun?: boolean;
	/** Directory the plan's project-relative paths are relative to. */
	baseDir: string;
}

export interface ChangedFile {
	path: string;
	edits: number;
}

export interface EditResult {
	dryRun: boolean;
	changed: ChangedFile[];
	/** Files renamed or moved. */
	moved?: Array<{ from: string; to: string }>;
	/** True when the plan changes nothing: the edits already match the files. */
	unchanged?: true;
}

interface PendingWrite {
	path: string;
	text: string;
	/** Content on disk before the write, for putting it back. */
	original: string;
}

/** Replace a file's content through a temp file in its directory, so a failure never leaves it half written. */
function replaceFile(file: string, text: string): void {
	const temp = join(dirname(file), `.${basename(file)}.${process.pid}.symantic.tmp`);

	try {
		writeFileSync(temp, text, { mode: statSync(file).mode });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * Write every file, then do the moves. Targets are checked for write access first; if a write
 * still fails, the files already written are restored and the failure names what was written and put back.
 */
function writeAll(writes: PendingWrite[], moves: FileMove[], absolute: (path: string) => string): void {
	for (const { path } of writes) {
		try {
			accessSync(absolute(path), constants.W_OK);
		} catch (error) {
			throw new EditWriteError(`${path} is not writable (${errorCode(error)}); nothing was written`, { failed: path, written: [], restored: [] });
		}
	}

	const written: string[] = [];
	const moved: FileMove[] = [];

	try {
		for (const { path, text } of writes) {
			replaceFile(absolute(path), text);
			written.push(path);
		}

		for (const move of moves) {
			mkdirSync(dirname(absolute(move.to)), { recursive: true });
			renameSync(absolute(move.from), absolute(move.to));
			moved.push(move);
		}
	} catch (error) {
		const restored: string[] = [];

		for (const move of moved.reverse()) {
			renameSync(absolute(move.to), absolute(move.from));
		}

		for (const { path, original } of writes.filter((write) => written.includes(write.path))) {
			try {
				replaceFile(absolute(path), original);
				restored.push(path);
			} catch {
				// reported through `written` without `restored`
			}
		}

		const failed = writes.find((write) => !written.includes(write.path))?.path ?? moves[moved.length]?.from ?? "";

		throw new EditWriteError(`could not write ${failed} (${errorCode(error)}); restored ${restored.length} of ${written.length} written files`, {
			failed,
			written,
			restored
		});
	}
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);

function editedText(before: string, path: string, edits: TextEdit[]): string {
	try {
		return applyTextEdits(before, edits);
	} catch (error) {
		throw error instanceof EditOverlapError ? new EditOverlapError(`overlapping edits in ${path}; nothing was written`, [path]) : error;
	}
}

/** Apply `plan` under `baseDir`: every file read once, all checked, then all written, then the moves. */
export function applyEditPlan(plan: EditPlan, options: ApplyOptions): EditResult {
	const dryRun = options.dryRun === true;
	const absolute = (path: string): string => resolve(options.baseDir, path);
	const drifted: string[] = [];
	const writes: Array<PendingWrite & { edits: number }> = [];

	for (const file of plan.files) {
		const raw = readFileSync(absolute(file.path), "utf8");
		const before = stripBom(raw);

		if (file.baseHash !== undefined && file.baseHash !== contentHash(raw)) {
			drifted.push(file.path);

			continue;
		}

		const after = editedText(before, file.path, file.edits);

		if (after !== before) {
			writes.push({ path: file.path, original: raw, text: withBomOf(raw, after), edits: file.edits.length });
		}
	}

	if (drifted.length > 0) {
		throw new EditConflictError(`changed since the edit was computed: ${drifted.join(", ")}; nothing was written`, drifted);
	}

	const occupied = plan.moves.filter((move) => existsSync(absolute(move.to))).map((move) => move.to);

	if (occupied.length > 0) {
		throw new EditConflictError(`move target already exists: ${occupied.join(", ")}; nothing was written`, occupied);
	}

	if (!dryRun) {
		writeAll(writes, plan.moves, absolute);
	}

	const changed = writes.map(({ path, edits }) => ({ path, edits })).sort((a, b) => (a.path < b.path ? -1 : 1));
	const nothing = changed.length === 0 && plan.moves.length === 0;

	return {
		dryRun,
		changed,
		...(plan.moves.length === 0 ? {} : { moved: plan.moves }),
		...(nothing ? { unchanged: true as const } : {})
	};
}
