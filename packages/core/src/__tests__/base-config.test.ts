import { fileURLToPath } from "node:url";

import { it, expect, describe } from "vitest";

import { Engine } from "../engine.js";

/**
 * The shared-base tsconfig footgun (issue #114): a tsconfig whose include points at a
 * src/ dir that doesn't exist next to it (the monorepo "base config" shape). The loaded
 * project has 0 source files — engines must report that instead of failing silently.
 */
const baseConfigPath = fileURLToPath(new URL("./fixtures/base-config/tsconfig.json", import.meta.url));
const samplePath = fileURLToPath(new URL("./fixtures/sample/tsconfig.json", import.meta.url));

describe("sourceFileCount", () => {
	it("reports 0 for a shared-base tsconfig with no matching files", () => {
		const engine = new Engine({ tsConfigPath: baseConfigPath });

		try {
			expect(engine.sourceFileCount()).toBe(0);
		} finally {
			engine.dispose();
		}
	});

	it("reports the project's file count for a real project", () => {
		const engine = new Engine({ tsConfigPath: samplePath });

		try {
			expect(engine.sourceFileCount()).toBeGreaterThan(0);
		} finally {
			engine.dispose();
		}
	});
});
