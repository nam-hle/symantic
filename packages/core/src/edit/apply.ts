/**
 * The applier: checks an edit plan against what is on disk, edits every file in memory, and only
 * then writes. Any drifted file aborts the whole plan before the first write.
 */
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { EditConflictError } from "./errors.js";
import { contentHash, applyTextEdits } from "./plan.js";
import type { EditPlan } from "./plan.js";

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

/** Apply `plan` under `baseDir`: every file read once, all checked, then all written, then the moves. */
export function applyEditPlan(plan: EditPlan, options: ApplyOptions): EditResult {
	const dryRun = options.dryRun === true;
	const absolute = (path: string): string => resolve(options.baseDir, path);
	const drifted: string[] = [];
	const writes: Array<{ path: string; text: string; edits: number }> = [];

	for (const file of plan.files) {
		const before = readFileSync(absolute(file.path), "utf8");

		if (file.baseHash !== undefined && file.baseHash !== contentHash(before)) {
			drifted.push(file.path);

			continue;
		}

		const after = applyTextEdits(before, file.edits);

		if (after !== before) {
			writes.push({ path: file.path, text: after, edits: file.edits.length });
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
		for (const { path, text } of writes) {
			writeFileSync(absolute(path), text);
		}

		for (const move of plan.moves) {
			mkdirSync(dirname(absolute(move.to)), { recursive: true });
			renameSync(absolute(move.from), absolute(move.to));
		}
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
