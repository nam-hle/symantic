/**
 * A short-lived `tsc --lsp --stdio` session: spawned for one edit command, rooted at the project
 * directory, shut down afterwards. Speaks JSON-RPC over Content-Length framed stdio.
 */
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { pathToFileUri } from "./uri.js";

const REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 2_000;

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	params?: { items?: unknown[] };
	result?: unknown;
	error?: { code: number; message: string };
}

/** A JSON-RPC error reply from the server. */
export class LspError extends Error {
	public readonly code: number;

	public constructor(method: string, error: { code: number; message: string }) {
		super(`${method}: ${error.message}`);
		this.name = "LspError";
		this.code = error.code;
	}
}

/** The `tsc` launcher of the pinned `typescript` package this library depends on. */
export function tscBinPath(): string {
	const require = createRequire(import.meta.url);

	return join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
}

export class LspSession {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, { method: string; ok: (value: unknown) => void; fail: (error: Error) => void }>();
	#buffer = Buffer.alloc(0);
	#nextId = 1;
	#exited = false;

	private constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
		child.stderr.on("data", () => undefined);
		child.on("error", (error) => this.#failAll(error));
		child.on("exit", () => {
			this.#exited = true;
			this.#failAll(new Error("the language server exited"));
		});
	}

	/** Spawn the server for the project at `rootDir` and complete the `initialize` handshake. */
	public static async start(rootDir: string): Promise<LspSession> {
		const child = spawn(process.execPath, [tscBinPath(), "--lsp", "--stdio"], { cwd: rootDir });
		const session = new LspSession(child);
		const rootUri = pathToFileUri(rootDir);

		try {
			await session.request("initialize", {
				rootUri,
				processId: process.pid,
				workspaceFolders: [{ uri: rootUri, name: "project" }],
				capabilities: { workspace: { workspaceEdit: { documentChanges: true }, fileOperations: { willRename: true } } }
			});
			session.notify("initialized", {});
		} catch (error) {
			await session.close();
			throw error;
		}

		return session;
	}

	public request(method: string, params: unknown): Promise<unknown> {
		return new Promise((ok, fail) => {
			const id = this.#nextId++;
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				fail(new Error(`${method}: no answer from the language server in ${REQUEST_TIMEOUT_MS / 1000}s`));
			}, REQUEST_TIMEOUT_MS);

			this.#pending.set(id, {
				method,
				ok: (value) => {
					clearTimeout(timer);
					ok(value);
				},
				fail: (error) => {
					clearTimeout(timer);
					fail(error);
				}
			});
			this.#send({ id, method, params });
		});
	}

	public notify(method: string, params: unknown): void {
		this.#send({ method, params });
	}

	/** Tell the server a document's current text; it answers from this instead of the disk. */
	public openDocument(path: string, text: string): void {
		this.notify("textDocument/didOpen", { textDocument: { uri: pathToFileUri(path), languageId: "typescript", version: 1, text } });
	}

	/** `shutdown` + `exit`, then wait for the process; kill it if it lingers. */
	public async close(): Promise<void> {
		if (this.#exited) {
			return;
		}

		const exited = new Promise<void>((done) => this.#child.once("exit", () => done()));

		try {
			await this.request("shutdown", null);
			this.notify("exit", null);
		} catch {
			// a dead or stuck server is killed below
		}

		const timer = setTimeout(() => this.#child.kill(), SHUTDOWN_GRACE_MS);
		await exited;
		clearTimeout(timer);
	}

	#send(message: object): void {
		if (this.#exited) {
			return;
		}

		const body = JSON.stringify({ jsonrpc: "2.0", ...message });
		this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	#failAll(error: Error): void {
		for (const waiter of this.#pending.values()) {
			waiter.fail(error);
		}

		this.#pending.clear();
	}

	#onData(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);

		for (;;) {
			const headerEnd = this.#buffer.indexOf("\r\n\r\n");
			const length = headerEnd === -1 ? undefined : /Content-Length: (\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString())?.[1];

			if (length === undefined || this.#buffer.length < headerEnd + 4 + Number(length)) {
				return;
			}

			const body = this.#buffer.subarray(headerEnd + 4, headerEnd + 4 + Number(length)).toString("utf8");
			this.#buffer = this.#buffer.subarray(headerEnd + 4 + Number(length));
			this.#dispatch(JSON.parse(body) as JsonRpcMessage);
		}
	}

	#dispatch(message: JsonRpcMessage): void {
		if (message.method !== undefined) {
			// Requests the server makes of its client (registerCapability, configuration, ...): nothing to offer.
			if (message.id !== undefined) {
				const items = message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => null) : null;
				this.#send({ id: message.id, result: items });
			}

			return;
		}

		const waiter = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;

		if (waiter === undefined || typeof message.id !== "number") {
			return;
		}

		this.#pending.delete(message.id);

		if (message.error === undefined) {
			waiter.ok(message.result);
		} else {
			waiter.fail(new LspError(waiter.method, message.error));
		}
	}
}
