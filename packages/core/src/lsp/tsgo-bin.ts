/**
 * Resolve the TypeScript 7 launcher (`tsc --lsp` is the native language server). Only a
 * 7.x `typescript` qualifies: 6.x has no LSP mode. Returns undefined otherwise — tests gate on this.
 */
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const MIN_MAJOR = 7;

export function tsgoBinPath(): string | undefined {
	try {
		const pkgPath = require.resolve("typescript/package.json");
		const { version } = require(pkgPath) as { version: string };

		if (Number.parseInt(version, 10) < MIN_MAJOR) {
			return undefined;
		}

		return join(dirname(pkgPath), "bin", "tsc");
	} catch {
		return undefined;
	}
}
