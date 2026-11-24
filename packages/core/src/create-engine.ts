/**
 * Engine construction + the sync→async bridge. CLI and MCP consume an `AsyncSymbolEngine` so a
 * single `await`-everything code path works; the engine itself is synchronous.
 */
import { Engine } from "./engine.js";
import type { SymbolEngine, AsyncSymbolEngine } from "./symbol-engine.js";

export interface CreateEngineOptions {
	tsConfigPath: string;
}

/** A synchronous engine, optionally owning resources `dispose` releases. */
type DisposableSymbolEngine = SymbolEngine & { dispose?: () => void };

/** Wrap a synchronous SymbolEngine as an AsyncSymbolEngine (results resolved immediately). */
export function asAsync(engine: DisposableSymbolEngine): AsyncSymbolEngine {
	return {
		dispose: () => Promise.resolve(engine.dispose?.()),
		refreshIfStale: () => Promise.resolve(engine.refreshIfStale()),
		outlineFile: (path) => Promise.resolve(engine.outlineFile(path)),
		sourceFileCount: () => Promise.resolve(engine.sourceFileCount()),
		listImports: (path) => Promise.resolve(engine.listImports(path)),
		publicSurface: (path) => Promise.resolve(engine.publicSurface(path)),
		symbolSource: (symbol) => Promise.resolve(engine.symbolSource(symbol)),
		outlineSymbol: (symbol) => Promise.resolve(engine.outlineSymbol(symbol)),
		symbolContext: (symbol) => Promise.resolve(engine.symbolContext(symbol)),
		findDefinition: (symbol) => Promise.resolve(engine.findDefinition(symbol)),
		usageReport: (path, options) => Promise.resolve(engine.usageReport(path, options)),
		searchSymbol: (name, options) => Promise.resolve(engine.searchSymbol(name, options)),
		findUsages: (symbol, options) => Promise.resolve(engine.findUsages(symbol, options)),
		findImplementations: (symbol) => Promise.resolve(engine.findImplementations(symbol)),
		membersByName: (qualifiedName) => Promise.resolve(engine.membersByName(qualifiedName)),
		resolveSymbol: (qualifiedName) => Promise.resolve(engine.resolveSymbol(qualifiedName)),
		callHierarchy: (symbol, options) => Promise.resolve(engine.callHierarchy(symbol, options)),
		outlineFunction: (symbol, options) => Promise.resolve(engine.outlineFunction(symbol, options)),
		readRegion: (file, startLine, endLine) => Promise.resolve(engine.readRegion(file, startLine, endLine))
	};
}

/** Create the engine over a tsconfig as an AsyncSymbolEngine. */
export function createEngine(options: CreateEngineOptions): AsyncSymbolEngine {
	return asAsync(new Engine({ tsConfigPath: options.tsConfigPath }));
}
