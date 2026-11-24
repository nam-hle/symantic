/**
 * Rename through the language server: ask `tsc --lsp` what it would change and turn the answer
 * into an edit plan. Nothing is written here; the applier does that.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { LspError, LspSession } from "./lsp-session.js";
import { EditRefusedError } from "./errors.js";
import { pathToFileUri } from "./uri.js";
import { contentHash, normalizeWorkspaceEdit } from "./plan.js";
import type { EditPlan, WorkspaceEdit } from "./plan.js";

const RESERVED_WORDS = new Set(
	"await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
		" "
	)
);

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

/** Whether `name` can be written as a plain identifier in TypeScript source. */
export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

export interface RenameRequest {
	/** Directory of the tsconfig; the server is rooted here and plan paths are relative to it. */
	baseDir: string;
	newName: string;
	/** Project-relative file holding the identifier. */
	file: string;
	/** 1-based line and column of the identifier, as symantic reports positions. */
	position: { line: number; col: number };
	/** Hashes (by project-relative path) of the files the edit is expected to touch, read before planning. */
	baseHashes?: ReadonlyMap<string, string>;
}

/** The edits that rename the symbol at `request.position`; refuses what the server will not rename. */
export async function planRename(request: RenameRequest): Promise<EditPlan> {
	const absolute = resolve(request.baseDir, request.file);
	const text = readFileSync(absolute, "utf8");
	const location = {
		textDocument: { uri: pathToFileUri(absolute) },
		position: { line: request.position.line - 1, character: request.position.col - 1 }
	};
	const session = await LspSession.start(request.baseDir);

	try {
		session.openDocument(absolute, text);
		await prepare(session, location);
		const edit = (await session.request("textDocument/rename", { ...location, newName: request.newName })) as WorkspaceEdit | null;
		const hashes = new Map(request.baseHashes);

		if (!hashes.has(request.file)) {
			hashes.set(request.file, contentHash(text));
		}

		return normalizeWorkspaceEdit(edit ?? {}, request.baseDir, hashes);
	} finally {
		await session.close();
	}
}

/** `prepareRename`: a null answer or a server error means the position is not renamable. */
async function prepare(session: LspSession, location: object): Promise<void> {
	const refusal = "the language server cannot rename it (a library or node_modules symbol, or not an identifier)";

	try {
		if ((await session.request("textDocument/prepareRename", location)) === null) {
			throw new EditRefusedError(refusal);
		}
	} catch (error) {
		throw error instanceof LspError ? new EditRefusedError(error.message) : error;
	}
}
