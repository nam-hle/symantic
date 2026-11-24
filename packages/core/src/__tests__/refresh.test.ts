import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";

import { test, expect, describe, afterEach } from "vitest";

import { Engine } from "../index.js";

const dirs: string[] = [];
const engines: Engine[] = [];

afterEach(() => {
	for (const engine of engines.splice(0)) {
		engine.dispose();
	}

	for (const dir of dirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function makeProject(): { dir: string; tsConfigPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "symantic-"));
	dirs.push(dir);
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["*.ts"], compilerOptions: { strict: true } }));
	writeFileSync(join(dir, "a.ts"), "export const value = 1;\n");

	return { dir, tsConfigPath: join(dir, "tsconfig.json") };
}

describe("refreshIfStale", () => {
	test("picks up an out-of-band edit before answering", () => {
		const { dir, tsConfigPath } = makeProject();
		const engine = new Engine({ tsConfigPath });
		engines.push(engine);

		const before = engine.resolveSymbol("a.ts:value");
		expect(before.kind).toBe("symbol");

		// Edit the file on disk outside the engine, adding a new declaration.
		writeFileSync(join(dir, "a.ts"), "export const value = 1;\nexport const added = 2;\n");

		expect(engine.resolveSymbol("a.ts:added").kind).toBe("not-found");

		engine.refreshIfStale();

		expect(engine.resolveSymbol("a.ts:added").kind).toBe("symbol");
	});

	test("sees a file created after the engine warmed", () => {
		const { dir, tsConfigPath } = makeProject();
		const engine = new Engine({ tsConfigPath });
		engines.push(engine);
		engine.resolveSymbol("a.ts:value");

		writeFileSync(join(dir, "c.ts"), 'import { value } from "./a.js";\nexport const used = value;\n');
		engine.refreshIfStale();

		expect(engine.resolveSymbol("c.ts:used").kind).toBe("symbol");
		const resolved = engine.resolveSymbol("a.ts:value");

		if (resolved.kind !== "symbol") {
			throw new Error("expected symbol");
		}

		expect(engine.findUsages(resolved.symbol).references.some((r) => r.position.file === "c.ts")).toBe(true);
	});

	test("notices a tsconfig edit that drops a file from the project", () => {
		const { dir, tsConfigPath } = makeProject();
		const engine = new Engine({ tsConfigPath });
		engines.push(engine);
		writeFileSync(join(dir, "b.ts"), "export const other = 2;\n");
		engine.refreshIfStale();
		expect(engine.resolveSymbol("a.ts:value").kind).toBe("symbol");

		writeFileSync(tsConfigPath, JSON.stringify({ include: ["b.ts"], compilerOptions: { strict: true } }));
		engine.refreshIfStale();

		expect(engine.resolveSymbol("a.ts:value").kind).toBe("not-found");
		expect(engine.resolveSymbol("b.ts:other").kind).toBe("symbol");
	});

	test("survives a broken tsconfig edit and recovers once it is fixed", () => {
		const { tsConfigPath } = makeProject();
		const engine = new Engine({ tsConfigPath });
		engines.push(engine);
		engine.resolveSymbol("a.ts:value");

		writeFileSync(tsConfigPath, "{ not json");

		try {
			engine.refreshIfStale();
		} catch {
			// a clean failure is fine; a wedged session is not
		}

		writeFileSync(tsConfigPath, JSON.stringify({ include: ["*.ts"], compilerOptions: { strict: true } }));
		engine.refreshIfStale();

		expect(engine.resolveSymbol("a.ts:value").kind).toBe("symbol");
	});
});
