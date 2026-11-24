# @symantic/cli

The `symantic` CLI — one-shot semantic code-navigation queries for TypeScript, built for AI agents.
Part of [symantic](https://github.com/nam-hle/symantic).

```bash
npx @symantic/cli view outline src/foo.ts     # no install
npm i -g @symantic/cli                         # → binary is `symantic`
```

The nearest `tsconfig.json` is auto-discovered from the cwd (`--tsconfig <path>` to override).
Output is token-lean, address-first text by default; add `--json` for the structured form.

Commands group by intent — **`view`** (read code) and **`find`** (locate / trace), plus
`resolve` / `imports` / `exports` / `usage` / `gain`:

```bash
symantic view symbol src/foo.ts:Bar           # exact source of one declaration
symantic view context src/foo.ts:Bar          # source + callees + referenced types
symantic find refs src/foo.ts:Bar --exclude-tests
symantic find callers src/foo.ts:Bar          # incoming call hierarchy
symantic gain                                  # estimated token savings to date
```

## JSON output

`--json` prints one object. A list command returns `{ items, total }` (plus `nextCursor` when `find refs` is
cut off, and a `hint` on how to widen the query when `items` is empty); `view outline`, `view context`,
`view region`, `view file` and `resolve` return their single result object. `gain --json` lists
`topOps` as `{ op, count }` objects.

## Errors and exit codes

Results go to stdout; every failure goes to stderr as one line plus a `hint:` line, or with `--json`
as one object `{ status, code, message, context, hint }`. Branch on `code` or the exit class:

| Exit | Meaning                                         | Codes                                                                                   |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0    | success, including a query that matches nothing |                                                                                         |
| 1    | unexpected error                                | `INTERNAL`                                                                              |
| 2    | usage error                                     | `VALIDATION_ERROR`, `UNKNOWN_OPTION`, `UNKNOWN_COMMAND`, `MISSING_COMMAND`, `AMBIGUOUS` |
| 3    | not found                                       | `NOT_FOUND`, `NO_PROJECT`                                                               |

`context` names the offending input (`flag` and `value`, `symbol`, `tsconfig`); `MISSING_COMMAND` and
`UNKNOWN_COMMAND` list `availableCommands`, `AMBIGUOUS` lists the `candidates` addresses.

Run `symantic <command> --help` for flags. Full operation set and addressing scheme in the
[root README](https://github.com/nam-hle/symantic#readme).

## License

MIT
