# @symantic/cli

The `symantic` CLI — one-shot semantic code-navigation queries for TypeScript, built for AI agents.
Part of [symantic](https://github.com/nam-hle/symantic).

```bash
npx @symantic/cli view outline src/foo.ts     # no install
npm i -g @symantic/cli                         # → binary is `symantic`
```

The nearest `tsconfig.json` is auto-discovered from the cwd (`--tsconfig <path>` to override).
Output is token-lean, address-first text by default; add `--json` for the structured form.

Commands group by intent — **`view`** (read code), **`find`** (locate / trace) and **`edit`** (change
code), plus `resolve` / `imports` / `exports` / `usage` / `gain`:

```bash
symantic view symbol src/foo.ts:Bar           # exact source of one declaration
symantic view context src/foo.ts:Bar          # source + callees + referenced types
symantic find refs src/foo.ts:Bar --exclude-tests
symantic find callers src/foo.ts:Bar          # incoming call hierarchy
symantic gain                                  # estimated token savings to date
symantic edit rename src/foo.ts:Bar --to Baz  # rename across the project, writes the files
symantic edit rename src/foo.ts:Bar --to Baz --dry-run   # same result, nothing written
```

`edit` is the only group that writes. `edit rename` returns `{ dryRun, changed: [{ path, edits }], unchanged? }`;
renaming to the same name, or repeating a rename that is done, reports `unchanged` with exit 0.

## JSON output

`--json` prints one object. A list command returns `{ items, total }` (plus `next` when the list is cut off,
and a `hint` on how to widen the query when `items` is empty); `view outline`, `view context`,
`view region`, `view file` and `resolve` return their single result object. `gain --json` lists
`topOps` as `{ op, count }` objects.

`find symbol`, `find refs`, `exports` and `usage` return at most 50 items (`--limit`, default 50) in a stated
order, and skip items with `--cursor`. A cut result ends with `50 of 410 shown. Narrow with ..., or raise
--limit` and a `next:` line (`next` in JSON): the exact command that returns the following page.

## Errors and exit codes

Results go to stdout; every failure goes to stderr as one line plus a `hint:` line, or with `--json`
as one object `{ status, code, message, context, hint }`. Branch on `code` or the exit class:

| Exit | Meaning                                         | Codes                                                                                   |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0    | success, including a query that matches nothing |                                                                                         |
| 1    | unexpected error                                | `INTERNAL`                                                                              |
| 2    | usage error                                     | `VALIDATION_ERROR`, `UNKNOWN_OPTION`, `UNKNOWN_COMMAND`, `MISSING_COMMAND`, `AMBIGUOUS` |
| 3    | not found                                       | `NOT_FOUND`, `NO_PROJECT`                                                               |
| 5    | a file could not be written                     | `WRITE_FAILED` (files already written were restored)                                    |
| 6    | a file changed under an edit                    | `CONFLICT` (nothing was written)                                                        |

`context` names the offending input (`flag` and `value`, `symbol`, `tsconfig`); `MISSING_COMMAND` and
`UNKNOWN_COMMAND` list `availableCommands`, `AMBIGUOUS` lists the `candidates` addresses.

Run `symantic <command> --help` for flags: each page leads with runnable examples, marks required
arguments, states what the command changes (nothing in the project, or the files `edit` writes), and lists the `--json` fields and
the exit codes. Full operation set and addressing scheme in the
[root README](https://github.com/nam-hle/symantic#readme).

## License

MIT
