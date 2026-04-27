# CONTRACT — `@local/just-bash-data`

## 1. Objective

Build a just-bash plugin that registers two custom commands — `db` (document store via `js-doc-store`) and `vec` (vector store via `js-vector-store`) — both persisted on a single `ctx.fs`-backed adapter.

Success: every check in §6 passes on Node 22 LTS with the latest `just-bash` and the packages pinned in §3.

## 2. Inputs and Outputs

### Public API

```typescript
// src/index.ts
export function createDataPlugin(opts?: PluginOptions): CustomCommand[];

export type PluginOptions = {
  encryptionKey?: string; // wraps adapter with EncryptedAdapter
  authSecret?: string;    // JWT secret for js-doc-store Auth
  rootDir?: string;       // default: "/data"
};
```

### Lifecycle

`createDataPlugin` is called **once** when the just-bash shell is constructed. The returned `CustomCommand[]` closes over a single registry holding the `JustBashAdapter` + per-collection `DocStore` / `VectorStore` instances. The registry persists across command invocations within the same shell so that `_dirtyIds` and in-memory indexes survive between calls. Commands themselves remain stateless functions; all mutable state lives on the registry. A new shell = a new registry. There are no module-level globals.

### Command I/O contract (uniform)

- args: `string[]`
- ctx: `{ fs, cwd, env, stdin, exec }`
- returns: `Promise<{ stdout: string; stderr: string; exitCode: number }>`

Exit codes:

| code | meaning |
|------|---------|
| 0 | success |
| 1 | runtime/internal error |
| 2 | usage error (bad args) |
| 3 | not found (collection / id) |
| 4 | auth error (missing/invalid/expired token) |
| 5 | validation error (schema/index violation) |

`stdout` is JSON when `exitCode === 0`. `stderr` is plain text.

Per-subcommand args, stdout shape, and exit-code mapping: `specs/cmd-db.md`, `specs/cmd-vec.md`.

### Storage architecture

Upstream libs call their adapters **synchronously**; `IFileSystem` is **async**. Bridged via three layers:

- `MemoryAdapter` (sync, Map-backed, json + bin) — what doc-store / vector-store see.
- `Persister` (async) — hydrates `MemoryAdapter` from `IFileSystem` on first use; flushes dirty entries back atomically (`<name>.tmp` + `fs.mv`).
- `PluginRegistry` orchestrates lifecycle: `ensureHydrated(fs)` once, `flushIfDirty(fs)` after every mutating command.

Encryption is an optional sandwich between MemoryAdapter and the upstream lib: `EncryptedAdapter` (from js-doc-store) for json, custom `EncryptedBinAdapter` for bin. The sandwich is half-async (sync `read/write`, async `preload/persist`) and is driven by the registry around hydrate/flush boundaries.

Full rules: `specs/adapter.md`.

## 3. Pinned Stack and Dependencies

- Runtime: Node.js 22 LTS
- Language: TypeScript 5.6+, `strict: true`
- Test: vitest 2.x
- Build: tsup (dual ESM + CJS)
- Lint: eslint + @typescript-eslint
- Runtime deps (installed from GitHub, not npm — neither library is published):
  - `js-doc-store: github:MauricioPerera/js-doc-store`
  - `js-vector-store: github:MauricioPerera/js-vector-store`
- Peer dep: `just-bash` (npm `just-bash`, ≥ 2.14)
- DO NOT use: `mongodb`, `mongoose`, `faiss`, `hnswlib-node`, `axios`, `lodash`, `uuid` (use `crypto.randomUUID`), `commander`, `yargs`, any other DB/ANN driver.

## 4. Project Patterns

NEW project. Establish these patterns:

- Command files in `src/commands/<name>.ts`, each exports the result of `defineCommand(...)`.
- Subcommand dispatch via `Map<string, Handler>`. No if/else chains.
- Args parsing with `parseArgs` from `node:util`. Wrap in `src/lib/args.ts`.
- All persistence I/O goes through `JustBashAdapter`. Command code MUST NOT touch `ctx.fs` directly.
- Errors thrown as `class CommandError extends Error { exitCode: number }`. A single top-level `runCommand` wrapper converts to `CommandResult`.
- Tests under `tests/`, mirroring `src/`. One file per subcommand area.

## 5. Artifacts to Produce

1. `package.json` — name `@local/just-bash-data`, `type: "module"`, `exports` map (ESM + CJS).
2. `tsconfig.json` — `strict`, target ES2022, `moduleResolution: "bundler"`. ≤30 lines.
3. `tsup.config.ts` — dual format build, `dts: true`. ≤20 lines.
4. `src/adapter.ts` — `MemoryAdapter` + `EncryptedBinAdapter` (sync). ≤180 lines. Spec: `specs/adapter.md`.
4a. `src/persister.ts` — async hydrate + flush over `IFileSystem`. ≤180 lines. Spec: `specs/adapter.md`.
4b. `src/registry.ts` — `PluginRegistry` orchestration. ≤120 lines. Spec: `specs/adapter.md`.
5. `src/commands/db.ts` — `db` command entry + dispatch. ≤120 lines. May import handlers from `src/commands/db/<sub>.ts`, each ≤80 lines. Spec: `specs/cmd-db.md`.
6. `src/commands/vec.ts` — `vec` command + subcommands. ≤200 lines. Spec: `specs/cmd-vec.md`.
7. `src/lib/errors.ts` — `CommandError`, exit-code constants. ≤40 lines.
8. `src/lib/args.ts` — `parseArgs` wrapper returning `{ positional, flags }`. ≤60 lines.
9. `src/lib/runner.ts` — `runCommand(handler)` that maps `CommandError` to `CommandResult`. ≤40 lines.
10. `src/index.ts` — public exports + `createDataPlugin()`. ≤50 lines.
11. `tests/adapter.test.ts` — adapter unit + binary fallback tests. ≤200 lines.
12. `tests/db.test.ts` — `db` coverage per §6. ≤300 lines.
13. `tests/vec.test.ts` — `vec` coverage per §6. ≤200 lines.
14. `tests/fixtures/mockFs.ts` — text-only and binary-capable mock `ctx.fs`. ≤120 lines.
15. `tests/fixtures/data.ts` — 50 sample docs + 50 sample vectors (dim 8). ≤80 lines.

DO NOT generate: README, CHANGELOG, LICENSE, examples/, docs/, .github/, scripts/.

## 6. Acceptance Criteria

- [ ] `pnpm test` 100% green
- [ ] `pnpm lint` clean
- [ ] `pnpm typecheck` clean (no `any`, no `@ts-ignore`, no `@ts-expect-error` outside test fixtures)
- [ ] `pnpm build` emits valid ESM + CJS + `.d.ts`
- [ ] Adapter contract tests pass on both text-only and binary-capable mock `ctx.fs`
- [ ] `db` covers: `insert`, `find` (with `$eq`/`$gt`/`$in`/`$regex`), `update`, `remove`, `count`, `index create`, `index drop`, `aggregate` (`$lookup` + `$group`), `auth register`, `auth login`, `auth verify`, `drop`
- [ ] `vec` covers: `create` (float32 + int8 + polar + binary quantizations), `store`, `search`, `get`, `remove`, `import`, `export`, `stats`, `drop`
- [ ] Every error path returns the exit code mapped in §2
- [ ] When `PluginOptions.encryptionKey` is set, the adapter is wrapped with `EncryptedAdapter` and persisted bytes are AES-256-GCM (verifiable via `isEncrypted`)
- [ ] When `PluginOptions.authSecret` is set, `db` requires a valid JWT for: `insert`, `update`, `remove`, `drop`, `index create`, `index drop`, `auth role assign`, `auth role remove`. Reads (`find`, `count`, `aggregate`, `stats`, `index list`, `auth verify`) remain public.
- [ ] Role-gated subcommands (`drop`, `auth role assign`, `auth role remove`) require role `admin` on the resolved token
- [ ] No file exceeds the line limits in §5
- [ ] No runtime dependency beyond §3
- [ ] Both ESM and CJS entry points load without warnings on Node 22

## 7. Hard Constraints

- DO NOT modify files outside the project root.
- DO NOT add explanatory comments in code beyond a single-line `// why: …` where the rationale is non-obvious. No JSDoc paragraphs, no section banners.
- DO NOT generate README, CHANGELOG, LICENSE, or any documentation file.
- DO NOT use `any`. Use `unknown` + narrowing, or generics.
- DO NOT bypass `JustBashAdapter` to call `ctx.fs` from command code.
- DO NOT mock `js-doc-store` or `js-vector-store`. Use the real packages against `MemoryStorageAdapter` or `JustBashAdapter` on the mock `ctx.fs`.
- DO NOT silently swallow errors. Every catch maps to a defined exit code via `CommandError`.
- DO NOT add CI workflows, husky, lint-staged, or git hooks.
- DO NOT commit. Leave the working tree uncommitted.
- DO NOT invent `ctx.fs` methods. If the installed `just-bash` exposes a different surface than `specs/adapter.md`, STOP and report the discrepancy.
- If any criterion in §6 cannot be met, STOP and report the block. No silent workarounds.
