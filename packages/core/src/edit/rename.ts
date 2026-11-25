/**
 * Rename through the language server: ask `tsc --lsp` what it would change and turn the answer
 * into an edit plan. Nothing is written here; the applier does that.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { LspError, LspSession } from "./lsp-session.js";
import { EditRefusedError, EditConflictError } from "./errors.js";
import type { EditDiagnostic } from "./errors.js";
import { pathToFileUri } from "./uri.js";
import { stripBom, contentHash, applyTextEdits, normalizeWorkspaceEdit } from "./plan.js";
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

/** Rounds of re-asking the server after opening files it edited but we had not hashed. */
const MAX_ROUNDS = 5;

/**
 * The edits that rename the symbol at `request.position`; refuses what the server will not rename.
 * Race-safe drift check: every file the final plan touches was opened in the session from text we
 * hashed, so the server computed against exactly those hashes. A file the server edits that we had
 * not opened is opened and the rename asked again; hashing after the answer would miss changes made
 * while the server was computing.
 */
export async function planRename(request: RenameRequest): Promise<EditPlan> {
	const absolute = resolve(request.baseDir, request.file);
	const location = {
		textDocument: { uri: pathToFileUri(absolute) },
		position: { line: request.position.line - 1, character: request.position.col - 1 }
	};
	const session = await LspSession.start(request.baseDir);
	const opened = new Map<string, string>();
	const open = (path: string): void => {
		const raw = readFileSync(resolve(request.baseDir, path), "utf8");
		const expected = request.baseHashes?.get(path);

		if (expected !== undefined && expected !== contentHash(raw)) {
			throw new EditConflictError(`changed since the edit was requested: ${path}; nothing was written`, [path]);
		}

		session.openDocument(resolve(request.baseDir, path), stripBom(raw));
		opened.set(path, raw);
	};

	try {
		for (const path of new Set([request.file, ...(request.baseHashes?.keys() ?? [])])) {
			open(path);
		}

		await prepare(session, location);

		for (let round = 0; round < MAX_ROUNDS; round++) {
			const edit = (await session.request("textDocument/rename", { ...location, newName: request.newName })) as WorkspaceEdit | null;
			const hashes = new Map([...opened].map(([path, raw]) => [path, contentHash(raw)]));
			const plan = normalizeWorkspaceEdit(edit ?? {}, request.baseDir, hashes);
			const unopened = plan.files.filter((file) => !opened.has(file.path));

			if (unopened.length === 0) {
				await refuseNewErrors(session, plan, opened, request.baseDir);

				return plan;
			}

			unopened.forEach((file) => open(file.path));
		}

		throw new Error("the language server kept editing files it had not been given");
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

/**
 * Apply the plan to the open documents inside the session and compare compiler errors per file
 * and code before and after; any rise means the edit breaks the project (a name collision), so
 * refuse. Plain shadowing that still compiles is not caught here.
 */
async function refuseNewErrors(session: LspSession, plan: EditPlan, opened: ReadonlyMap<string, string>, baseDir: string): Promise<void> {
	const count = (errors: Array<{ code: number }>, code: number): number => errors.filter((error) => error.code === code).length;
	const before = new Map<string, Array<{ code: number; line: number; message: string }>>();

	for (const file of plan.files) {
		before.set(file.path, await session.errors(resolve(baseDir, file.path)));
	}

	for (const file of plan.files) {
		session.changeDocument(resolve(baseDir, file.path), applyTextEdits(stripBom(opened.get(file.path) ?? ""), file.edits), 2);
	}

	const introduced: EditDiagnostic[] = [];

	for (const file of plan.files) {
		const was = before.get(file.path) ?? [];
		const now = await session.errors(resolve(baseDir, file.path));

		for (const error of now) {
			if (count(now, error.code) > count(was, error.code)) {
				introduced.push({ file: file.path, code: error.code, line: error.line, message: error.message });
			}
		}
	}

	if (introduced.length > 0) {
		throw new EditRefusedError(
			`the edit would introduce ${introduced.length} compiler error${introduced.length === 1 ? "" : "s"}: ${introduced.map((d) => `TS${d.code} ${d.file}:${d.line} ${d.message}`).join("; ")}`,
			introduced
		);
	}
}
