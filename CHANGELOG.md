# Changelog

All notable changes to `just-bash-data` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-04-28

### Added

- **`PluginOptions.salt`** — configurable PBKDF2 salt for encryption.
  - When unset (default), the JSON adapter keeps `js-doc-store-v1` and the bin adapter keeps `js-vector-store-v1` — exactly v1.0.x behavior, byte-equivalent on disk.
  - When set, the JSON adapter uses `${salt}:json` and the bin adapter uses `${salt}:bin` — preserving the two-distinct-keys property of the defaults while letting the operator rotate the keying material independently of the password.
  - **Migration caveat**: changing the salt is equivalent to changing the password from the data's perspective — existing files become unreadable. Decrypt with the old config first (`db <coll> export` / `vec export`), drop, recreate with the new salt, reimport.

- **`vec verify <coll>`** — explicit decrypt-success check.
  - Returns `{coll, ok, encrypted, binFile [, reason]}`. Always exit 0; the truth lives in the JSON.
  - Distinguishes the three states a `vec stats` query couldn't:
    - `{ok: true, encrypted: false}` — no encryption configured
    - `{ok: true, encrypted: true}` — decrypted successfully
    - `{ok: false, encrypted: true, reason: "decrypt failed (...)"}` — wrong key, tampered ciphertext, or truncated IV
  - Companion to v1.0.1's `corrupted: true` flag in `vec stats`. `vec verify` is the explicit, foreground check; `vec stats` is the implicit one.

### Test coverage

- **`smoke-full.mjs` extended from 181 → 243 E2E assertions.** Now exercises every feature added since v0.4.0: `vec stats sizeBytes`, IVF lifecycle (`build`/`stats`/`drop`/`--no-ivf`), lenient JSON (bareword keys / single-quoted strings / trailing commas), MongoDB-shell sentinels (`db.<coll>` / `vec.<coll>`), all 4 operator validators ($-prefix on filter / pipeline / group accumulator / update operator), collection name validation (path-traversal rejection), encryption salt round-trip, and `vec verify` in all three states.
- 13 new vitest tests in `tests/v110-features.test.ts` — total **264/264** (was 251).

### Compatibility

Zero breaking changes. Both additions are opt-in:

- Existing `createDataPlugin({ encryptionKey: ... })` calls produce the same disk format as v1.0.x.
- `vec verify` is a new subcommand; existing `vec` invocations are unaffected.

The 8-model agent transcript replay still produces 103/107 exit 0 — zero regressions.

## [1.0.1] — 2026-04-28

### Fixed

Five bugs surfaced by post-1.0.0 code review. All fixes are non-breaking (PATCH semver):

- **🔴 Path traversal in collection names.** `db ../escape insert ...` would resolve through `Persister.absPath` to a path outside `rootDir` and write `<rootDir>/../escape.docs.json` on disk-backed `IFileSystem` implementations. Added `validateCollName(name)` matching `^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$` (no dots, slashes, or `..` components) and wired it into:
  - `db.ts` dispatcher (covers all `db <coll>` subcommands in one call)
  - `vec/shared.ts:requireVecColl` (covers all read/mutate ops on existing collections)
  - `vec/ops.ts:createOp` (covers the creation path explicitly)
  - Internal manifest filenames (`_users`, `_sessions`, `_vec.registry.json`) are written by hardcoded constants and bypass the check by design.

- **🟡 Dirty-marker loss on partial flush failure.** `Persister.doFlush` called `mem.takeDirty()` upfront, draining all pending writes. If `atomicWrite` then threw mid-loop (ENOSPC, EBUSY, antivirus lock, etc.), the unwritten entries silently lost their dirty markers — the next flush would no-op and the data would never reach disk. Now wraps the write loop in try/catch and calls a new `MemoryAdapter.restoreDirty()` to re-mark unwritten entries before re-throwing.

- **🟡 `db stats sizeBytes` reported chars instead of UTF-8 bytes.** `JSON.stringify(docs).length` is the UTF-16 code-unit count; multi-byte characters (Spanish accents, Japanese, emoji) caused under-reporting. Now uses `new TextEncoder().encode(...).byteLength`, matching `vec stats`'s convention.

- **🟡 `vec import` skipped runtime validation.** Records were `as`-cast to the upstream type without verifying `id: string`, `vector: number[]`, finiteness, or dim match — a malformed input would propagate as an opaque upstream error. Extracted `checkVectorRecord()` from `storeBatchOp`'s line-by-line validator and reused it; `vec import` now rejects with `validation: import record at index N: <reason>` (exit 5) instead of crashing late.

- **🟡 `EncryptedBinAdapter` masked corruption as "empty collection".** When `preload()` failed to decrypt (wrong key, tampered ciphertext, truncated IV), the cache was set to a zero-length buffer. The no-plaintext-leak property held, but the operator had no way to distinguish "wrong key" from "legit empty collection" — both showed `count: 0`. Added a `corruptedSet` and `isCorrupted(name)` getter; `vec stats` now surfaces `corrupted: true` when applicable.

### Added

- `MemoryAdapter.restoreDirty(d)` — re-mark entries dirty after partial failure (used internally by Persister).
- `EncryptedBinAdapter.isCorrupted(name)` — query whether a name failed decryption during preload.
- `validateCollName(name)` exported from `src/lib/errors.ts`.
- `checkVectorRecord(rec, dim)` — discriminated-union validator shared by `store-batch` and `import`.
- 21 new targeted tests in `tests/v101-fixes.test.ts`. Total suite: **251/251** (was 230).

### Compatibility

All five fixes are non-breaking. The strictest contract change is `validateCollName`: collection names that previously slipped through (`foo.bar`, `with space`) now reject with exit 2. These names would have caused subtle bugs (filename collisions, path traversal, etc.) and were never officially supported — the conservative regex is enforcement of an implicit invariant.

The 8-model agent transcript replay still produces 103/107 exit 0 (96.3%) — zero regressions from the fixes.

## [1.0.0] — 2026-04-28

### Stability commitment

`just-bash-data` is now declared **stable**. The v0.x line shipped 9 releases over ~24 hours of focused iteration, each one driven by empirical signal from an 8-model agent benchmark. v1.0.0 ships the same code as v0.8.1 (no functional changes) and commits to **strict semver** going forward:

- **MAJOR (2.0.0+)**: any breaking change to the public API surface, exit-code contract, on-disk file layout, or documented command-line semantics.
- **MINOR (1.x.0)**: additive features. Permissive aliases that turn previously-rejected input into success are *additive*. New subcommands, new flags, new fields in JSON output are *additive*.
- **PATCH (1.0.x)**: bug fixes that don't change documented behavior, dependency bumps, build-only changes.

### Public API surface (stable as of 1.0.0)

```typescript
// Library entry — exported from "just-bash-data"
export { createDataPlugin, type PluginOptions, sentinelNames } from "just-bash-data";
```

```bash
# db command — every subcommand and flag below is a stability contract
db <coll> insert <json>
db <coll> find <filter> [--sort f:1|-1] [--limit N] [--skip N] [--project f1,f2]
db <coll> find <filter> <options-json>           # options form
db <coll> count <filter>
db <coll> update <filter> <update> [--many]
db <coll> remove <filter> [--many]
db <coll> aggregate <pipeline>
db <coll> drop                                   # admin role required when authSecret set
db <coll> stats                                  # → {count, indexes, sizeBytes}
db <coll> export                                 # → {exported, docs}
db <coll> import <docs-json>
db <coll> index create <field> [--sorted] [--unique]
db <coll> index drop <field>
db <coll> index list
db auth register|login|verify|logout|role
```

```bash
# vec command
vec create <coll> --dim N [--quantize f32|int8|polar|binary] [--metric cosine|euclidean|dot|manhattan] [--ivf [--ivf-clusters N] [--ivf-probes N]]
vec store <coll> <id> <vector-json> [--meta <json>]
vec store-batch <coll> <jsonl-path-or-->
vec search <coll> <vec> [--k N=10] [--metric M] [--matryoshka csv] [--no-ivf]
vec search-across <coll-csv> <vec> [--k N=10]
vec get|remove|stats|export|import|drop <coll>
vec ivf build|stats|drop <coll>
```

### Exit code contract (stable)

```
0  success — stdout is JSON
1  runtime / internal error
2  usage error (bad args, malformed JSON, dim too large)
3  not found (collection or id)
4  auth error (missing / invalid / expired token, role required)
5  validation error (unique constraint, dim mismatch, $-prefix missing, etc.)
```

### Permissive parsing aliases (stable behavior)

All of these will continue to be accepted across the 1.x line:

- Empty-string filter `''` → `{}` (read handlers only)
- Empty-string pipeline `''` → `[]` (aggregate)
- `find` options object as second positional
- `{"$sum": <number>}` → `{"$count": 1}` rewrite (counting idiom)
- Lenient JSON: bareword keys, single-quoted strings, trailing commas
- Dot-syntax sentinels for ~30 common collection names

### Operator `$`-prefix validation (stable failure mode)

- Filter operators: `eq, ne, gt, gte, lt, lte, in, nin, exists, regex, contains, size, and, or, not`
- Pipeline stages: `match, lookup, group, sort, limit, skip, project, unwind`
- Group accumulators: `count, sum, avg, min, max, push, first, last`
- Update operators: `set, unset, inc, push, pull, rename`

Bareword forms (without `$`) reject with **exit 5** + `did you mean '$X'?` hint and the path of the offending key.

### Documented hard limitations

- `db.<coll>.<method>(...)` (parens form) triggers a bash parse error before any command dispatch — uninterceptable from inside the plugin.
- `db <coll> aggregate <filter> <accumulator>` (two args instead of pipeline array) is a structural error, not a parsing one — no alias provided because the semantics of "two-arg aggregate" are ambiguous.
- IVF in `js-vector-store` always uses cosine internally; `vec search` with explicit `--metric` falls back to brute force regardless of IVF state.
- A user with a legitimate field literally named `gt`/`lt`/`set`/etc. in their data triggers a false-positive validator rejection. Mitigation: the error message names the field; rename or wrap in `$eq`.

### Empirical justification

8-model agent transcript replay against v1.0.0 (= v0.8.1):

```
Granite 4.0          16/16
Llama 3.2 3B         10/12
Llama 3.1 8B AWQ     12/12
Llama 3.1 8B FP      12/12
Llama 3.2 11B-V      15/17     (2 uninterceptable parens-form fails)
GPT-OSS-20B          13/13
Llama 4 Scout        13/13
Gemma 4 26B          12/12
─────────────────────────
                    103/107   (96.3%)
```

vs v0.4.0 reference set: +1 fix, 0 regressions, 1 silent-failure prevented. Full report: [`examples/smoke/v8-benchmark-report.md`](examples/smoke/v8-benchmark-report.md).

### Test suite

230 unit + integration tests across 14 vitest files. Plus `examples/smoke/smoke-full.mjs` E2E + the 8-model benchmark replay.

### Compatibility

Zero functional changes from v0.8.1 — the same code, the same API, the same exit codes. The version bump is purely a stability declaration.

## [0.8.1] — 2026-04-28

### Added

- **Pipeline + update operator $-prefix validation.** Extends the v0.8.0 filter validation to two more shapes the lenient JSON parser used to silently mistranslate:

  | Shape | Catches | Example error |
  |---|---|---|
  | Pipeline stage names | `[{match: {...}}]` | `pipeline stage 'match' at [0].match is missing $ prefix — did you mean '$match'?` |
  | `$match` value (recursive) | `[{$match: {year: {gt: 1950}}}]` | `pipeline[0].$match operator 'gt' at year.gt is missing $ prefix — did you mean '$gt'?` |
  | `$group` accumulators | `[{$group: {_id: null, n: {sum: 1}}}]` | `pipeline accumulator 'sum' at [0].$group.n.sum is missing $ prefix — did you mean '$sum'?` |
  | Update operators | `{set: {x: 1}}` | `update operator 'set' is missing $ prefix — did you mean '$set'?` |

  All produce **exit 5** with location info. Improves the previous behavior where `aggregate` would generic-throw `unknown aggregation operator: match` (exit 2) without naming the canonical fix.

- 18 new unit tests in `tests/lib/pipeline-update-operators.test.ts` + 10 new integration tests in `tests/db.test.ts`. Total suite: **230/230** (was 202).

### Operator sets

- **Pipeline stages**: `match`, `lookup`, `group`, `sort`, `limit`, `skip`, `project`, `unwind`
- **Group accumulators**: `count`, `sum`, `avg`, `min`, `max`, `push`, `first`, `last`
- **Update operators**: `set`, `unset`, `inc`, `push`, `pull`, `rename`

### Compatibility

- Strict canonical forms (`$match`, `$set`, etc.) are unchanged.
- The v0.2.0 `{"$sum": <number>}` → `{"$count": 1}` rewrite is preserved (regression test added).
- **Update operator validation only inspects top-level keys** — values are never recursed. So `{$set: {push: "sticky", set: 42}}` (legitimate field assignments named after operators) is accepted. Pipeline stage validation only inspects per-stage top level + `$match`/`$group` value recursion; `$project`/`$sort`/etc. values are user data and not walked.

### Caveats

- Same false-positive boundary as v0.8.0 applies: a pipeline literally typed as `[{match: {...}}]` because the user wants a stage NAMED `match` (impossible in canonical Mongo) will be rejected. Acceptable since no legitimate Mongo aggregation has unprefixed stage names.

## [0.8.0] — 2026-04-28

### Added

- **Operator-aware filter validation.** When the `db` filter argument (in `find`, `count`, `update`, `remove`) contains a non-`$`-prefixed key matching a known Mongo operator name (`gt`, `lt`, `eq`, `in`, `or`, `and`, …), the handler now rejects with **exit 5** and a clear redirect:

  ```
  validation: filter operator 'gt' at year.gt is missing $ prefix — did you mean '$gt'?
  ```

- The validator walks the entire filter tree (objects + arrays) so deep paths like `$or[1].b.lt` are reported with full location.
- 19 new unit tests in `tests/lib/filter-operators.test.ts` + 9 new integration tests in `tests/db.test.ts` covering all 4 handlers, path reporting, false-positive boundaries, and the v0.6.0 happy-path round-trip. Total suite: **202/202** (was 174).

### Why

The post-v0.7.0 retest of Llama 3.2 3B (`examples/smoke/v7-llama32-3b-report.md`) revealed that the v0.6.0 lenient JSON parser had a **silent regression**: the model emitted `{year: {gt: 1950}}` (bareword operator missing `$`), the relaxer turned it into valid JSON `{"year": {"gt": 1950}}`, but the doc-store treated `{gt: 1950}` as a literal value (no recognized operator) and matched **all** documents instead of just the 4 with `year > 1950`. The agent got `exit 0` + wrong data — strictly worse than the v0.4.0 `exit 2 invalid json: filter` it used to see.

v0.8.0 restores the loud-failure property: parse-success no longer implies semantic correctness. The agent now gets a precise error pointing at the exact key that needs `$`.

### Empirical impact (Llama 3.2 3B benchmark replay)

| | v0.4.0 | v0.7.0 | v0.8.0 |
|---|---|---|---|
| exit 0 | 10/12 | 11/12 | 10/12 |
| **functionally correct** | **10/12** | **10/12** | **10/12** |
| silent semantic failure | — | **1** | **0** |

Going from 11→10 exit-0 is the *correct* direction: cmd #7's "success" in v0.7.0 was a lie. Now the agent has actionable signal.

### Compatibility

- Strict, `$`-prefixed filters (`{"$gt": 1950}`) and the v0.6.0 lenient round-trip (`{$gt: 1950}` → `{"$gt": 1950}`) are unchanged.
- Operator names appearing as **string values** (`{"note": "use $gt"}`, `{"tags": {"$in": ["gt", "lt"]}}`) are unchanged — only object **keys** are validated.
- Pipeline (`aggregate`) and update operator (`{"$set": {...}}`) shapes are NOT yet validated. v0.8.0 scope is filter-only — pipeline-stage and update-operator validation is a candidate for v0.8.1.

### Caveats

- A user with a legitimate field literally named `gt` / `lt` / `eq` / etc. in their data will now get a false-positive rejection. The error message is explicit enough to recover (rename, or wrap in `$eq`). This is documented as a known limitation; the LLM-tooling target audience makes the trade-off favorable.

## [0.7.0] — 2026-04-28

### Added

- **MongoDB-shell-style sentinels for `db.<coll>` / `vec.<coll>`.** When an LLM emits the dot-separator form (`db.books find '{}'` instead of `db books find '{}'`), bash dispatches to the literal command name `db.books` — which is *not* the `db` command, so the plugin never sees it. v0.7.0 pre-registers ~60 sentinel commands (30 collection names × 2 tools) that respond with a redirect message:

  ```
  'db.books' is MongoDB-shell-style syntax.
  This plugin uses space-separated form: 'db books <subcommand>'.
  Example: db books find '{}'
  ```

  Sentinel exit code is **2** (bad usage). The covered name list comes from the 8-model benchmark transcripts plus common DB/test idioms (`books`, `users`, `docs`, `chunks`, `events`, `jobs`, `x`, `test`, `foo`, …). Uncovered names (`db.gadgets42`) fall through to bash's native "command not found", which is still informative.

- New export `sentinelNames(): string[]` for tests / introspection of the covered list.

- 7 new tests in `tests/sentinel.test.ts` covering registration, redirect message content, non-shadowing of real `db`/`vec`, and fall-through behavior. Total suite: **174/174** (was 167).

### Hard limitation (documented, not fixable)

- The **parenthesised form** `db.books.find('{}')` triggers a bash *parse error* on the `(` token before any command dispatch happens. There is no hook in `just-bash` to intercept syntax errors — sentinels for the parens form are physically impossible from inside the plugin. The redirect message points this out so agents stop trying.

### Why

Llama 3.2 3B in the agent benchmark consistently emitted `db.books` after seeing MongoDB documentation in pretraining. v0.6.0's lenient JSON closed the JS-literal gap; v0.7.0 closes the dot-syntax gap for the cases bash *can* dispatch.

### Compatibility

Zero breaking changes. The sentinels only respond to names that previously produced "command not found" — they never shadow `db` or `vec` themselves.

## [0.6.0] — 2026-04-28

### Added

- **Lenient JSON parsing fallback** for every `db` positional JSON argument. When strict `JSON.parse` rejects the input, the plugin retries with a permissive parser (`relaxJson`) that handles three idioms LLMs commonly emit:
  - **Bareword keys**: `{$gt: 1950}` → `{"$gt": 1950}` (the recurring benchmark trap)
  - **Single-quoted strings**: `{'name': 'Alice'}` → `{"name": "Alice"}`
  - **Trailing commas**: `{a:1,}` and `[1,2,]` survive

  Hand-rolled char-by-char tokenizer (~75 LOC, zero dependency). Only transforms tokens **outside** string literals — `{"x": "key: value"}` and `{"q": "$gt: 5"}` are unchanged through both passes.

- 21 new unit tests in `tests/lib/relax-json.test.ts` + 7 new integration tests in `tests/db.test.ts` exercising lenient JSON through `find`, `count`, `insert`, and `aggregate`. Total suite: **167/167** (was 139).

### Why

The 8-model agent benchmark identified Llama 3.2 3B and Llama 3.1 8B FP as consistent emitters of `{$gt: 1950}` JS-literal style. v0.4.0 retest left their `find` step failing for this reason. v0.6.0 closes that gap without a JSON5 dependency or any change to strict-JSON behavior.

### Compatibility

Zero breaking changes. The relaxer never runs on input that `JSON.parse` accepts directly. True garbage still produces exit 2.

### Caveats

- Narrow relaxer; no JSON5 comments, hex numbers, `Infinity`, etc. are supported.
- Bareword `true` / `false` / `null` are recognized as JSON literals (not quoted as keys).

## [0.5.0] — 2026-04-28

### Added

- **IVF (Inverted File) k-means index for `vec`.** Wraps the upstream `IVFIndex` class so collections with thousands of vectors can avoid exhaustive search. New surface:
  - `vec create <coll> --ivf [--ivf-clusters N=100] [--ivf-probes N=10]` — opt in at create time. Numeric flags imply `--ivf` (DX shortcut).
  - `vec ivf build <coll> [--sample-dims N]` — one-time k-means training; persists `<coll>.ivf.json`.
  - `vec ivf stats <coll>` — `{numClusters, numProbes, numVectors}`.
  - `vec ivf drop <coll>` — removes the index.
  - `vec search <coll> <vec> [--no-ivf]` — auto-routes through IVF when present; `--no-ivf` opts out.
  - `vec stats <coll>` now includes an `ivf: {built, numClusters, numProbes}` field when configured.
- IVF config persists to `_vec.registry.json` and the centroids file `<coll>.ivf.json` rehydrates automatically across plugin restarts.
- 12 new tests covering create variants, build/stats/drop, search routing with and without IVF, and the rehydrate path. Total suite: **139/139** (was 127).

### Constraints

- IVF in `js-vector-store` always uses cosine similarity internally. When `vec search` is called with an explicit `--metric` flag, it falls back to brute-force regardless of IVF state. Documented as a caveat in `specs/cmd-vec.md`.
- `--ivf-probes` is validated to not exceed `--ivf-clusters` (exit 2 otherwise).

### Compatibility

Zero breaking changes. Collections created without `--ivf` behave identically to v0.4.0 — the new `ivf` field is omitted from `vec create` and `vec stats` responses when IVF is not configured.

## [0.4.0] — 2026-04-28

### Added

- **`vec stats <coll>` now reports storage size.** New fields:
  - `sizeBytes`: total on-disk footprint (bin + meta JSON)
  - `binBytes`: vector blob size (varies with quantization — float32 ≈ 4× int8)
  - `metaBytes`: per-collection manifest JSON size

  Computed from the in-memory adapter snapshot, so the figures match exactly what `vec export` would persist. Useful for capacity planning and observability.

- 2 new tests verifying the size fields and the quantization scaling property (int8 < float32 bin size).

### Verified

- The `examples/smoke/embeddinggemma-demo.mjs` script was empirically validated against the live `@cf/google/embeddinggemma-300m` endpoint. Cross-lingual semantic search and matryoshka prefix property both confirmed (full results in `examples/smoke/embeddinggemma-demo.md`).

### Compatibility

Zero breaking changes — `vec stats` output gained new fields; existing fields (`dim`, `count`, `quantize`, `metric`) unchanged in name or type.

## [0.3.1] — 2026-04-28

### Fixed

- **H-3: per-handler empty-string policy.** The blanket `''` → `{}` alias added in v0.3.0 was applied universally inside `parseJson`, producing inconsistent and dangerous behavior on destructive handlers:
  - `db users insert ''` silently created an empty doc
  - `db users remove ''` silently removed the first matching doc
  - `db users update '' '...'` silently updated all matches
  - `db users aggregate ''` failed with `pipeline must be array`

  `parseJson` is now policy-aware. Each handler opts into one of three policies:

  | Policy | `''` handling | Used by |
  |---|---|---|
  | `filter` | becomes `{}` (match-all) | `find`, `count` |
  | `pipeline` | becomes `[]` (no-op) | `aggregate` |
  | `reject` | exit 2 with `<field> cannot be empty` | `insert`, `update`, `remove`, `import`, `find` options object |

- `importHandler` error messages now report the failing item index (`import item at index 847 is not an object`) instead of a generic message.
- `buildCursor` cleaned up a redundant `number → string → number` conversion when reading skip/limit from the options object.

### Added

- 10 new tests covering the H-3 policy matrix and edge cases (export of empty collection, import error indexing). Total suite: **125/125**.

### Compatibility

Read paths (`find`/`count`/`aggregate`) unchanged from v0.3.0. Destructive paths now reject `''`. Behavior change is technically breaking but no benchmark model relied on `''` for destructive operations.

## [0.3.0] — 2026-04-28

### Added

- **A1: empty-string filter alias.** `db users find ''` is treated as `db users find '{}'` (match-all). Same for `count`. Several models in the benchmark emitted `''` for "no filter" and now succeed without retries.
- **A2: Mongo-style options object as second positional in `find`.** `db users find '{}' '{"sort":{"age":-1},"limit":10}'` works alongside the flag form. When both are present, flags win. Granite and Llama 4 Scout both emitted this Mongo idiom in the benchmark.
- **B1: `db <coll> export`.** Returns `{exported: N, docs: [...]}`. Symmetric with `vec export`.
- **B2: `db <coll> import <docs-json>`.** Accepts an array of documents from positional arg or stdin (`-`). Symmetric with `vec import`.
- `examples/smoke/embeddinggemma-demo.mjs`: end-to-end demo using `@cf/google/embeddinggemma-300m` for multilingual semantic search (en/es/ja/ar/hi × 3 concepts) into the `vec` store, plus matryoshka prefix search at 768 / 512 / 256 / 128 dim.
- 8 new tests covering A1, A2, and the export/import roundtrip. Total suite: **115/115** (was 107).

### Changed

- AGENTS.md: new "Mongo-style aliases" section.
- specs/cmd-db.md: `find` updated with options object semantics; new `export` and `import` subcommand sections.

### Compatibility

Zero breaking changes — all additions are permissive aliases on previously-rejected input.

## [0.2.0] — 2026-04-28

### Added

- **`{"$sum": 1}` alias for `{"$count": 1}` in `aggregate $group`.** 7 of 8 models in the agent benchmark defaulted to the MongoDB idiom `{"$sum": 1}` for counting items per group, even with the canonical `$count` form documented in the system prompt. The pattern proved unbreakable for some models — Llama 3.2 11B Vision rewrote `$sum: 1` even when given a verbatim copy instruction with `$count: 1` literally in the prompt.

  `aggregateHandler` now rewrites `{"$sum": <number>}` to `{"$count": 1}` automatically. `{"$sum": "$field"}` (string operand) is unchanged.

- 2 new tests (Mongo idiom counting + non-string operand still computes field sum). Total suite: **107/107**.

### Empirical impact

Re-tested 3 models against v0.2.0 with identical prompts:

| Model | v0.1.0 | v0.2.0 |
|---|---|---|
| Llama 3.2 11B-V | 6/7 incomplete (5 turns, 71%) | **7/7 complete** (2 turns, 100%) |
| GPT-OSS-20B | 7/7 (2 turns, 92%) | 7/7 (1 turn, 100%) |
| Granite 4.0 | 7/7 (3 turns, 81%) | 7/7 (1 turn, 100%) |

Cumulative cost reduction across the 3 retested models: **−32% per task** vs v0.1.0.

## [0.1.0] — 2026-04-27

### Added

- Initial public release.
- Two custom commands for [`just-bash`](https://github.com/vercel-labs/just-bash) giving an in-shell agent structured-data capabilities:
  - **`db`** — MongoDB-style document store via [`js-doc-store`](https://github.com/MauricioPerera/js-doc-store): CRUD, indexes, aggregations, JWT auth, RBAC, optional AES-256-GCM at rest.
  - **`vec`** — vector similarity search via [`js-vector-store`](https://github.com/MauricioPerera/js-vector-store): float32 + int8 + polar + binary quantizations, matryoshka, cross-collection search.
- Architecture: `MemoryAdapter` (sync, Map-backed) + `Persister` (async hydrate + atomic flush via `<name>.tmp` + `fs.mv`, serialized chain) + optional encryption sandwich.
- Single registry per `IFileSystem` (cached via `WeakMap`); each `Bash` instance gets isolated state automatically.
- Build via tsup: dual ESM + CJS + `.d.ts`. Strict TypeScript, no `any`.
- 105 unit tests across 10 vitest suites + 181 E2E assertions in `examples/smoke/smoke-full.mjs` covering every subcommand, every Mongo operator, every documented exit code, encryption round-trip, and cross-instance persistence.
- MIT license, CI workflow on push/PR, GitHub Actions auto-publish on tag (added in 0.3.1 follow-up commit).

### Known limitations at release

- TypeScript consumers need `--skipLibCheck` due to an upstream `just-bash@2.14.3` packaging issue (its published `.d.ts` references files not included in the npm tarball). This plugin's own types are clean.
- `vec stats` does not include `sizeBytes`.
- `searchAcross` is implemented locally in this plugin (per-collection store architecture). Functionally equivalent to upstream for non-IVF cases.

[1.1.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v1.1.0
[1.0.1]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v1.0.1
[1.0.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v1.0.0
[0.8.1]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.8.1
[0.8.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.8.0
[0.7.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.7.0
[0.6.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.6.0
[0.5.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.5.0
[0.4.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.4.0
[0.3.1]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.3.1
[0.3.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.3.0
[0.2.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.2.0
[0.1.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.1.0
