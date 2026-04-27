# Adapter & Persistence Spec

The integration sits on a layered design because `js-doc-store` and `js-vector-store` call their adapters **synchronously**, while just-bash `IFileSystem` is **fully async**. The two cannot bridge directly.

## Layers (bottom to top)

```
IFileSystem (async, just-bash 2.14+)
    ↑ ↓  Persister
MemoryAdapter (sync, Map-backed, json + bin)
    ↑ ↓  optional sandwich
EncryptedAdapter (json) / EncryptedBinAdapter (bin)
    ↑
DocStore / VectorStore (sync clients)
```

Files involved:

- `src/adapter.ts` — `MemoryAdapter`, `EncryptedBinAdapter` (both sync). ≤180 lines.
- `src/persister.ts` — `Persister` (async hydrate + flush). ≤180 lines.
- `src/registry.ts` — `PluginRegistry` orchestrating the layers. ≤120 lines.

## `MemoryAdapter` (sync)

```typescript
class MemoryAdapter {
  readJson(name: string): unknown | null;
  writeJson(name: string, data: unknown): void;
  readBin(name: string): Uint8Array | null;
  writeBin(name: string, data: Uint8Array): void;
  delete(name: string): void;
  // surfaces for Persister:
  snapshotJson(): Map<string, unknown>;
  snapshotBin(): Map<string, Uint8Array>;
  loadJson(name: string, data: unknown): void; // hydrate
  loadBin(name: string, data: Uint8Array): void;
  takeDirty(): { jsonChanged: Set<string>; binChanged: Set<string>; deleted: Set<string> };
}
```

- One `Map<string, unknown>` for JSON, one `Map<string, Uint8Array>` for binary.
- `delete` removes from both, adds the name to the dirty `deleted` set.
- Every `writeJson` / `writeBin` adds the name to its respective `*Changed` set.
- `takeDirty()` returns the sets and clears them. Persister calls this before flushing.
- `loadJson` / `loadBin` populate the maps without touching dirty sets (used during hydration).

## `EncryptedBinAdapter` (sync, optional sandwich)

Mirrors `js-doc-store`'s `EncryptedAdapter` API for binary content. Required because upstream `EncryptedAdapter` covers only JSON.

```typescript
class EncryptedBinAdapter {
  constructor(inner: MemoryAdapter, key: CryptoKey);
  static create(inner: MemoryAdapter, password: string, salt?: string): Promise<EncryptedBinAdapter>;
  readBin(name: string): Uint8Array | null;
  writeBin(name: string, data: Uint8Array): void;
  delete(name: string): void;
  // sandwich lifecycle:
  preload(names: string[]): Promise<void>;
  persist(): Promise<void>;
  // pass-through for any json calls (no encryption on json — that's EncryptedAdapter's job):
  readJson(name: string): unknown | null;
  writeJson(name: string, data: unknown): void;
}
```

- Wire format on disk (within `inner`): `Uint8Array` of `[12-byte IV][ciphertext]`. AES-256-GCM.
- `writeBin(name, plain)` → store plaintext in `_cache: Map<string, Uint8Array>` and mark `_pending.add(name)`. Pass-through `readBin` returns from `_cache`.
- `persist()` encrypts each pending entry with a fresh IV, calls `inner.writeBin(name, [iv|ct])`, clears pending.
- `preload(names)` reads each from `inner.readBin`, decrypts, populates `_cache`.
- Bytes that pass through `inner.writeBin` to the Persister are already ciphertext.

## `Persister` (async)

```typescript
import type { IFileSystem } from "just-bash";

class Persister {
  constructor(fs: IFileSystem, root: string);
  hydrate(mem: MemoryAdapter): Promise<void>;
  flush(mem: MemoryAdapter, encJson?: EncryptedAdapter, encBin?: EncryptedBinAdapter): Promise<void>;
}
```

### `hydrate`

1. `await fs.mkdir(root, { recursive: true })`.
2. `entries = await fs.readdir(root)` (returns leaf names).
3. For each entry:
   - `stat = await fs.stat(resolvePath(root, entry))`. Skip non-files.
   - If name ends with `.bin` → `mem.loadBin(entry, await fs.readFileBuffer(absPath))`.
   - Else (json files: `*.json`, `*.idx.json`, `*.sidx.json`, `*.docs.json`, `*.meta.json`, `*.schema.json`, `*.views.json`) → `mem.loadJson(entry, JSON.parse(await fs.readFile(absPath, "utf8")))`.
   - Unknown extensions: skip with a single warning to stderr (not exit).
4. If `encJson` provided: collect every json filename hydrated, `await encJson.preload(filenames)`.
5. If `encBin` provided: same with `*.bin` filenames and `encBin.preload`.

### `flush`

1. If `encJson` provided: `await encJson.persist()`. The encrypted bytes land in `mem` via `inner.writeJson`, which marks them dirty.
2. If `encBin` provided: `await encBin.persist()`.
3. `dirty = mem.takeDirty()`.
4. For each name in `dirty.jsonChanged`:
   - `data = mem.snapshotJson().get(name)` — already encrypted if encryption was active.
   - Write atomic: `await fs.writeFile(absPath + ".tmp", JSON.stringify(data), "utf8")`, then `await fs.mv(absPath + ".tmp", absPath)`. On failure, `await fs.rm(absPath + ".tmp", { force: true })`.
5. For each name in `dirty.binChanged`: same pattern with `Uint8Array` payload.
6. For each name in `dirty.deleted`: `await fs.rm(absPath, { force: true })`.

Concurrency: a single in-flight `flush` is allowed per registry. Re-entrant calls await the active promise.

## `PluginRegistry`

```typescript
class PluginRegistry {
  constructor(opts: PluginOptions);
  ensureHydrated(fs: IFileSystem): Promise<void>;
  flushIfDirty(fs: IFileSystem): Promise<void>;
  getDocStore(): DocStore;
  getVectorStoreFor(coll: string, dim: number, quantize: Quantize, metric: Metric): VectorStore | QuantizedStore | BinaryQuantizedStore | PolarQuantizedStore;
  // exposed for tests:
  readonly mem: MemoryAdapter;
  readonly encJson?: EncryptedAdapter;
  readonly encBin?: EncryptedBinAdapter;
}
```

Lifecycle:

- Constructed once inside `createDataPlugin`. No I/O at construction.
- `ensureHydrated` runs the `Persister.hydrate` once and caches the result via a `Promise<void>` field; subsequent calls return the same promise.
- `flushIfDirty` is called at the end of every mutating command. Read-only commands skip it.
- `--root=<path>` flag: a separate `PluginRegistry` instance lives per distinct root, indexed in a `Map<string, PluginRegistry>` inside `createDataPlugin`.

## Path layout (under `root`)

| File | Owner | Notes |
|------|-------|-------|
| `<coll>.docs.json` | doc-store | document array |
| `<coll>.meta.json` | doc-store | index metadata |
| `<coll>.<field>.idx.json` | doc-store | hash index |
| `<coll>.<field>.sidx.json` | doc-store | sorted index |
| `<coll>.schema.json` | doc-store Table | column schema |
| `<coll>.views.json` | doc-store Table | saved views |
| `<coll>.bin` | vector-store | raw vectors |
| `<coll>.json` | vector-store | dim/count/quantize/idMap |
| `_auth.users.json` | doc-store Auth | users (encrypted if active) |
| `_auth.sessions.json` | doc-store Auth | sessions |

## What is NOT in this layer

- `IFileSystem` errno parsing — failures bubble through `Persister`; runner converts to `CommandError(1)`.
- Schema validation — that's `Table` from doc-store.
- Auth — that's `Auth` from doc-store.

## Constraints

- All sync-facing methods (`MemoryAdapter`, `EncryptedBinAdapter`) MUST NOT use `await` or return Promises.
- `Persister` MUST NOT mutate adapter dirty sets directly. It always goes through `takeDirty()`.
- No `Buffer` — `Uint8Array` throughout.
- No global state. Registry instance lives in the closure of `createDataPlugin`.
