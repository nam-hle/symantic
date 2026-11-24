/** Failures of the edit machinery; the CLI maps them onto its error codes by `name`. */

/** A file differs from the content the edits were computed against, or a move target exists. */
export class EditConflictError extends Error {
	public readonly paths: string[];

	public constructor(message: string, paths: string[]) {
		super(message);
		this.name = "EditConflictError";
		this.paths = paths;
	}
}

/** The language server declined the edit (a symbol it cannot change, or no symbol at the position). */
export class EditRefusedError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "EditRefusedError";
	}
}

/** Two edits of one file overlap; the server produced a plan that cannot be applied. */
export class EditOverlapError extends Error {
	public readonly paths: string[];

	public constructor(message: string, paths: string[] = []) {
		super(message);
		this.name = "EditOverlapError";
		this.paths = paths;
	}
}

/** A file could not be written. `restored` lists files written earlier and put back to their original content. */
export class EditWriteError extends Error {
	public readonly failed: string;
	public readonly written: string[];
	public readonly restored: string[];

	public constructor(message: string, details: { failed: string; written: string[]; restored: string[] }) {
		super(message);
		this.name = "EditWriteError";
		this.failed = details.failed;
		this.written = details.written;
		this.restored = details.restored;
	}
}
