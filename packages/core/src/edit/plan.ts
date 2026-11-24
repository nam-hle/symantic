/**
 * The edit plan every editor action produces and the applier consumes: text edits per file plus
 * file moves, with project-relative forward-slashed paths. Built from an LSP `WorkspaceEdit`.
 */
import { createHash } from "node:crypto";

import { fileUriToPath } from "./uri.js";

/** LSP position: 0-based line, UTF-16 code-unit character. */
export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	end: LspPosition;
	start: LspPosition;
}

export interface TextEdit {
	newText: string;
	range: LspRange;
}

export interface FileEdits {
	/** Project-relative, forward-slashed. */
	path: string;
	edits: TextEdit[];
	/** Hash of the content the edits were computed against; the applier refuses a file that differs. */
	baseHash?: string;
}

export interface FileMove {
	to: string;
	from: string;
}

export interface EditPlan {
	moves: FileMove[];
	files: FileEdits[];
}

/** The part of an LSP `WorkspaceEdit` the normalizer reads. */
export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: Array<
		| { textDocument: { uri: string }; edits: TextEdit[] }
		| { kind: "rename"; oldUri: string; newUri: string }
		| { kind: "create" | "delete"; uri: string }
	>;
}

/** Content hash used to detect a file that changed between planning and writing. */
export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Project-relative path of an absolute one; a path outside the project stays absolute. */
export function toProjectPath(absolute: string, baseDir: string): string {
	const base = baseDir.replace(/\\/g, "/").replace(/\/$/, "");
	const path = absolute.replace(/\\/g, "/");
	const windows = /^[A-Za-z]:/.test(base);
	const inside = windows ? path.toLowerCase().startsWith(`${base.toLowerCase()}/`) : path.startsWith(`${base}/`);

	return inside ? path.slice(base.length + 1) : path;
}

/**
 * Normalize a `WorkspaceEdit` (`changes` or `documentChanges`, file renames included) into a plan.
 * Edits to one file from several entries are merged. Creating or deleting files is not supported:
 * no editor action here produces them.
 */
export function normalizeWorkspaceEdit(edit: WorkspaceEdit, baseDir: string, baseHashes: ReadonlyMap<string, string> = new Map()): EditPlan {
	const byPath = new Map<string, TextEdit[]>();
	const moves: FileMove[] = [];
	const add = (uri: string, edits: TextEdit[]): void => {
		const path = toProjectPath(fileUriToPath(uri), baseDir);
		byPath.set(path, [...(byPath.get(path) ?? []), ...edits]);
	};

	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		add(uri, edits);
	}

	for (const change of edit.documentChanges ?? []) {
		if ("edits" in change) {
			add(change.textDocument.uri, change.edits);
		} else if (change.kind === "rename") {
			moves.push({ from: toProjectPath(fileUriToPath(change.oldUri), baseDir), to: toProjectPath(fileUriToPath(change.newUri), baseDir) });
		} else {
			throw new Error(`unsupported workspace edit: ${change.kind} file`);
		}
	}

	const files = [...byPath.entries()]
		.filter(([, edits]) => edits.length > 0)
		.map(([path, edits]) => {
			const baseHash = baseHashes.get(path);

			return { path, edits, ...(baseHash === undefined ? {} : { baseHash }) };
		});

	return { files, moves };
}

/** Offset of each line start; `\n`, `\r\n` and a lone `\r` end a line, as in LSP. */
function lineStarts(text: string): number[] {
	const starts = [0];

	for (let index = 0; index < text.length; index++) {
		const char = text[index];

		if (char === "\r" && text[index + 1] === "\n") {
			index++;
		}

		if (char === "\n" || char === "\r") {
			starts.push(index + 1);
		}
	}

	return starts;
}

/** Offset of an LSP position in `text`; a position past the end of its line or the text clamps. */
export function offsetOf(text: string, position: LspPosition, starts: number[] = lineStarts(text)): number {
	const lineStart = starts[position.line];

	if (lineStart === undefined) {
		return text.length;
	}

	const nextStart = starts[position.line + 1] ?? text.length;

	return Math.min(lineStart + position.character, nextStart);
}

/** Apply non-overlapping edits to `text`, last range first so earlier offsets stay valid. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
	const starts = lineStarts(text);
	const located = edits
		.map((edit) => ({ newText: edit.newText, start: offsetOf(text, edit.range.start, starts), end: offsetOf(text, edit.range.end, starts) }))
		.sort((a, b) => b.start - a.start || b.end - a.end);

	let result = text;
	let boundary = text.length;

	for (const { start, end, newText } of located) {
		if (end > boundary) {
			throw new Error("overlapping edits");
		}

		result = result.slice(0, start) + newText + result.slice(end);
		boundary = start;
	}

	return result;
}
