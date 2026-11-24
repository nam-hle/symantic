/**
 * One error shape for every failure: a stable code (closed table), the exit class it maps to,
 * a context naming the offending input, and a hint for the next step. Callers branch on
 * `code` or the exit class, never on message text.
 */

/** Exit classes: 1 unexpected, 2 the caller must change the input, 3 the thing asked for is absent, 6 a file changed under an edit. */
export const EXIT_CLASS = {
	INTERNAL: 1,
	AMBIGUOUS: 2,
	CONFLICT: 6,
	NOT_FOUND: 3,
	NO_PROJECT: 3,
	UNKNOWN_OPTION: 2,
	MISSING_COMMAND: 2,
	UNKNOWN_COMMAND: 2,
	VALIDATION_ERROR: 2
} as const;

export type ErrorCode = keyof typeof EXIT_CLASS;

const DEFAULT_HINT: Record<ErrorCode, string> = {
	INTERNAL: "this is a bug in symantic; report it with the command that failed",
	AMBIGUOUS: "retry with one of the candidate addresses",
	CONFLICT: "a file changed while the edit was computed; nothing was written, rerun the command",
	NOT_FOUND: "check the address with `symantic find symbol <name>` or `symantic view outline <file>`",
	NO_PROJECT: "pass --tsconfig <path> to a per-package tsconfig.json",
	UNKNOWN_OPTION: "run the command with --help to list its options",
	MISSING_COMMAND: "run `symantic --help` to list the commands",
	UNKNOWN_COMMAND: "run `symantic --help` to list the commands",
	VALIDATION_ERROR: "run the command with --help to see the expected input"
};

export interface ErrorEnvelope {
	hint: string;
	code: ErrorCode;
	message: string;
	status: "error";
	context: Record<string, unknown>;
}

export class SymanticError extends Error {
	public readonly code: ErrorCode;
	public readonly hint: string;
	public readonly context: Record<string, unknown>;

	public constructor(code: ErrorCode, message: string, options: { hint?: string; context?: Record<string, unknown> } = {}) {
		super(message);
		this.name = "SymanticError";
		this.code = code;
		this.hint = options.hint ?? DEFAULT_HINT[code];
		this.context = options.context ?? {};
	}
}

/** Any thrown value as the envelope a caller receives; non-SymanticError values are INTERNAL. */
export function toEnvelope(error: unknown): ErrorEnvelope {
	if (error instanceof SymanticError) {
		return { status: "error", code: error.code, message: error.message, context: error.context, hint: error.hint };
	}

	const message = error instanceof Error ? error.message : String(error);

	return { message, context: {}, status: "error", code: "INTERNAL", hint: DEFAULT_HINT.INTERNAL };
}

export const exitClassOf = (envelope: ErrorEnvelope): number => EXIT_CLASS[envelope.code];

/** One readable line plus the hint, for a person or an agent reading stderr as text. */
export function renderEnvelope(envelope: ErrorEnvelope): string {
	return `error: ${envelope.message}\nhint: ${envelope.hint}`;
}
