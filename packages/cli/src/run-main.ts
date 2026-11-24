import { runCommand, renderUsage } from "citty";
import type { CommandDef } from "citty";

/**
 * Own entry point instead of citty's `runMain`: that one prints usage to stdout and colours
 * text from a module-load-time check we cannot influence, whatever the output target is.
 */

const ESC = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Colour only when a person is looking at both streams. */
const colourEnabled = (): boolean => process.stdout.isTTY === true && process.stderr.isTTY === true;

export const plain = (text: string): string => (colourEnabled() ? text : text.replace(ANSI_SEQUENCE, ""));

const isHelpFlag = (arg: string): boolean => arg === "--help" || arg === "-h";

/** The command (and its parent) whose usage a help request or a failed parse should show. */
function usageTarget(root: CommandDef, rawArgs: string[]): [CommandDef, CommandDef | undefined] {
	let current = root;
	let parent: CommandDef | undefined;

	for (const arg of rawArgs) {
		if (arg.startsWith("-")) {
			continue;
		}

		const next = (current.subCommands as Record<string, CommandDef> | undefined)?.[arg];

		if (next === undefined) {
			break;
		}

		parent = current;
		current = next;
	}

	return [current, parent];
}

/** Run `root` over `rawArgs`: help and version on stdout, a failed parse on stderr with exit 1. */
export async function runCli(root: CommandDef, rawArgs: string[]): Promise<void> {
	if (rawArgs.some(isHelpFlag)) {
		process.stdout.write(`${plain(await renderUsage(...usageTarget(root, rawArgs)))}\n\n`);

		return;
	}

	if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
		process.stdout.write(`${((await root.meta) as { version?: string } | undefined)?.version ?? ""}\n`);

		return;
	}

	try {
		await runCommand(root, { rawArgs });
	} catch (error) {
		process.exitCode = 1;

		if (error instanceof Error && error.name === "CLIError") {
			process.stderr.write(`${plain(await renderUsage(...usageTarget(root, rawArgs)))}\n\n${plain(error.message)}\n`);

			return;
		}

		process.stderr.write(`${plain(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
	}
}
