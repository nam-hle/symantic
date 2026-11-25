import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { it, expect, describe } from "vitest";

import { LspError, LspSession, tscBinPath, languageIdOf } from "../edit/lsp-session.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rename");

describe("LspSession", () => {
	it("finds the tsc launcher of the pinned typescript package", () => {
		expect(existsSync(tscBinPath())).toBe(true);
	});

	it("maps file extensions to LSP language ids", () => {
		expect(["a.ts", "a.tsx", "a.js", "a.jsx", "a.mts", "a.cjs"].map(languageIdOf)).toEqual([
			"typescript",
			"typescriptreact",
			"javascript",
			"javascriptreact",
			"typescript",
			"javascript"
		]);
	});

	it("shuts the server down on request instead of waiting for the kill timer", async () => {
		const session = await LspSession.start(FIXTURE);
		const started = Date.now();
		await session.close();

		expect(Date.now() - started).toBeLessThan(1_500);
	}, 30_000);

	it("closes twice without failing", async () => {
		const session = await LspSession.start(FIXTURE);
		await session.close();

		await expect(session.close()).resolves.toBeUndefined();
	}, 30_000);

	it("turns a server error reply into an LspError naming the method", async () => {
		const session = await LspSession.start(FIXTURE);

		try {
			await expect(session.request("workspace/noSuchMethod", {})).rejects.toBeInstanceOf(LspError);
			await expect(session.request("workspace/noSuchMethod", {})).rejects.toThrow("workspace/noSuchMethod");
		} finally {
			await session.close();
		}
	}, 30_000);
});
