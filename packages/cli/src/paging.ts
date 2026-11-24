/** Items a list command returns when `--limit` is not given. */
export const DEFAULT_LIMIT = 50;

export interface Page<T> {
	items: T[];
	total: number;
}

/** The `[offset, offset + limit)` window of an already ordered list. */
export function slicePage<T>(all: T[], offset: number, limit: number): Page<T> {
	return { total: all.length, items: all.slice(offset, offset + limit) };
}

const SAFE_WORD = /^[\w@%+=:,./#-]+$/;

/** One shell word: left bare when safe, else single-quoted. */
export function shellWord(value: string): string {
	return SAFE_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export type FlagValues = Record<string, string | boolean | undefined>;

/** A runnable `symantic` command line: the words, then the flags that carry a value or are set. */
export function commandLine(words: string[], flags: FlagValues): string {
	const parts = words.map(shellWord);

	for (const [name, value] of Object.entries(flags)) {
		if (value === undefined || value === false || value === "") {
			continue;
		}

		parts.push(value === true ? `--${name}` : `--${name} ${shellWord(value)}`);
	}

	return ["symantic", ...parts].join(" ");
}

export interface Continuation {
	/** The command that returns the next page, with the real values of this call. */
	next: string;
	/** Text-mode line saying the result was cut and how to change that. */
	note: string;
}

/**
 * What to tell the caller when `shown` of `total` items were returned from `offset`. Undefined when
 * the page reaches the end of the list. `words` and `flags` rebuild the call for the next page.
 */
export function continuation(
	page: { offset: number; limit: number; shown: number; total: number },
	call: { words: string[]; flags: FlagValues; narrowWith: string }
): Continuation | undefined {
	const nextOffset = page.offset + page.shown;

	if (nextOffset >= page.total) {
		return undefined;
	}

	const next = commandLine(call.words, { ...call.flags, cursor: String(nextOffset), limit: String(page.limit) });
	const range = page.offset === 0 ? `${page.shown}` : `${page.offset + 1}-${nextOffset}`;

	return { next, note: `${range} of ${page.total} shown. Narrow with ${call.narrowWith}, or raise --limit` };
}
