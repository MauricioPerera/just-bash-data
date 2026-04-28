declare module "js-doc-store" {
  export interface SyncJsonAdapter {
    readJson(name: string): unknown;
    writeJson(name: string, data: unknown): void;
    delete(name: string): void;
  }

  export type DocFilter = Record<string, unknown>;
  export type DocUpdate = Record<string, unknown>;
  export type Doc = Record<string, unknown> & { _id: string };

  export class Cursor {
    sort(spec: Record<string, 1 | -1>): Cursor;
    limit(n: number): Cursor;
    skip(n: number): Cursor;
    project(spec: Record<string, 0 | 1>): Cursor;
    toArray(): Doc[];
    count(): number;
  }

  export class AggregationPipeline {
    match(filter: DocFilter): AggregationPipeline;
    lookup(opts: Record<string, unknown>): AggregationPipeline;
    group(field: string | null, accumulators: Record<string, unknown>): AggregationPipeline;
    sort(spec: Record<string, 1 | -1>): AggregationPipeline;
    limit(n: number): AggregationPipeline;
    skip(n: number): AggregationPipeline;
    project(spec: Record<string, unknown>): AggregationPipeline;
    unwind(field: string): AggregationPipeline;
    toArray(): unknown[];
  }

  export class Collection {
    insert(doc: Record<string, unknown>): Doc;
    findOne(filter: DocFilter): Doc | null;
    findById(id: string): Doc | null;
    find(filter?: DocFilter): Cursor;
    update(filter: DocFilter, update: DocUpdate): number;
    updateMany(filter: DocFilter, update: DocUpdate): number;
    remove(filter: DocFilter): number;
    removeMany(filter: DocFilter): number;
    removeById(id: string): number;
    count(filter?: DocFilter): number;
    aggregate(): AggregationPipeline;
    createIndex(field: string, opts?: { unique?: boolean; sorted?: boolean }): void;
    dropIndex(field: string): void;
    getIndexes(): Array<{ field: string; type: string; unique?: boolean }>;
    flush(): void;
    export(): Doc[];
    import(docs: Record<string, unknown>[]): void;
  }

  export class DocStore {
    constructor(adapter: SyncJsonAdapter);
    collection(name: string): Collection;
    drop(name: string): void;
    flush(): void;
  }

  export class MemoryStorageAdapter implements SyncJsonAdapter {
    readJson(name: string): unknown;
    writeJson(name: string, data: unknown): void;
    delete(name: string): void;
  }

  export class EncryptedAdapter implements SyncJsonAdapter {
    readonly inner: SyncJsonAdapter;
    static create(
      inner: SyncJsonAdapter,
      password: string,
      salt?: string,
    ): Promise<EncryptedAdapter>;
    preload(filenames: string[]): Promise<void>;
    persist(): Promise<void>;
    readJson(name: string): unknown;
    writeJson(name: string, data: unknown): void;
    delete(name: string): void;
  }

  export class Auth {
    constructor(
      db: DocStore,
      opts: {
        secret: string;
        usersCollection?: string;
        sessionsCollection?: string;
        tokenExpiry?: number;
        defaultRoles?: readonly string[];
      },
    );
    init(): Promise<void>;
    register(
      email: string,
      password: string,
      profile?: Record<string, unknown>,
    ): Promise<Doc>;
    login(email: string, password: string): Promise<{ token: string; user: Doc }>;
    verify(token: string): Promise<{
      sub: string;
      email: string;
      roles: string[];
      iat: number;
      exp: number;
    } | null>;
    logout(token: string): number;
    logoutAll(userId: string): number;
    assignRole(userId: string, role: string): void;
    removeRole(userId: string, role: string): void;
    hasRole(userId: string, role: string): boolean;
    authorize(
      token: string,
      requiredRole?: string,
    ): Promise<{ sub: string; roles: string[] } | null>;
  }
}

declare module "js-vector-store" {
  export interface SyncBinJsonAdapter {
    readJson(name: string): unknown;
    writeJson(name: string, data: unknown): void;
    readBin(name: string): ArrayBuffer | null;
    writeBin(name: string, data: ArrayBuffer | Uint8Array): void;
    delete(name: string): void;
  }

  export type Metric = "cosine" | "euclidean" | "dot" | "manhattan";

  export interface SearchHit {
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
  }

  export interface VectorStoreLike {
    set(col: string, id: string, vector: number[], metadata?: Record<string, unknown>): void;
    get(col: string, id: string): { vector: number[]; metadata?: Record<string, unknown> } | null;
    has(col: string, id: string): boolean;
    count(col: string): number;
    remove(col: string, id: string): void;
    drop(col: string): void;
    flush(): void;
    search(
      col: string,
      query: number[],
      limit?: number,
      dimSlice?: number,
      metric?: Metric,
      filter?: Record<string, unknown> | null,
    ): SearchHit[];
    matryoshkaSearch(
      col: string,
      query: number[],
      limit?: number,
      stages?: number[],
      metric?: Metric,
    ): SearchHit[];
    searchAcross(
      collections: string[],
      query: number[],
      limit?: number,
      metric?: Metric,
    ): SearchHit[];
    import(col: string, records: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): void;
    export(col: string): Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>;
  }

  export class VectorStore implements VectorStoreLike {
    constructor(
      adapter: SyncBinJsonAdapter,
      dim?: number,
      maxCollections?: number,
      opts?: Record<string, unknown>,
    );
    set(col: string, id: string, vector: number[], metadata?: Record<string, unknown>): void;
    get(col: string, id: string): { vector: number[]; metadata?: Record<string, unknown> } | null;
    has(col: string, id: string): boolean;
    count(col: string): number;
    remove(col: string, id: string): void;
    drop(col: string): void;
    flush(): void;
    search(
      col: string,
      query: number[],
      limit?: number,
      dimSlice?: number,
      metric?: Metric,
      filter?: Record<string, unknown> | null,
    ): SearchHit[];
    matryoshkaSearch(col: string, query: number[], limit?: number, stages?: number[], metric?: Metric): SearchHit[];
    searchAcross(collections: string[], query: number[], limit?: number, metric?: Metric): SearchHit[];
    import(col: string, records: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): void;
    export(col: string): Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>;
  }

  export class QuantizedStore extends VectorStore {}
  export class BinaryQuantizedStore extends VectorStore {}
  export class PolarQuantizedStore extends VectorStore {}

  export class IVFIndex {
    constructor(store: VectorStoreLike, numClusters?: number, numProbes?: number);
    build(col: string, sampleDims?: number): { numClusters: number; numVectors: number };
    hasIndex(col: string): boolean;
    dropIndex(col: string): void;
    indexStats(col: string): { numClusters: number; numProbes: number } | null;
    search(col: string, query: number[], limit?: number): SearchHit[];
    matryoshkaSearch(col: string, query: number[], limit?: number, stages?: number[]): SearchHit[];
  }

  export class MemoryStorageAdapter implements SyncBinJsonAdapter {
    readJson(name: string): unknown;
    writeJson(name: string, data: unknown): void;
    readBin(name: string): Uint8Array | null;
    writeBin(name: string, data: Uint8Array): void;
    delete(name: string): void;
  }
}
