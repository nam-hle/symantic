import { it, expect, describe } from "vitest";

import { SymanticError } from "../errors.js";
import { SHORT_KINDS, kindList, positiveInt, nonNegativeInt, rejectRemovedFlags, rejectUnknownFlags } from "../flags.js";

describe("positiveInt", () => {
	it("passes undefined through and accepts integers from 1", () => {
		expect(positiveInt("limit", undefined)).toBeUndefined();
		expect(positiveInt("limit", "1")).toBe(1);
		expect(positiveInt("limit", "250")).toBe(250);
	});

	it.each(["0", "-3", "1.5", "abc", "", "1e3", " 2"])("rejects %j naming the flag and the value", (raw) => {
		expect(() => positiveInt("limit", raw)).toThrow(SymanticError);
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
		expect(() => kindList("fn,bogus")).toThrow(SymanticError);
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

describe("error codes", () => {
	const codeOf = (run: () => unknown): string | undefined => {
		try {
			run();
		} catch (error) {
			return error instanceof SymanticError ? error.code : undefined;
		}

		return undefined;
	};

	it("tags bad values VALIDATION_ERROR and unknown flags UNKNOWN_OPTION", () => {
		expect(codeOf(() => positiveInt("limit", "abc"))).toBe("VALIDATION_ERROR");
		expect(codeOf(() => kindList("bogus"))).toBe("VALIDATION_ERROR");
		expect(codeOf(() => rejectUnknownFlags(["--bogus"], {}))).toBe("UNKNOWN_OPTION");
	});

	it("names the observed flag and value in the context", () => {
		expect(() => positiveInt("limit", "abc")).toThrow(
			expect.objectContaining({ context: { flag: "limit", value: "abc", expected: "a positive integer" } })
		);
	});
});

describe("rejectRemovedFlags", () => {
	it("explains a removed flag instead of calling it unknown", () => {
		expect(() => rejectRemovedFlags(["resolve", "--engine", "lsp"])).toThrow("--engine was removed");
		expect(() => rejectRemovedFlags(["--engine=lsp"])).toThrow("--engine was removed");
	});

	it("ignores everything else", () => {
		expect(() => rejectRemovedFlags(["find", "refs", "--json", "--limit=2"])).not.toThrow();
	});
});
