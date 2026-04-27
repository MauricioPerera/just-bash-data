# Implementation Tickets — `@local/just-bash-data`

Order matters: each ticket assumes the previous ones merged. Total estimated scope: ~1.5–2 days for a single agent session.

---

## TKT-001 — Project scaffold

**Goal:** repo boots and tooling runs on empty source.

**Deliverables:**
- `package.json` per CONTRACT §3
- `tsconfig.json`, `tsup.config.ts`, `eslint.config.js`, `vitest.config.ts`
- `.gitignore`, `.npmignore`
- Empty `src/index.ts` exporting nothing
- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all exit 0

**Done when:** all five `pnpm` commands above pass on a clean clone.

**Blocked by:** —

---

## TKT-002 — Error and runner primitives

**Goal:** consistent error → exit-code mapping for every command.

**Deliverables:**
- `src/lib/errors.ts` — `CommandError`, `EXIT` constants
- `src/lib/runner.ts` — `runCommand(handler)` wrapper
- `src/lib/args.ts` — `parseArgs` wrapper (`{ positional, flags }`)
- Unit tests for each in `tests/lib/`

**Done when:** runner converts every `CommandError` to `CommandResult` with the right exit code; non-`CommandError` throws map to exit 1 with `stderr = err.message`.

**Blocked by:** TKT-001

---

## TKT-003 — Storage layer (Memory + EncryptedBin + Persister + Registry)

**Goal:** sync MemoryAdapter feeds upstream libs; Persister hydrates/flushes atomically against `IFileSystem`; Registry orchestrates lifecycle.

**Deliverables:**
- `src/adapter.ts` (MemoryAdapter + EncryptedBinAdapter) per `specs/adapter.md`
- `src/persister.ts` per `specs/adapter.md`
- `src/registry.ts` per `specs/adapter.md`
- `tests/fixtures/mockFs.ts` (single MockFs implementing IFileSystem)
- `tests/adapter.test.ts` covering MemoryAdapter, EncryptedBinAdapter, Persister roundtrip, Registry hydrate/flush idempotency

**Done when:**
- Sync read-after-write works on MemoryAdapter
- Encryption roundtrip on EncryptedBinAdapter (cipher ≠ plaintext, decrypted == plaintext)
- Persister writes atomically (always via `.tmp` + `mv`) — verified via spy on `fs.mv`
- Persister deletes via `fs.rm(_, { force: true })`
- Registry.ensureHydrated runs hydrate exactly once even if called concurrently 10×
- Registry.flushIfDirty is a no-op when no dirty entries

**Blocked by:** TKT-002

**Notes:** sync/async incompatibility between upstream and IFileSystem confirmed. The layered design is the workaround.

---

## TKT-004 — `db` command (core CRUD + indexes)

**Goal:** `db` works for non-auth subcommands.

**Deliverables:**
- `src/commands/db.ts` — subcommands: insert, find, count, update, remove, aggregate, drop, stats, index (create/drop/list)
- `tests/db.test.ts` covering all rows in the test plan except auth/RBAC

**Done when:** db coverage matrix (non-auth section) is 100% green.

**Blocked by:** TKT-003

---

## TKT-005 — `db auth` subcommands

**Goal:** JWT + RBAC on `db`.

**Deliverables:**
- Extend `src/commands/db.ts` with `auth register|login|verify|logout|role`
- Token resolution from `--token` flag or `ctx.env.AUTH_TOKEN`
- Auth enforcement on writes when `authSecret` configured
- Auth tests in `tests/db.test.ts`

**Done when:** auth coverage matrix is 100% green.

**Blocked by:** TKT-004

---

## TKT-006 — `vec` command

**Goal:** vector store fully exposed in shell.

**Deliverables:**
- `src/commands/vec.ts` — subcommands: create, store, store-batch, search, search-across, get, remove, stats, import, export, drop
- `tests/vec.test.ts` covering the matrix on both `MockBinaryFs` and `MockTextOnlyFs`
- IVF + matryoshka + quantization tests

**Done when:** vec coverage matrix is 100% green; recall thresholds in `specs/test-plan.md` met.

**Blocked by:** TKT-003

---

## TKT-007 — Plugin entry + encryption

**Goal:** public surface ready for downstream consumers.

**Deliverables:**
- `src/index.ts` — exports `dbCommand`, `vecCommand`, `createDataPlugin(opts)`
- `EncryptedAdapter` wrapping when `encryptionKey` set
- `EncryptedBinAdapter` for vector binary blobs (AES-256-GCM, fresh IV per write)
- ESM + CJS dual build verified

**Done when:** importing from both ESM and CJS works on Node 22; persisted bytes in encrypted mode contain no plaintext values (asserted in tests).

**Blocked by:** TKT-005, TKT-006

---

## TKT-008 — Integration tests

**Goal:** plugin loads and runs inside a real just-bash shell.

**Deliverables:**
- `tests/integration.test.ts` per `specs/test-plan.md`
- 4 end-to-end scenarios green

**Done when:** integration suite passes; `pnpm test` total runtime < 30s.

**Blocked by:** TKT-007

---

## TKT-009 — Acceptance pass

**Goal:** lock the contract.

**Checklist:** every box in CONTRACT §6 ticked. Zero `any`. Zero comments beyond `// why:`. No README or docs added. Working tree uncommitted.

**Done when:** the agent reports the §6 checklist with all green and no items deferred.

**Blocked by:** TKT-008

---

## Risk log

| risk | mitigation |
|------|------------|
| `ctx.fs` API surface differs from spec | TKT-003 halts and reports per CONTRACT §7 |
| `js-doc-store` adapter contract changes between releases | pin exact version in `package.json` after first install |
| `js-vector-store` quantization recall too low for tests | tune fixture vector distribution; do NOT relax recall threshold below 0.7 |
| just-bash text-only FS produces large `.b64` files for vectors | accept ~33% size overhead; document in adapter spec only (not in code) |
| Encryption + IVF interaction (centroids encrypted at rest) | encrypt the whole `*.bin` blob, decrypt fully on load — no streaming |
