import { runCommand, renderUsage } from "citty";
import type { ArgsDef, CommandDef } from "citty";

import { rejectUnknownFlags, rejectRemovedFlags } from "./flags.js";
import { SymanticError, toEnvelope, exitClassOf, renderEnvelope } from "./errors.js";

/**
 * Own entry point instead of citty's `runMain`: that one prints usage to stdout and colours
 * text from a module-load-time check we cannot influence, whatever the output target is.
 * Every failure leaves through one envelope (see errors.ts) with its exit class.
 */

const ESC = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Colour only when a person is looking at both streams. */
const colourEnabled = (): boolean => process.stdout.isTTY === true && process.stderr.isTTY === true;

const stripColour = (text: string): string => text.replace(ANSI_SEQUENCE, "");

export const plain = (text: string): string => (colourEnabled() ? text : stripColour(text));

const isHelpFlag = (arg: string): boolean => arg === "--help" || arg === "-h";

const EXIT_CODE_TABLE = [
	"EXIT CODES",
	"",
	"  0  success (a query that matches nothing is still success)",
	"  1  unexpected error",
	"  2  usage error: unknown flag or command, bad value, ambiguous address",
	"  3  not found: the address, file or project does not exist"
].join("\n");

interface UsageTarget {
	/** Command names walked from the root, e.g. ["find", "refs"]. */
	path: string[];
	command: CommandDef;
	parent: CommandDef | undefined;
	/** The first word that named no subcommand of `command`, if any. */
	unmatched: string | undefined;
}

/** The command a help request or a failed parse refers to. */
function usageTarget(root: CommandDef, rawArgs: string[]): UsageTarget {
	const target: UsageTarget = { path: [], command: root, parent: undefined, unmatched: undefined };

	for (const arg of rawArgs) {
		if (arg === "--") {
			break;
		}

		if (arg.startsWith("-")) {
			continue;
		}

		const next = (target.command.subCommands as Record<string, CommandDef> | undefined)?.[arg];

		if (next === undefined) {
			target.unmatched = target.command.subCommands === undefined ? undefined : arg;

			break;
		}

		target.path.push(arg);
		target.parent = target.command;
		target.command = next;
	}

	return target;
}

const availableCommands = (command: CommandDef): string[] =>
	Object.entries((command.subCommands ?? {}) as Record<string, CommandDef>)
		.filter(([, sub]) => (sub.meta as { hidden?: boolean } | undefined)?.hidden !== true)
		.map(([name]) => name);

/** Map a citty parse failure onto the closed code table. */
function fromCittyError(error: Error & { code?: string }, target: UsageTarget): SymanticError {
	const message = stripColour(error.message);
	const where = target.path.length === 0 ? "symantic" : `symantic ${target.path.join(" ")}`;
	const commands = availableCommands(target.command);
	const listHint = `available commands: ${commands.join(", ")}`;

	if (error.code === "E_UNKNOWN_COMMAND") {
		return new SymanticError("UNKNOWN_COMMAND", `Unknown command "${target.unmatched ?? ""}" for ${where}`, {
			hint: listHint,
			context: { command: target.unmatched, availableCommands: commands }
		});
	}

	if (error.code === "E_NO_COMMAND") {
		return new SymanticError("MISSING_COMMAND", `${where} needs a command`, { hint: listHint, context: { availableCommands: commands } });
	}

	const invalid = /^Invalid value for argument: --(\S+) \((.*)\)\. Expected one of: (.*)\.$/.exec(message);

	if (invalid !== null) {
		const [, flag, value, allowed] = invalid;

		return new SymanticError("VALIDATION_ERROR", `--${flag} got "${value}"; expected one of: ${allowed}`, {
			context: { flag, value, allowed: allowed!.split(", ") }
		});
	}

	const missing = /^Missing required (?:positional )?argument: (\S+)$/.exec(message);

	if (missing !== null) {
		return new SymanticError("VALIDATION_ERROR", message, {
			context: { argument: missing[1] },
			hint: `run \`${where} --help\` to see the arguments`
		});
	}

	return new SymanticError("INTERNAL", message);
}

/** Whether --json is on: the last of --json, --json=true|1 (on) and --no-json, --json=false|0 (off) wins. */
function jsonRequested(rawArgs: string[]): boolean {
	let on = false;

	for (const arg of rawArgs) {
		if (arg === "--") {
			break;
		}

		if (arg === "--json" || arg === "--json=true" || arg === "--json=1") {
			on = true;
		} else if (arg === "--no-json" || arg === "--json=false" || arg === "--json=0") {
			on = false;
		}
	}

	return on;
}

/** Write the failure to stderr as a JSON envelope under --json, else as a line plus hint; set the exit class. */
function reportFailure(error: unknown, target: UsageTarget, rawArgs: string[]): void {
	const cittyFailure = error instanceof Error && error.name === "CLIError";
	const envelope = toEnvelope(cittyFailure ? fromCittyError(error as Error & { code?: string }, target) : error);
	const jsonMode = jsonRequested(rawArgs);

	process.stderr.write(`${jsonMode ? JSON.stringify(envelope) : plain(renderEnvelope(envelope))}\n`);
	process.exitCode = exitClassOf(envelope);
}

/** Run `root` over `rawArgs`: help and version on stdout, a failure as an envelope on stderr. */
export async function runCli(root: CommandDef, rawArgs: string[]): Promise<void> {
	const target = usageTarget(root, rawArgs);
	const beforeTerminator = rawArgs.includes("--") ? rawArgs.slice(0, rawArgs.indexOf("--")) : rawArgs;
	const helpRequested = beforeTerminator.some(isHelpFlag);

	try {
		rejectRemovedFlags(rawArgs);

		// A help flag beside a word that names no command is a failed parse, not a help request.
		if (helpRequested && target.unmatched === undefined) {
			process.stdout.write(`${plain(await renderUsage(target.command, target.parent))}\n\n${EXIT_CODE_TABLE}\n`);

			return;
		}

		if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
			process.stdout.write(`${((await root.meta) as { version?: string } | undefined)?.version ?? ""}\n`);

			return;
		}

		const parseArgs = helpRequested ? [...beforeTerminator.filter((arg) => !isHelpFlag(arg)), ...rawArgs.slice(beforeTerminator.length)] : rawArgs;

		if (target.command.subCommands === undefined) {
			rejectUnknownFlags(parseArgs, target.command.args as ArgsDef | undefined);
		}

		await runCommand(root, { rawArgs: parseArgs });
	} catch (error) {
		reportFailure(error, target, rawArgs);
	}
}
