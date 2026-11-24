/**
 * Warm-engine pool for the long-lived MCP server. Holds one engine per
 * tsconfig and manages the three lifecycle hazards of that warmth
 * (epic #84 / M3):
 *
 * - **Bound** — at most `maxEngines` warm engines; the least-recently-used is evicted
 *   and disposed beyond the cap (each warm project holds a compiler process).
 * - **Serialize** — the compiler session is not reentrant, so every
 *   query method on a given engine is chained per key; concurrent calls never interleave.
 * - **Dispose** — `disposeAll()` releases every engine (and its compiler subprocess) on shutdown.
 *
 * `createEngine` is injected so tests can supply a fake engine without a real project.
 */
import { existsSync } from "node:fs";

import type { AsyncSymbolEngine } from "@symantic/core";
import { createEngine as defaultCreateEngine } from "@symantic/core";

import { serialize, clearSerialKey } from "./serialize.js";

export interface EnginePoolOptions {
	/** Max warm engines held at once (LRU eviction beyond this). Default 4. */
	maxEngines?: number;
	/** Existence check for the tsconfig path (injectable for tests). Defaults to `existsSync`. */
	exists?: (path: string) => boolean;
	/** Engine factory (injectable for tests). Defaults to the core `createEngine`. */
	createEngine?: (opts: { tsConfigPath: string }) => AsyncSymbolEngine;
}

export class EnginePool {
	readonly #maxEngines: number;
	readonly #create: (opts: { tsConfigPath: string }) => AsyncSymbolEngine;
	readonly #exists: (path: string) => boolean;
	/** Warm engines keyed by tsconfig path. Map insertion order = LRU order. */
	readonly #engines = new Map<string, AsyncSymbolEngine>();

	public constructor(options: EnginePoolOptions = {}) {
		this.#maxEngines = options.maxEngines ?? 4;
		this.#create = options.createEngine ?? defaultCreateEngine;
		this.#exists = options.exists ?? existsSync;
	}

	/** Number of warm engines currently held (for tests/observability). */
	public get size(): number {
		return this.#engines.size;
	}

	#rawEngineFor(key: string, tsConfig: string): AsyncSymbolEngine {
		const existing = this.#engines.get(key);

		if (existing !== undefined) {
			// Touch: move to most-recently-used (re-insert at the end).
			this.#engines.delete(key);
			this.#engines.set(key, existing);

			return existing;
		}

		if (!this.#exists(tsConfig)) {
			throw new Error(`tsConfig not found: ${tsConfig} (pass an existing path to the project tsconfig.json)`);
		}

		const engine = this.#create({ tsConfigPath: tsConfig });
		this.#engines.set(key, engine);

		// Evict LRU (oldest) entries beyond the cap. Disposal queues behind the engine's pending
		// calls, so none runs on a half-torn-down engine.
		while (this.#engines.size > this.#maxEngines) {
			const oldestKey = this.#engines.keys().next().value as string;
			const evicted = this.#engines.get(oldestKey)!;
			this.#engines.delete(oldestKey);
			void serialize(oldestKey, () => evicted.dispose()).then(() => {
				if (!this.#engines.has(oldestKey)) {
					clearSerialKey(oldestKey);
				}
			});
		}

		return engine;
	}

	/**
	 * The engine for a tsconfig, wrapped so every async method call is serialized on a
	 * per-engine chain. `dispose` runs directly (the shutdown path); every query serializes,
	 * refreshes the engine first (files edited between calls), and runs on the pool's *current*
	 * engine for the tsconfig: a call queued on an evicted engine goes to a fresh pooled one,
	 * never re-spawning an untracked compiler process.
	 */
	public engineFor(tsConfig: string): AsyncSymbolEngine {
		const key = tsConfig;
		const engine = this.#rawEngineFor(key, tsConfig);
		const current = (): AsyncSymbolEngine => this.#engines.get(key) ?? this.#rawEngineFor(key, tsConfig);

		return new Proxy(engine, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);

				if (typeof value !== "function") {
					return value;
				}

				if (prop === "dispose") {
					return value.bind(target);
				}

				return (...args: unknown[]) =>
					serialize(key, async () => {
						const live = current() as unknown as Record<string | symbol, (...a: unknown[]) => Promise<unknown>>;

						if (prop !== "refreshIfStale") {
							await live["refreshIfStale"]?.();
						}

						return live[prop]!(...args);
					});
			}
		});
	}

	/** Dispose every warm engine (and its compiler subprocess) and clear the pool. */
	public async disposeAll(): Promise<void> {
		const keys = [...this.#engines.keys()];
		await Promise.all(keys.map((key) => serialize(key, () => this.#engines.get(key)!.dispose())));
		this.#engines.clear();

		for (const key of keys) {
			clearSerialKey(key);
		}
	}
}
