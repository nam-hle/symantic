import { it, expect, describe } from "vitest";

import { UsageError, SHORT_KINDS, kindList, positiveInt, nonNegativeInt, rejectUnknownFlags } from "../flags.js";

describe("positiveInt", () => {
	it("passes undefined through and accepts integers from 1", () => {
		expect(positiveInt("limit", undefined)).toBeUndefined();
		expect(positiveInt("limit", "1")).toBe(1);
		expect(positiveInt("limit", "250")).toBe(250);
	});

	it.each(["0", "-3", "1.5", "abc", "", "1e3", " 2"])("rejects %j naming the flag and the value", (raw) => {
		expect(() => positiveInt("limit", raw)).toThrow(UsageError);
		expect(() => positiveInt("limit", raw)).toThrow(`--limit expects a positive integer, got "${raw}"`);
	});

	it("rejects a value beyond the safe integer range", () => {
		expect(() => positiveInt("depth", "99999999999999999999")).toThrow("--depth");
	});
});

describe("nonNegativeInt", () => {
	it("accepts 0 as the boundary", () => {
		expect(nonNegativeInt("cursor", undefined)).toBeUndefined();
		expect(nonNegativeInt("cursor", "0")).toBe(0);
		expect(nonNegativeInt("cursor", "7")).toBe(7);
	});

	it.each(["-1", "x", "2.5"])("rejects %j", (raw) => {
		expect(() => nonNegativeInt("cursor", raw)).toThrow(`--cursor expects a non-negative integer, got "${raw}"`);
	});
});

describe("kindList", () => {
	it("returns undefined for no value and trims a valid list", () => {
		expect(kindList(undefined)).toBeUndefined();
		expect(kindList("")).toBeUndefined();
		expect(kindList("fn, cls")).toEqual(["fn", "cls"]);
	});

	it("accepts every declared short kind", () => {
		expect(kindList(SHORT_KINDS.join(","))).toEqual([...SHORT_KINDS]);
	});

	it("rejects an unknown kind and lists the allowed values", () => {
		expect(() => kindList("fn,bogus")).toThrow(UsageError);
		expect(() => kindList("fn,bogus")).toThrow(/"bogus".*enum, cls, meth, ns, fn, prop, const, type, iface/);
	});
});

describe("rejectUnknownFlags", () => {
	const argsDef = {
		json: { type: "boolean" },
		"exclude-tests": { type: "boolean" },
		limit: { type: "string" },
		tsconfig: { type: "string", alias: "p" },
		symbol: { type: "positional", required: true }
	} as const;

	it("accepts declared flags in every spelling, including negation, equals and aliases", () => {
		const accepted = [
			["a.ts:A", "--json"],
			["a.ts:A", "--no-json"],
			["a.ts:A", "--exclude-tests"],
			["a.ts:A", "--excludeTests"],
			["a.ts:A", "--limit", "5"],
			["a.ts:A", "--limit=5"],
			["a.ts:A", "-p", "tsconfig.json"],
			["a.ts:A", "--help"],
			["a.ts:A", "-h"]
		];

		for (const args of accepted) {
			expect(() => rejectUnknownFlags(args, argsDef)).not.toThrow();
		}
	});

	it("lets a value flag consume a dash-led value", () => {
		expect(() => rejectUnknownFlags(["a.ts:A", "--limit", "-3"], argsDef)).not.toThrow();
	});

	it("stops scanning at --", () => {
		expect(() => rejectUnknownFlags(["--", "--bogus"], argsDef)).not.toThrow();
	});

	it("rejects an unknown long flag, with or without a value", () => {
		expect(() => rejectUnknownFlags(["a.ts:A", "--bogus"], argsDef)).toThrow("Unknown option --bogus");
		expect(() => rejectUnknownFlags(["a.ts:A", "--bogus=1"], argsDef)).toThrow("Unknown option --bogus");
		expect(() => rejectUnknownFlags(["a.ts:A", "--no-limit"], argsDef)).toThrow("Unknown option --no-limit");
	});

	it("rejects an unknown short flag", () => {
		expect(() => rejectUnknownFlags(["a.ts:A", "-z"], argsDef)).toThrow("Unknown option -z");
	});

	it("tolerates a command without declared args", () => {
		expect(() => rejectUnknownFlags(["--help"], undefined)).not.toThrow();
		expect(() => rejectUnknownFlags(["--json"], undefined)).toThrow("Unknown option --json");
	});
});
