import { it, expect, describe } from "vitest";
import type { AsyncSymbolEngine } from "@symantic/core";

import { EnginePool } from "../engine-pool.js";

/** A fake engine that records dispose + lets a method block to test serialization. */
function makeFake(): AsyncSymbolEngine & { disposed: boolean } {
	const fake = {
		disposed: false,
		// One real method used to test serialization; the rest are unused stubs.
		resolveSymbol: () => Promise.resolve({ kind: "not-found" as const }),
		dispose: () => {
			fake.disposed = true;

			return Promise.resolve();
		}
	};

	return fake as unknown as AsyncSymbolEngine & { disposed: boolean };
}

function pool(max: number) {
	const created: ReturnType<typeof makeFake>[] = [];

	const p = new EnginePool({
		maxEngines: max,
		exists: () => true, // every tsconfig path "exists"
		createEngine: () => {
			const f = makeFake();
			created.push(f);

			return f;
		}
	});

	return { p, created };
}

describe("EnginePool", () => {
	it("reuses the warm engine for the same key", () => {
		const { p, created } = pool(4);

		p.engineFor("/proj/tsconfig.json");
		p.engineFor("/proj/tsconfig.json");

		expect(created.length).toBe(1);
		expect(p.size).toBe(1);
	});

	it("keys by tsconfig — two projects are distinct engines", () => {
		const { p, created } = pool(4);

		p.engineFor("/proj/tsconfig.json");
		p.engineFor("/other/tsconfig.json");

		expect(created.length).toBe(2);
		expect(p.size).toBe(2);
	});

	it("evicts and disposes the least-recently-used engine beyond the cap", async () => {
		const { p, created } = pool(2);

		p.engineFor("/a/tsconfig.json"); // created[0]
		p.engineFor("/b/tsconfig.json"); // created[1]
		p.engineFor("/a/tsconfig.json"); // touch a → a is now MRU, b is LRU
		p.engineFor("/c/tsconfig.json"); // created[2] → evicts b (LRU)

		await new Promise((r) => setTimeout(r, 0));

		expect(p.size).toBe(2);
		expect(created[1]!.disposed).toBe(true); // b evicted + disposed
		expect(created[0]!.disposed).toBe(false); // a survived (was touched)
		expect(created[2]!.disposed).toBe(false); // c is fresh
	});

	it("throws a path-named error when the tsconfig does not exist", () => {
		const p = new EnginePool({ exists: () => false, createEngine: () => makeFake() });

		expect(() => p.engineFor("/missing/tsconfig.json")).toThrow(/tsConfig not found.*\/missing\/tsconfig\.json/);
	});

	it("serializes concurrent query calls on one engine (no interleave)", async () => {
		let active = 0;
		let peak = 0;
		const slow = async (): Promise<{ kind: "not-found" }> => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;

			return { kind: "not-found" };
		};

		const p = new EnginePool({
			exists: () => true,
			createEngine: () => ({ resolveSymbol: slow, dispose: () => Promise.resolve() }) as unknown as AsyncSymbolEngine
		});

		const e = p.engineFor("/proj/tsconfig.json");
		await Promise.all([e.resolveSymbol("x"), e.resolveSymbol("y"), e.resolveSymbol("z")]);

		expect(peak).toBe(1); // never more than one in flight on the same engine
	});

	it("disposeAll releases every warm engine and empties the pool", async () => {
		const { p, created } = pool(4);

		p.engineFor("/a/tsconfig.json");
		p.engineFor("/b/tsconfig.json");
		await p.disposeAll();

		expect(p.size).toBe(0);
		expect(created.every((e) => e.disposed)).toBe(true);
	});

	it("refreshes the engine before every query", async () => {
		const calls: string[] = [];
		const p = new EnginePool({
			exists: () => true,
			createEngine: () =>
				({
					dispose: () => Promise.resolve(),
					resolveSymbol: () => Promise.resolve(void calls.push("query")),
					refreshIfStale: () => Promise.resolve(void calls.push("refresh"))
				}) as unknown as AsyncSymbolEngine
		});

		await p.engineFor("/a/tsconfig.json").resolveSymbol("x");

		expect(calls).toEqual(["refresh", "query"]);
	});

	it("never leaves a live engine behind when a call is queued on an evicted engine", async () => {
		// A fake that, like the real Engine, re-warms (spawns a child) when used after dispose.
		const made: { alive: boolean }[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((res) => {
			release = res;
		});
		const p = new EnginePool({
			maxEngines: 1,
			exists: () => true,
			createEngine: () => {
				const fake = {
					alive: false,
					dispose: () => Promise.resolve(void (fake.alive = false)),
					resolveSymbol: async () => {
						fake.alive = true;
						await gate;

						return { kind: "not-found" as const };
					}
				};
				made.push(fake);

				return fake as unknown as AsyncSymbolEngine;
			}
		});

		const a = p.engineFor("/a/tsconfig.json");
		const running = a.resolveSymbol("x");
		const queued = a.resolveSymbol("y"); // queued behind the running call
		p.engineFor("/b/tsconfig.json"); // evicts a while its calls are pending
		release();
		await Promise.all([running, queued]);
		await p.disposeAll();

		expect(made.every((e) => !e.alive)).toBe(true);
	});
});
