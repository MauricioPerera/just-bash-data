# Changelog

All notable changes to `just-bash-data` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.1]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.3.1
[0.3.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.3.0
[0.2.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.2.0
[0.1.0]: https://github.com/MauricioPerera/just-bash-data/releases/tag/v0.1.0
