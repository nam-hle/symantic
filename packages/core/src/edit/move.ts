/**
 * Move or rename a file through the language server: `workspace/willRenameFiles` answers with the
 * new import specifiers of every importer and of the moved file's own relative imports. Nothing is
 * written here; the applier edits first and then moves the file.
 */
import { resolve } from "node:path";

import { planViaServer } from "./server-plan.js";
import { pathToFileUri } from "./uri.js";
import type { EditPlan, WorkspaceEdit } from "./plan.js";

export interface MoveRequest {
	/** Directory of the tsconfig; the server is rooted here and plan paths are relative to it. */
	baseDir: string;
	/** Project-relative, forward-slashed. */
	from: string;
	to: string;
	/** Hashes (by project-relative path) of the files the edit is expected to touch, read before planning. */
	baseHashes?: ReadonlyMap<string, string>;
}

/** The edits that keep every import of `request.from` working at `request.to`, plus the move itself. */
export async function planMove(request: MoveRequest): Promise<EditPlan> {
	const files = [{ oldUri: pathToFileUri(resolve(request.baseDir, request.from)), newUri: pathToFileUri(resolve(request.baseDir, request.to)) }];
	const plan = await planViaServer({
		baseDir: request.baseDir,
		files: [request.from],
		baseHashes: request.baseHashes,
		ask: (session) => session.request("workspace/willRenameFiles", { files }) as Promise<WorkspaceEdit | null>
	});

	return { ...plan, moves: [{ from: request.from, to: request.to }] };
}
