/**
 * Race-safe planning through a language-server session, shared by the editor actions: every file the
 * final plan touches was opened in the session from text we hashed, so the server computed against
 * exactly those hashes.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { LspSession } from "./lsp-session.js";
import { EditConflictError } from "./errors.js";
import { stripBom, contentHash, normalizeWorkspaceEdit } from "./plan.js";
import type { EditPlan, WorkspaceEdit } from "./plan.js";

/** Rounds of re-asking the server after opening files it edited but we had not hashed. */
const MAX_ROUNDS = 5;

export interface ServerPlanRequest {
	/** Directory of the tsconfig; the server is rooted here and plan paths are relative to it. */
	baseDir: string;
	/** Project-relative files opened before the first question. */
	files: Iterable<string>;
	/** Hashes (by project-relative path) the opened files must still have; a mismatch is a conflict. */
	baseHashes?: ReadonlyMap<string, string>;
	/** Runs once the files are open, before the first ask. */
	prepare?: (session: LspSession) => Promise<void>;
	/** The question: the `WorkspaceEdit` the server would make. */
	ask: (session: LspSession) => Promise<WorkspaceEdit | null | undefined>;
	/** Runs on the stable plan with the raw text of every opened file; may throw to refuse it. */
	verify?: (session: LspSession, plan: EditPlan, opened: ReadonlyMap<string, string>) => Promise<void>;
}

/**
 * Ask the server until its answer only touches files we opened from hashed text. A file it edits
 * that we had not opened is opened and the question asked again; hashing after the answer would
 * miss changes made while the server was computing.
 */
export async function planViaServer(request: ServerPlanRequest): Promise<EditPlan> {
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
		for (const path of new Set([...request.files, ...(request.baseHashes?.keys() ?? [])])) {
			open(path);
		}

		await request.prepare?.(session);

		for (let round = 0; round < MAX_ROUNDS; round++) {
			const edit = await request.ask(session);
			const hashes = new Map([...opened].map(([path, raw]) => [path, contentHash(raw)]));
			const plan = normalizeWorkspaceEdit(edit ?? {}, request.baseDir, hashes);
			const unopened = plan.files.filter((file) => !opened.has(file.path));

			if (unopened.length === 0) {
				await request.verify?.(session, plan, opened);

				return plan;
			}

			unopened.forEach((file) => open(file.path));
		}

		throw new Error("the language server kept editing files it had not been given");
	} finally {
		await session.close();
	}
}
