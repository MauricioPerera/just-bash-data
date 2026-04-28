# Test Plan

Framework: vitest 2.x. All tests run on Node 22, no external services, no network.

## Test layout

```
tests/
  fixtures/
    mockFs.ts         # MockFs implementing just-bash IFileSystem in-memory
    data.ts           # 50 sample docs + 50 sample vectors (dim=8), seeded PRNG
  adapter.test.ts
  db.test.ts
  vec.test.ts
  integration.test.ts # plugin loaded via real just-bash Bash instance
```

## `tests/fixtures/mockFs.ts`

Single `MockFs` class implementing the just-bash `IFileSystem` interface in-memory: backing `Map<string, FsEntry>`, supports `readFile` / `readFileBuffer` / `writeFile(string|Uint8Array)` / `exists` / `mv` / `rm` / `mkdir` / `resolvePath` / `stat`. Methods that the adapter does not call may throw `not implemented` — the test runner asserts the adapter never calls them. ≤120 lines.

No "text-only" variant — see adapter spec; `IFileSystem` mandates binary support, the fallback is dropped.

## `tests/adapter.test.ts`

Covers the three storage classes against a single `MockFs` IFileSystem mock.

### MemoryAdapter (sync)
- readJson/writeJson roundtrip; readJson returns null on missing
- readBin/writeBin roundtrip with `Uint8Array(1024)`
- delete removes from both maps and adds to deleted set
- `takeDirty()` returns and clears sets; second call is empty
- `loadJson` / `loadBin` populate without marking dirty

### EncryptedBinAdapter (sync sandwich)
- writeBin then readBin returns plaintext (cache path)
- After `persist()`, `inner.readBin(name)` returns ciphertext (≠ plaintext, length = 12 + plaintext.length + 16)
- After `persist()`, internal `_pending` is empty
- `preload([names])` populates `_cache` so subsequent `readBin` returns plaintext
- Wrong password (different `create()` call) → `preload()` does not throw, but cache lookups return `null`

### Persister roundtrip (async)
- `hydrate` calls `fs.readdir(root)` once, `fs.stat` per entry, `readFile` for `*.json`, `readFileBuffer` for `*.bin`
- `flush` writes via `<name>.tmp` then `fs.mv` (spy assertion on call order)
- `flush` calls `fs.rm(_, { force: true })` for each name in deleted set
- Mid-flush mv failure: `.tmp` is cleaned via `fs.rm(_.tmp, { force: true })` in finally
- Concurrent `hydrate()` calls share the same Promise (verified via spy on `readdir` call count)
- After hydrate + no mutation + flush: zero `fs.writeFile` calls

### Registry
- `ensureHydrated` is idempotent (10 parallel calls → 1 hydrate)
- `flushIfDirty` is a no-op when MemoryAdapter has no dirty entries (zero `fs.writeFile`)
- Distinct `IFileSystem` instances or distinct `rootDir` plugin options produce distinct registries

## `tests/db.test.ts`

Real `js-doc-store` over `JustBashAdapter` over `MockFs`.

Coverage matrix:

| subcommand | happy path | usage error (2) | not found (3) | auth error (4) | validation (5) |
|---|---|---|---|---|---|
| insert | ✓ | ✓ (bad json) | n/a | ✓ (with authSecret) | ✓ (unique index dup) |
| find | ✓ ($eq, $gt, $in, $regex, dot-notation) | ✓ | ✓ | n/a | n/a |
| count | ✓ | ✓ | ✓ | n/a | n/a |
| update | ✓ ($set, $inc, $push) | ✓ | ✓ (missing coll) | ✓ | ✓ |
| remove | ✓ (single + --many) | ✓ | ✓ | ✓ | n/a |
| aggregate | ✓ ($lookup single + array, $group with $sum) | ✓ | ✓ | n/a | n/a |
| index create | ✓ (hash, sorted, unique) | ✓ | n/a | n/a | ✓ (dup with --unique) |
| index drop / list | ✓ | ✓ | ✓ | n/a | n/a |
| drop | ✓ | n/a | ✓ | ✓ (RBAC admin missing) | n/a |
| stats | ✓ | n/a | ✓ | n/a | n/a |
| auth register | ✓ | ✓ | n/a | n/a | ✓ (dup user) |
| auth login | ✓ | ✓ | n/a | ✓ (bad pass) | n/a |
| auth verify | ✓ | n/a | n/a | ✓ (expired token) | n/a |
| auth logout | ✓ (single + --all) | n/a | n/a | ✓ | n/a |
| auth role assign/remove | ✓ | ✓ | ✓ (user missing) | ✓ | n/a |

Plus:
- stdin pipeline: `insert` with `-` consumes `ctx.stdin`
- `--token` flag overrides `ctx.env.AUTH_TOKEN`
- Encryption flag: persisted bytes contain no plaintext field values

## `tests/vec.test.ts`

Real `js-vector-store` over `JustBashAdapter` over `MockFs`.

Coverage matrix:

| subcommand | happy path | usage error (2) | not found (3) | validation (5) |
|---|---|---|---|---|
| create | ✓ × 4 quantizations × 2 metrics | ✓ (bad dim) | n/a | ✓ (already exists) |
| store | ✓ | ✓ (bad vector json) | ✓ (coll missing) | ✓ (dim mismatch) |
| store-batch | ✓ (jsonl from path + stdin) | ✓ | ✓ | ✓ (any record bad → skipped count) |
| search | ✓ (k-results sorted desc) | ✓ | ✓ | n/a |
| search (matryoshka) | ✓ (results subset of full search) | n/a | n/a | n/a |
| search-across | ✓ | ✓ | ✓ (any coll missing) | n/a |
| get / remove | ✓ | n/a | ✓ | n/a |
| stats | ✓ | n/a | ✓ | n/a |
| import / export | ✓ (export + drop + import roundtrip) | ✓ | ✓ | ✓ (corrupt bin) |
| drop | ✓ | n/a | ✓ | n/a |

Plus:
- IVF: `--probe` smaller than total clusters returns ≤ same hits as exhaustive search.
- Recall thresholds use deterministic fixtures (`Math.random` replaced by a seeded PRNG in `tests/fixtures/data.ts`):
  - IVF (`clusters=8 probe=4`): recall@10 ≥ 0.8 against exhaustive baseline
  - int8 quantization: top-10 overlap ≥ 0.7 with float32 baseline
  - polar / binary quantization: top-10 overlap ≥ 0.5 with float32 baseline
- If a threshold fails on the seeded fixture, STOP and report the seed + observed recall. Do NOT relax the threshold to make the test pass.

## `tests/integration.test.ts`

Spin up a real just-bash shell with `customCommands: createDataPlugin({ encryptionKey: "test-key", authSecret: "jwt-secret" })`. Run end-to-end shell scripts:

1. `db users insert ... && db users find ...`
2. RAG-style: `vec create docs --dim 8 && vec store-batch docs - <<< $JSONL && vec search docs "$Q" | jq`
3. Auth flow: `register → login → write-with-token → revoke → write-fails`
4. Encryption: read raw `<root>/users.docs.json` from the virtual FS post-test → assert no plaintext field values present

## Performance budget (informational)

Run `pnpm test` end-to-end in under 30 seconds on a 2024 laptop. Failures here do not fail CI but produce a warning in the test output.

## What is NOT tested

- `js-doc-store` and `js-vector-store` internal logic (assumed correct upstream)
- just-bash internals
- Real disk I/O (always against mock `ctx.fs`)
