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
  readBin(name: string): ArrayBuffer | null;
  writeBin(name: string, data: ArrayBuffer | Uint8Array): void;
  delete(name: string): void;
  hasDirty(): boolean;
  // surfaces for Persister:
  snapshotJson(): ReadonlyMap<string, unknown>;
  snapshotBin(): ReadonlyMap<string, Uint8Array>;
  loadJson(name: string, data: unknown): void; // hydrate
  loadBin(name: string, data: ArrayBuffer | Uint8Array): void;
  takeDirty(): { jsonChanged: Set<string>; binChanged: Set<string>; deleted: Set<string> };
  restoreDirty(d: { jsonChanged?: Iterable<string>; binChanged?: Iterable<string>; deleted?: Iterable<string> }): void; // v1.0.1+
}
```

- One `Map<string, unknown>` for JSON, one `Map<string, Uint8Array>` for binary.
- `delete` removes from both, adds the name to the dirty `deleted` set.
- Every `writeJson` / `writeBin` adds the name to its respective `*Changed` set.
- `takeDirty()` returns the sets and clears them. Persister calls this before flushing.
- `restoreDirty()` re-marks entries dirty after a partial flush failure (v1.0.1+). Without it, an `atomicWrite` failure mid-loop would silently drop pending writes.
- `loadJson` / `loadBin` populate the maps without touching dirty sets (used during hydration).
- `readBin` / `writeBin` accept `ArrayBuffer` *or* `Uint8Array` and store internally as `Uint8Array`; `readBin` returns `ArrayBuffer` to match the upstream `js-vector-store` adapter contract.

## `EncryptedBinAdapter` (sync, optional sandwich)

Mirrors `js-doc-store`'s `EncryptedAdapter` API for binary content. Required because upstream `EncryptedAdapter` covers only JSON.

```typescript
class EncryptedBinAdapter {
  static create(inner: MemoryAdapter, password: string, salt?: string): Promise<EncryptedBinAdapter>;
  readBin(name: string): ArrayBuffer | null;
  writeBin(name: string, data: ArrayBuffer | Uint8Array): void;
  delete(name: string): void;
  // sandwich lifecycle:
  preload(names: readonly string[]): Promise<void>;
  persist(): Promise<void>;
  // corruption / wrong-key detection (v1.0.1+):
  isCorrupted(name: string): boolean;
  // pass-through for any json calls (no encryption on json — that's EncryptedAdapter's job):
  readJson(name: string): unknown | null;
  writeJson(name: string, data: unknown): void;
}
```

- Wire format on disk (within `inner`): `Uint8Array` of `[12-byte IV][ciphertext]`. AES-256-GCM.
- `writeBin(name, plain)` → store plaintext in `_cache: Map<string, Uint8Array>` and mark `_pending.add(name)`. Pass-through `readBin` returns from `_cache`.
- `persist()` encrypts each pending entry with a fresh IV, calls `inner.writeBin(name, [iv|ct])`, clears pending.
- `preload(names)` reads each from `inner.readBin`, decrypts, populates `_cache`. **If decryption fails (wrong key, tampered ciphertext, truncated IV), the cache gets an empty buffer AND the name is added to a `corruptedSet`** — `isCorrupted(name)` returns true. Preserves the no-plaintext-leak property while letting callers (e.g., `vec stats`) surface a `corrupted: true` signal that distinguishes wrong-key from legit-empty.
- Bytes that pass through `inner.writeBin` to the Persister are already ciphertext.
- The default salt is the literal string `"js-vector-store-v1"`. Same password + same salt → same derived AES key, which is the property that lets two `Bash` instances share encrypted state. If a future `PluginOptions.salt` gets added, opt-in only.

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
4. Track `remaining{Json,Bin,Deleted}` sets initialized from `dirty`. Each successful write deletes the name from its `remaining` set.
5. For each name in `dirty.jsonChanged`:
   - `data = mem.snapshotJson().get(name)` — already encrypted if encryption was active.
   - Write atomic: `await fs.writeFile(absPath + ".tmp", JSON.stringify(data), "utf8")`, then `await fs.mv(absPath + ".tmp", absPath)`. On failure, `await fs.rm(absPath + ".tmp", { force: true })`.
6. For each name in `dirty.binChanged`: same pattern with `Uint8Array` payload.
7. For each name in `dirty.deleted`: `await fs.rm(absPath, { force: true })`.
8. **If any step throws (v1.0.1+)**: catch, call `mem.restoreDirty({ jsonChanged: remainingJson, binChanged: remainingBin, deleted: remainingDeleted })`, then re-throw. The next flush retries the unwritten entries; written-but-not-yet-renamed `.tmp` files are cleaned up by `atomicWrite`'s own catch.

Concurrency: flushes are serialized via a `flushChain: Promise<void>` field. Each `flush()` call appends a `doFlush` to the chain so its `takeDirty()` runs *after* any earlier flush completes. The chain is `.catch(()=>undefined)`-protected so a single failure doesn't poison subsequent flushes; the failure is re-thrown to the caller of `flush()` itself but the chain continues.

## `PluginRegistry`

```typescript
class PluginRegistry {
  constructor(fs: IFileSystem, opts: PluginOptions);
  // lifecycle
  ensureHydrated(): Promise<void>;
  flushIfDirty(): Promise<void>;
  // doc-store side
  getDocStore(): DocStore;
  getAuth(): Promise<Auth>;
  // vec-store side
  getVectorCollection(coll: string): VectorCollection | null;
  registerVectorCollection(coll: string, dim: number, quantize: Quantize, metric: Metric, ivf?: IvfConfig): VectorCollection;
  removeVectorCollection(coll: string): boolean;
  vectorCollections(): IterableIterator<[string, VectorCollection]>;
  persistVectorRegistry(): void;
  // exposed (readonly) for tests / handlers:
  readonly mem: MemoryAdapter;
  readonly opts: PluginOptions;
  readonly persister: Persister;
  readonly root: string;
  encJson: EncryptedAdapter | null;
  encBin: EncryptedBinAdapter | null;
}
```

Lifecycle:

- Constructed eagerly inside `createDataPlugin`'s WeakMap-cached factory (one per `IFileSystem`). No I/O at construction.
- `ensureHydrated` runs `setupEncryption` (if `encryptionKey` set) then `Persister.hydrate`, then `rehydrateVectorRegistry` (rebuilds the in-memory vec collection map from `_vec.registry.json`). Cached as a `Promise<void>` field; concurrent callers share it.
- `flushIfDirty` is called at the end of every mutating command. Read-only commands skip it. When encryption is configured, also flushes pending encrypted writes regardless of `mem.hasDirty()`.
- One registry per `IFileSystem`. There is no `--root=<path>` flag — to use a different rootDir, construct a separate `Bash` instance with `createDataPlugin({ rootDir: ... })`.

## Path layout (under `root`)

| File | Owner | Notes |
|------|-------|-------|
| `<coll>.docs.json` | doc-store | document array |
| `<coll>.meta.json` | doc-store | index metadata |
| `<coll>.<field>.idx.json` | doc-store | hash index |
| `<coll>.<field>.sidx.json` | doc-store | sorted index |
| `<coll>.bin` (float32) / `<coll>.q8.bin` (int8) / `<coll>.b1.bin` (binary) / `<coll>.p3.bin` (polar) | vector-store | raw vectors per quantization |
| `<coll>.json` (and quantized variants `.q8.json` / `.b1.json` / `.p3.json`) | vector-store | per-collection manifest (dim/count/quantize/idMap) |
| `<coll>.ivf.json` | vector-store IVF | k-means centroids (only when IVF is built) |
| `_users.docs.json` | doc-store Auth | users (encrypted if `encryptionKey` set) |
| `_sessions.docs.json` | doc-store Auth | active JWT sessions |
| `_vec.registry.json` | this plugin | per-coll vec config (dim/quantize/metric/ivf) |

## What is NOT in this layer

- `IFileSystem` errno parsing — failures bubble through `Persister`; runner converts to `CommandError(1)`.
- Schema validation — that's `Table` from doc-store.
- Auth — that's `Auth` from doc-store.

## Constraints

- All sync-facing methods (`MemoryAdapter`, `EncryptedBinAdapter`) MUST NOT use `await` or return Promises.
- `Persister` MUST NOT mutate adapter dirty sets directly. It always goes through `takeDirty()`.
- No `Buffer` — `Uint8Array` throughout.
- No global state. Registry instance lives in the closure of `createDataPlugin`.
