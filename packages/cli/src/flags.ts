import type { ArgsDef } from "citty";

import { SymanticError } from "./errors.js";

/** Short kind labels `--kind` accepts: the values `find symbol` can report. */
export const SHORT_KINDS = ["enum", "cls", "meth", "ns", "fn", "prop", "const", "type", "iface"] as const;

const INTEGER = /^\d+$/;

function parseInteger(flag: string, raw: string | undefined, minimum: number, expectation: string): number | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const value = INTEGER.test(raw) ? Number(raw) : Number.NaN;

	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new SymanticError("VALIDATION_ERROR", `--${flag} expects ${expectation}, got "${raw}"`, {
			context: { flag, value: raw, expected: expectation }
		});
	}

	return value;
}

/** `--limit` / `--depth` value: an integer of at least 1. */
export const positiveInt = (flag: string, raw: string | undefined): number | undefined => parseInteger(flag, raw, 1, "a positive integer");

/** `--cursor` value: an integer offset of at least 0. */
export const nonNegativeInt = (flag: string, raw: string | undefined): number | undefined => parseInteger(flag, raw, 0, "a non-negative integer");

/** `--kind` value: comma-separated short kinds, each from the closed list. */
export function kindList(raw: string | undefined): string[] | undefined {
	if (raw === undefined || raw === "") {
		return undefined;
	}

	const kinds = raw.split(",").map((kind) => kind.trim());
	const unknown = kinds.find((kind) => !(SHORT_KINDS as readonly string[]).includes(kind));

	if (unknown !== undefined) {
		throw new SymanticError("VALIDATION_ERROR", `--kind got "${unknown}"; expected a comma-separated list of: ${SHORT_KINDS.join(", ")}`, {
			context: { flag: "kind", value: unknown, allowed: SHORT_KINDS }
		});
	}

	return kinds;
}

type FlagArity = "switch" | "value";

const camelCase = (name: string): string => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const kebabCase = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Every spelling citty accepts for each declared flag, with whether it takes a value. */
function knownFlags(argsDef: ArgsDef | undefined): Map<string, FlagArity> {
	const known = new Map<string, FlagArity>([
		["help", "switch"],
		["h", "switch"],
		["version", "switch"],
		["v", "switch"]
	]);

	for (const [name, def] of Object.entries(argsDef ?? {})) {
		if (def.type === "positional") {
			continue;
		}

		const arity: FlagArity = def.type === "boolean" ? "switch" : "value";
		const declared = "alias" in def ? def.alias : undefined;
		const aliases = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];

		for (const spelling of [name, camelCase(name), kebabCase(name), ...aliases]) {
			known.set(spelling, arity);
		}
	}

	return known;
}

const allowedOptions = (known: Map<string, FlagArity>): string[] =>
	[...known.keys()].filter((name) => name.length > 1 && !/[A-Z]/.test(name)).map((name) => `--${name}`);

/** Flags dropped on purpose; a clear message beats the generic unknown-option one. */
const REMOVED_FLAGS: Record<string, string> = { engine: "symantic has a single engine now (drop the flag)" };

export function rejectRemovedFlags(rawArgs: string[]): void {
	for (const token of rawArgs) {
		const name = token.startsWith("--") ? token.slice(2).split("=")[0]! : undefined;
		const reason = name === undefined ? undefined : REMOVED_FLAGS[name];

		if (reason !== undefined) {
			throw new SymanticError("UNKNOWN_OPTION", `--${name} was removed: ${reason}`, { context: { option: `--${name}`, removed: true } });
		}
	}
}

/** citty ignores flags a command does not declare; a typo must fail instead of reading as an answer. */
export function rejectUnknownFlags(rawArgs: string[], argsDef: ArgsDef | undefined): void {
	const known = knownFlags(argsDef);

	for (let index = 0; index < rawArgs.length; index++) {
		const token = rawArgs[index]!;

		if (token === "--") {
			return;
		}

		if (token.startsWith("--")) {
			const [name = "", ...rest] = token.slice(2).split("=");
			const negated = name.startsWith("no-") && known.get(name.slice(3)) === "switch";

			if (!negated && !known.has(name)) {
				throw new SymanticError("UNKNOWN_OPTION", `Unknown option --${name}`, { context: { option: `--${name}`, allowed: allowedOptions(known) } });
			}

			// A value flag consumes the next token, even one that looks like a flag (--limit -3).
			if (rest.length === 0 && known.get(name) === "value") {
				index++;
			}

			continue;
		}

		if (/^-[A-Za-z]/.test(token)) {
			const letters = token.slice(1).split("");
			const unknown = letters.find((letter) => !known.has(letter));

			if (unknown !== undefined) {
				throw new SymanticError("UNKNOWN_OPTION", `Unknown option -${unknown}`, {
					context: { option: `-${unknown}`, allowed: allowedOptions(known) }
				});
			}

			if (known.get(letters[letters.length - 1]!) === "value") {
				index++;
			}
		}
	}
}
