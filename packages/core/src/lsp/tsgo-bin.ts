/**
 * Resolve the TypeScript 7 launcher, installed as `@typescript/native` (`tsc --lsp` is the native
 * language server). Returns undefined when absent — tests gate on this.
 */
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function tsgoBinPath(): string | undefined {
	try {
		const pkg = require.resolve("@typescript/native/package.json");

		return join(dirname(pkg), "bin", "tsc");
	} catch {
		return undefined;
	}
}
