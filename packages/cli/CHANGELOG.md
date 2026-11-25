# Changelog

## [0.4.0](https://github.com/nam-hle/symantic/compare/v0.3.2...v0.4.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **cli:** find symbol, find refs, exports and usage return at most 50 items unless --limit is given, and find refs --json carries next (a command) instead of nextCursor. Callers that need the whole list must raise --limit or follow next.
* **cli:** --json output of find symbol, def, impls, refs, callers, callees, exports, imports, usage, view members, symbol and body is { items, total, ... } instead of a bare array (find refs: references is now items). gain --json topOps is an array of { op, count } instead of [op, count] pairs.
* **cli:** resolve and view members now exit 3 with a NOT_FOUND error on stderr when the symbol does not exist, instead of exit 0 with output on stdout. A missing file on view, imports, exports and usage is also NOT_FOUND. Callers that treated a zero exit as a successful lookup must check the exit code.
* **cli:** failures exit 2 (usage: bad flag, value, command or ambiguous address) or 3 (not found: symbol, tsconfig) instead of 1, and stderr is an error line plus hint, or a JSON envelope under --json. Callers that test for exit 1 or parse the old messages must switch to the exit classes or the code field.
* **core:** the `--engine` CLI option, the MCP `engine` argument, `EngineKind`, `LspEngine`, `createEngine({ engine })` and the `tsmorph`/`lsp` split are removed. `find refs` results now contain the declaration site (kind `declaration`), and `find def` on an import binding resolves to the true declaration instead of reporting not-found. The CLI daemon is keyed by tsconfig and version only.

### Features

* **cli:** Add edit move ([#166](https://github.com/nam-hle/symantic/issues/166)) ([86b6f85](https://github.com/nam-hle/symantic/commit/86b6f85b38d29d41994bef2332f32d18dc47408d))
* **cli:** Add edit rename ([#163](https://github.com/nam-hle/symantic/issues/163)) ([04f356f](https://github.com/nam-hle/symantic/commit/04f356fcec123229209e9a56d9e1354de2c4c247))
* **cli:** Bound list commands and say when a result is cut ([#154](https://github.com/nam-hle/symantic/issues/154)) ([b614c24](https://github.com/nam-hle/symantic/commit/b614c2474d4212b0f8028e214a241996e4f85548))
* **cli:** Lead --help with examples, effect, JSON fields and exit codes ([#155](https://github.com/nam-hle/symantic/issues/155)) ([aa7a7c7](https://github.com/nam-hle/symantic/commit/aa7a7c741759500cfe55cd2b3c124a61844c3c9a)), closes [#140](https://github.com/nam-hle/symantic/issues/140)
* **cli:** Report failures as one envelope with exit classes ([#151](https://github.com/nam-hle/symantic/issues/151)) ([bf21c05](https://github.com/nam-hle/symantic/commit/bf21c058cde905db3e6cbdd6aab439283a6a8178))
* **cli:** Wrap every --json result in one object ([#153](https://github.com/nam-hle/symantic/issues/153)) ([ab6f7c0](https://github.com/nam-hle/symantic/commit/ab6f7c07e24df81d046e3aaaed03521113eb5433)), closes [#136](https://github.com/nam-hle/symantic/issues/136)
* **core:** Usage --members reports class/interface member ref counts ([ef22ffe](https://github.com/nam-hle/symantic/commit/ef22ffee1793d7bb68e290080655f232f90c4db4)), closes [#119](https://github.com/nam-hle/symantic/issues/119)
* **core:** Use the TypeScript 7 API engine ([#129](https://github.com/nam-hle/symantic/issues/129)) ([8824701](https://github.com/nam-hle/symantic/commit/88247018dd1aa6263edf68ddac93b1146795122a))


### Bug Fixes

* **cli:** Print no colour off a terminal, usage errors to stderr ([#149](https://github.com/nam-hle/symantic/issues/149)) ([1a46969](https://github.com/nam-hle/symantic/commit/1a469692245d1495d0285333a48f7e09594d4118))
* **cli:** Reject unknown flags and invalid flag values ([#150](https://github.com/nam-hle/symantic/issues/150)) ([ae3b91d](https://github.com/nam-hle/symantic/commit/ae3b91dfb487cabe3387a54e262ffae28edd89b2))
* **cli:** Tell a missing address from an empty result ([#152](https://github.com/nam-hle/symantic/issues/152)) ([26f252c](https://github.com/nam-hle/symantic/commit/26f252c06087b23b5cb31a8544fe3dba25826316)), closes [#139](https://github.com/nam-hle/symantic/issues/139)


### Internal

* Move to TypeScript 7 ([#127](https://github.com/nam-hle/symantic/issues/127)) ([0f927ac](https://github.com/nam-hle/symantic/commit/0f927ac871e8c827697500192273d252f66c2fac))
* Replace eslint and prettier with oxlint and oxfmt ([#130](https://github.com/nam-hle/symantic/issues/130)) ([043f6f5](https://github.com/nam-hle/symantic/commit/043f6f50abb0e973c3f8000f25bc5e3f6cc71339))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @symantic/core bumped to 0.4.0

## [0.3.2](https://github.com/nam-hle/symantic/compare/v0.3.1...v0.3.2) (2026-06-13)


### Features

* **core:** Find symbol kind classification, --exclude-tests, --kind ([#110](https://github.com/nam-hle/symantic/issues/110)) ([f272681](https://github.com/nam-hle/symantic/commit/f2726814601833f2f966eb840cc6d7dcff7ac0ca))
* **core:** Scope find symbol by file path ([fd81235](https://github.com/nam-hle/symantic/commit/fd812355ef3f389180aed06c683a3f646e6f149b))


### Bug Fixes

* **core:** Hint toward :: when a member is addressed with a dot ([4d3fd63](https://github.com/nam-hle/symantic/commit/4d3fd635af4986b021c51a53849ce7a3258ca591)), closes [#101](https://github.com/nam-hle/symantic/issues/101)
* **core:** Honest miss with --engine lsp hint for external imports ([0df8b82](https://github.com/nam-hle/symantic/commit/0df8b82bbad0f7260a6ef414ed0daee115312a0e)), closes [#100](https://github.com/nam-hle/symantic/issues/100)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @symantic/core bumped to 0.3.2

## [0.3.1](https://github.com/nam-hle/symantic/compare/v0.3.0...v0.3.1) (2026-06-09)


### Internal

* Release 0.3.1 ([3df2faa](https://github.com/nam-hle/symantic/commit/3df2faa9555d7aa36fd327c6f7c33ef0b044ccc6))
* Release 0.3.1 ([f8ac888](https://github.com/nam-hle/symantic/commit/f8ac88863900a7137abd6831d71940eda9630d1b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @symantic/core bumped to 0.3.1

## [0.3.0](https://github.com/nam-hle/symantic/compare/cli/v0.2.0...cli/v0.3.0) (2026-06-09)


### ⚠ BREAKING CHANGES

* package names, binary, MCP server name, env var, and ledger path all change. Pre-publish, so no external impact.

### Features

* **cli:** Discover tsconfig by default; --tsconfig now optional ([d5cd4a7](https://github.com/nam-hle/symantic/commit/d5cd4a700c35b1e6bbbfabd40304d7cddc16bce1)), closes [#82](https://github.com/nam-hle/symantic/issues/82)
* **cli:** View body --source + DX hints for body and find symbol ([370c4e7](https://github.com/nam-hle/symantic/commit/370c4e7796ecdee627973b88b63836651668efba))
* **core:** Compact outline / refs / usage text output ([fd4f5ab](https://github.com/nam-hle/symantic/commit/fd4f5ab1b3c63ab64378113ac797e4873fe49e58))
* **core:** Fold a declaration merge in view members (membersByName) ([5953035](https://github.com/nam-hle/symantic/commit/5953035f68017ba63cfb75ca0b06f8e1819a7af5))
* Report version in CLI (--version) + MCP serverInfo ([693a021](https://github.com/nam-hle/symantic/commit/693a021d18783b86802b4809b147005b9927216b)), closes [#58](https://github.com/nam-hle/symantic/issues/58)


### Bug Fixes

* **cli:** Make gain ledger tests hermetic on Windows ([a51b1b7](https://github.com/nam-hle/symantic/commit/a51b1b766eed099979d5dbf244ab4b48cc4d7b8b))


### Documentation

* Rework root README + add subpackage READMEs ([8388bb2](https://github.com/nam-hle/symantic/commit/8388bb27c21c55b18368886d4fda53d65fff694a))
* Surface find symbol --contains; nudge on empty exact match ([4cdbea9](https://github.com/nam-hle/symantic/commit/4cdbea991584ff9e975f36208db7542e85fac6f5))


### Internal

* Lockstep versioning across core, cli, mcp ([#106](https://github.com/nam-hle/symantic/issues/106)) ([7d3fbc9](https://github.com/nam-hle/symantic/commit/7d3fbc9fbca0616f1c3db5654119bb0609bc3e35))
* Raise coverage on version, gain, and the async engine bridge ([4c0a59e](https://github.com/nam-hle/symantic/commit/4c0a59e4bd3310540a7f2c2591d3fb2422e85e4e))
* Rebrand kestrel to symantic ([f3ff609](https://github.com/nam-hle/symantic/commit/f3ff6096dd0d5e467bdc4f7cc49612d26aaac87a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @symantic/core bumped to 0.3.0
