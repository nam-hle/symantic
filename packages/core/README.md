# @symantic/core

The engine behind [symantic](https://github.com/nam-hle/symantic) — semantic code navigation for
TypeScript, shaped for an AI agent's token budget and address model.

Transport-agnostic: a warm TypeScript 7 project (`typescript/sync`), name-based symbol
resolution, and the read-only query + outline operations. The CLI (`@symantic/cli`) and MCP server
(`@symantic/mcp`) are thin adapters over this package.

```bash
npm i @symantic/core
```

```ts
import {} from /* ops */ "@symantic/core";
```

Operations are **deterministic** AST queries — no LLM. Results are name-addressed
(`file.ts:Class::method`, never byte offsets) and token-lean. The analysis engine is the TypeScript 7 compiler,
spawned as `tsc --api`; `typescript` is pinned to an exact nightly build.

See the [root README](https://github.com/nam-hle/symantic#readme) for the full operation set and
[docs/ADDRESSING.md](https://github.com/nam-hle/symantic/blob/main/docs/ADDRESSING.md) for the
qualified-name scheme.

## License

MIT
