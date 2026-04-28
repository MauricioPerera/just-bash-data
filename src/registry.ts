import type { IFileSystem } from "just-bash";
import {
  Auth,
  DocStore,
  EncryptedAdapter,
  type SyncJsonAdapter,
} from "js-doc-store";
import {
  BinaryQuantizedStore,
  IVFIndex,
  PolarQuantizedStore,
  QuantizedStore,
  type SyncBinJsonAdapter,
  VectorStore,
  type Metric,
  type VectorStoreLike,
} from "js-vector-store";
import { EncryptedBinAdapter, MemoryAdapter } from "./adapter.js";
import { Persister } from "./persister.js";

export type Quantize = "float32" | "int8" | "polar" | "binary";

const VEC_REGISTRY_FILE = "_vec.registry.json";

export interface PluginOptions {
  encryptionKey?: string;
  authSecret?: string;
  rootDir?: string;
  /**
   * Optional PBKDF2 salt prefix (v1.1.0+). When set, the JSON and binary
   * encrypted adapters derive their AES keys from `${salt}:json` and
   * `${salt}:bin` respectively — preserving the two-distinct-keys property
   * that the hardcoded defaults give. When unset, the defaults are
   * `js-doc-store-v1` (JSON) and `js-vector-store-v1` (bin), matching
   * v1.0.x behavior exactly.
   *
   * **Caveat**: changing the salt is equivalent to changing the password
   * from the data's perspective — existing encrypted files become
   * unreadable. For migration, decrypt with the old config (export to
   * plaintext via `db <coll> export` / `vec export`), drop, recreate
   * with the new salt, and reimport.
   */
  salt?: string;
}

export interface IvfConfig {
  numClusters: number;
  numProbes: number;
}

export interface VectorCollection {
  store: VectorStoreLike;
  dim: number;
  quantize: Quantize;
  metric: Metric;
  ivf?: IvfConfig;
  ivfIndex?: IVFIndex;
}

export class PluginRegistry {
  readonly mem: MemoryAdapter;
  readonly opts: PluginOptions;
  readonly persister: Persister;
  readonly root: string;
  encJson: EncryptedAdapter | null = null;
  encBin: EncryptedBinAdapter | null = null;

  private docStoreInst: DocStore | null = null;
  private authInst: Auth | null = null;
  private readonly vecMap = new Map<string, VectorCollection>();
  private hydration: Promise<void> | null = null;
  private encReady: Promise<void> | null = null;

  constructor(fs: IFileSystem, opts: PluginOptions) {
    this.mem = new MemoryAdapter();
    this.opts = opts;
    this.root = opts.rootDir ?? "/data";
    this.persister = new Persister(fs, this.root);
  }

  private async setupEncryption(): Promise<void> {
    if (this.encReady) return this.encReady;
    if (!this.opts.encryptionKey) return;
    // When opts.salt is provided, derive distinct salts per adapter so the
    // JSON and bin keys diverge (matching the hardcoded-defaults behavior).
    // When unset, omit the third arg to preserve v1.0.x exact byte-equivalence.
    const userSalt = this.opts.salt;
    this.encReady = (async () => {
      this.encJson = userSalt !== undefined
        ? await EncryptedAdapter.create(
            this.mem as SyncJsonAdapter,
            this.opts.encryptionKey as string,
            `${userSalt}:json`,
          )
        : await EncryptedAdapter.create(
            this.mem as SyncJsonAdapter,
            this.opts.encryptionKey as string,
          );
      this.encBin = userSalt !== undefined
        ? await EncryptedBinAdapter.create(
            this.mem,
            this.opts.encryptionKey as string,
            `${userSalt}:bin`,
          )
        : await EncryptedBinAdapter.create(
            this.mem,
            this.opts.encryptionKey as string,
          );
    })();
    return this.encReady;
  }

  async ensureHydrated(): Promise<void> {
    if (this.hydration) return this.hydration;
    this.hydration = (async () => {
      await this.setupEncryption();
      await this.persister.hydrate(this.mem, this.encJson, this.encBin);
      this.rehydrateVectorRegistry();
    })();
    return this.hydration;
  }

  private rehydrateVectorRegistry(): void {
    const raw = this.mem.readJson(VEC_REGISTRY_FILE);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [coll, meta] of Object.entries(raw as Record<string, unknown>)) {
      if (!meta || typeof meta !== "object") continue;
      const m = meta as Record<string, unknown>;
      if (
        typeof m["dim"] !== "number" ||
        typeof m["quantize"] !== "string" ||
        typeof m["metric"] !== "string" ||
        this.vecMap.has(coll)
      ) {
        continue;
      }
      // Restore IVF config if it was persisted; the IVFIndex instance will
      // lazily reload its centroids from <coll>.ivf.json on first search.
      let ivf: IvfConfig | undefined;
      const rawIvf = m["ivf"];
      if (
        rawIvf &&
        typeof rawIvf === "object" &&
        typeof (rawIvf as { numClusters?: unknown }).numClusters === "number" &&
        typeof (rawIvf as { numProbes?: unknown }).numProbes === "number"
      ) {
        ivf = {
          numClusters: (rawIvf as { numClusters: number }).numClusters,
          numProbes: (rawIvf as { numProbes: number }).numProbes,
        };
      }
      this.registerVectorCollection(
        coll,
        m["dim"],
        m["quantize"] as Quantize,
        m["metric"] as Metric,
        ivf,
      );
    }
  }

  persistVectorRegistry(): void {
    const out: Record<
      string,
      { dim: number; quantize: Quantize; metric: Metric; ivf?: IvfConfig }
    > = {};
    for (const [coll, entry] of this.vecMap) {
      const o: { dim: number; quantize: Quantize; metric: Metric; ivf?: IvfConfig } = {
        dim: entry.dim,
        quantize: entry.quantize,
        metric: entry.metric,
      };
      if (entry.ivf) o.ivf = entry.ivf;
      out[coll] = o;
    }
    this.mem.writeJson(VEC_REGISTRY_FILE, out);
  }

  async flushIfDirty(): Promise<void> {
    const hasEncPending =
      Boolean(this.encJson) || Boolean(this.encBin);
    if (!this.mem.hasDirty() && !hasEncPending) return;
    await this.persister.flush(this.mem, this.encJson, this.encBin);
  }

  getDocStore(): DocStore {
    if (!this.docStoreInst) {
      const adapter: SyncJsonAdapter = this.encJson ?? this.mem;
      this.docStoreInst = new DocStore(adapter);
    }
    return this.docStoreInst;
  }

  async getAuth(): Promise<Auth> {
    if (!this.opts.authSecret) {
      throw new Error("Auth not configured: pass authSecret in PluginOptions");
    }
    if (!this.authInst) {
      this.authInst = new Auth(this.getDocStore(), {
        secret: this.opts.authSecret,
      });
      await this.authInst.init();
    }
    return this.authInst;
  }

  getVectorCollection(coll: string): VectorCollection | null {
    return this.vecMap.get(coll) ?? null;
  }

  registerVectorCollection(
    coll: string,
    dim: number,
    quantize: Quantize,
    metric: Metric,
    ivf?: IvfConfig,
  ): VectorCollection {
    if (this.vecMap.has(coll)) {
      throw new Error(`vector collection already exists: ${coll}`);
    }
    const adapter: SyncBinJsonAdapter = (this.encBin ?? this.mem) as SyncBinJsonAdapter;
    let store: VectorStoreLike;
    switch (quantize) {
      case "int8":
        store = new QuantizedStore(adapter, dim);
        break;
      case "polar":
        store = new PolarQuantizedStore(adapter, dim);
        break;
      case "binary":
        store = new BinaryQuantizedStore(adapter, dim);
        break;
      default:
        store = new VectorStore(adapter, dim);
    }
    const entry: VectorCollection = { store, dim, quantize, metric };
    if (ivf) {
      entry.ivf = ivf;
      entry.ivfIndex = new IVFIndex(store, ivf.numClusters, ivf.numProbes);
    }
    this.vecMap.set(coll, entry);
    return entry;
  }

  removeVectorCollection(coll: string): boolean {
    return this.vecMap.delete(coll);
  }

  vectorCollections(): IterableIterator<[string, VectorCollection]> {
    return this.vecMap.entries();
  }
}
