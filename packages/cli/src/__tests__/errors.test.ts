import { it, expect, describe } from "vitest";

import { SymanticError, toEnvelope, exitClassOf } from "../errors.js";

describe("toEnvelope", () => {
	it("maps an unexpected throw to INTERNAL with exit class 1", () => {
		const envelope = toEnvelope(new Error("boom"));

		expect(envelope).toMatchObject({ status: "error", code: "INTERNAL", message: "boom", context: {} });
		expect(exitClassOf(envelope)).toBe(1);
	});

	it("keeps the code, context and hint of a SymanticError", () => {
		const envelope = toEnvelope(new SymanticError("NOT_FOUND", "gone", { hint: "look elsewhere", context: { symbol: "a.ts:A" } }));

		expect(envelope).toEqual({ status: "error", code: "NOT_FOUND", message: "gone", hint: "look elsewhere", context: { symbol: "a.ts:A" } });
		expect(exitClassOf(envelope)).toBe(3);
	});
});
