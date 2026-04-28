export interface DirtySets {
  jsonChanged: Set<string>;
  binChanged: Set<string>;
  deleted: Set<string>;
}

export type BinIn = ArrayBuffer | Uint8Array;

const toUint8 = (data: BinIn): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
};

const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

export class MemoryAdapter {
  private readonly jsonStore = new Map<string, unknown>();
  private readonly binStore = new Map<string, Uint8Array>();
  private jsonDirty = new Set<string>();
  private binDirty = new Set<string>();
  private deletedSet = new Set<string>();

  readJson(name: string): unknown {
    return this.jsonStore.has(name) ? this.jsonStore.get(name) : null;
  }

  writeJson(name: string, data: unknown): void {
    this.jsonStore.set(name, data);
    this.jsonDirty.add(name);
    this.deletedSet.delete(name);
  }

  readBin(name: string): ArrayBuffer | null {
    const u8 = this.binStore.get(name);
    return u8 ? toArrayBuffer(u8) : null;
  }

  writeBin(name: string, data: BinIn): void {
    this.binStore.set(name, toUint8(data));
    this.binDirty.add(name);
    this.deletedSet.delete(name);
  }

  delete(name: string): void {
    const had = this.jsonStore.delete(name) || this.binStore.delete(name);
    this.jsonDirty.delete(name);
    this.binDirty.delete(name);
    if (had) this.deletedSet.add(name);
  }

  loadJson(name: string, data: unknown): void {
    this.jsonStore.set(name, data);
  }

  loadBin(name: string, data: BinIn): void {
    this.binStore.set(name, toUint8(data));
  }

  snapshotJson(): ReadonlyMap<string, unknown> {
    return this.jsonStore;
  }

  snapshotBin(): ReadonlyMap<string, Uint8Array> {
    return this.binStore;
  }

  takeDirty(): DirtySets {
    const out = {
      jsonChanged: this.jsonDirty,
      binChanged: this.binDirty,
      deleted: this.deletedSet,
    };
    this.jsonDirty = new Set();
    this.binDirty = new Set();
    this.deletedSet = new Set();
    return out;
  }

  /**
   * Re-mark entries as dirty after a partial flush failure. The persister
   * calls this with the entries that did NOT successfully reach disk, so
   * the next flush retries them. Without this, takeDirty() on a partial
   * failure would silently drop pending writes.
   */
  restoreDirty(d: {
    jsonChanged?: Iterable<string>;
    binChanged?: Iterable<string>;
    deleted?: Iterable<string>;
  }): void {
    if (d.jsonChanged) for (const n of d.jsonChanged) this.jsonDirty.add(n);
    if (d.binChanged) for (const n of d.binChanged) this.binDirty.add(n);
    if (d.deleted) for (const n of d.deleted) this.deletedSet.add(n);
  }

  hasDirty(): boolean {
    return (
      this.jsonDirty.size > 0 ||
      this.binDirty.size > 0 ||
      this.deletedSet.size > 0
    );
  }
}

const getCrypto = (): Crypto => {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error("EncryptedBinAdapter: Web Crypto API not available");
};

export class EncryptedBinAdapter {
  private readonly inner: MemoryAdapter;
  private readonly key: CryptoKey;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly pending = new Set<string>();
  /**
   * Names that failed to decrypt during preload. Surfaces a real failure
   * mode that would otherwise be invisible: a wrong key or corrupt ciphertext
   * caches as an empty buffer (so no plaintext leaks), but the user / agent
   * has no way to distinguish "empty collection" from "decrypt failed".
   * `vec stats` reads this Set to report `corrupted: true`.
   */
  private readonly corruptedSet = new Set<string>();

  private constructor(inner: MemoryAdapter, key: CryptoKey) {
    this.inner = inner;
    this.key = key;
  }

  isCorrupted(name: string): boolean {
    return this.corruptedSet.has(name);
  }

  static async create(
    inner: MemoryAdapter,
    password: string,
    salt = "js-vector-store-v1",
  ): Promise<EncryptedBinAdapter> {
    const c = getCrypto();
    const enc = new TextEncoder();
    const keyMaterial = await c.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await c.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode(salt),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return new EncryptedBinAdapter(inner, key);
  }

  readJson(name: string): unknown {
    return this.inner.readJson(name);
  }

  writeJson(name: string, data: unknown): void {
    this.inner.writeJson(name, data);
  }

  readBin(name: string): ArrayBuffer | null {
    const u8 = this.cache.get(name);
    return u8 ? toArrayBuffer(u8) : null;
  }

  writeBin(name: string, data: BinIn): void {
    this.cache.set(name, toUint8(data));
    this.pending.add(name);
  }

  delete(name: string): void {
    this.cache.delete(name);
    this.pending.delete(name);
    this.inner.delete(name);
  }

  async preload(names: readonly string[]): Promise<void> {
    const c = getCrypto();
    for (const name of names) {
      const ctBuf = this.inner.readBin(name);
      if (!ctBuf || ctBuf.byteLength < 12) continue;
      try {
        const ivBuf = ctBuf.slice(0, 12);
        const bodyBuf = ctBuf.slice(12);
        const pt = await c.subtle.decrypt(
          { name: "AES-GCM", iv: ivBuf as ArrayBuffer },
          this.key,
          bodyBuf as ArrayBuffer,
        );
        this.cache.set(name, new Uint8Array(pt));
      } catch {
        // Decryption failed (wrong key, tampered ciphertext, truncated IV,
        // or corrupt body). Cache as empty to keep the no-plaintext-leak
        // property, but ALSO mark as corrupted so callers can distinguish
        // "wrong key / corrupt" from "legitimately empty".
        this.cache.set(name, new Uint8Array(0));
        this.corruptedSet.add(name);
      }
    }
  }

  async persist(): Promise<void> {
    const c = getCrypto();
    for (const name of this.pending) {
      const pt = this.cache.get(name);
      if (!pt) continue;
      const iv = c.getRandomValues(new Uint8Array(12));
      const ptBuf = pt.buffer.slice(
        pt.byteOffset,
        pt.byteOffset + pt.byteLength,
      ) as ArrayBuffer;
      const ivBuf = iv.buffer.slice(
        iv.byteOffset,
        iv.byteOffset + iv.byteLength,
      ) as ArrayBuffer;
      const ct = await c.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuf },
        this.key,
        ptBuf,
      );
      const out = new Uint8Array(12 + ct.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ct), 12);
      this.inner.writeBin(name, out);
    }
    this.pending.clear();
  }
}
