import type { IFileSystem } from "just-bash";
import type { EncryptedAdapter } from "js-doc-store";
import type { EncryptedBinAdapter, MemoryAdapter } from "./adapter.js";

const BIN_SUFFIX = ".bin";

const isBin = (name: string): boolean => name.endsWith(BIN_SUFFIX);

export class Persister {
  private readonly fs: IFileSystem;
  private readonly root: string;
  private dirEnsured = false;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(fs: IFileSystem, root: string) {
    this.fs = fs;
    this.root = root;
  }

  private absPath(name: string): string {
    return this.fs.resolvePath(this.root, name);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await this.fs.mkdir(this.root, { recursive: true });
    this.dirEnsured = true;
  }

  async hydrate(
    mem: MemoryAdapter,
    encJson?: EncryptedAdapter | null,
    encBin?: EncryptedBinAdapter | null,
  ): Promise<void> {
    await this.ensureDir();
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.root);
    } catch {
      return;
    }
    type Loaded =
      | { kind: "json"; name: string; data: unknown }
      | { kind: "bin"; name: string; data: Uint8Array };
    const tasks = entries.map(async (entry): Promise<Loaded | null> => {
      if (entry.endsWith(".tmp")) return null;
      const abs = this.absPath(entry);
      const stat = await this.fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile) return null;
      if (isBin(entry)) {
        const buf = await this.fs.readFileBuffer(abs);
        return { kind: "bin", name: entry, data: buf };
      }
      if (entry.endsWith(".json")) {
        const text = await this.fs.readFile(abs, "utf8");
        try {
          return { kind: "json", name: entry, data: JSON.parse(text) };
        } catch {
          // Corrupt JSON: skip. Reads later return null; the agent surfaces this as not-found.
          return null;
        }
      }
      return null;
    });
    const loaded = (await Promise.all(tasks)).filter((x): x is Loaded => x !== null);
    const jsonNames: string[] = [];
    const binNames: string[] = [];
    for (const item of loaded) {
      if (item.kind === "json") {
        mem.loadJson(item.name, item.data);
        jsonNames.push(item.name);
      } else {
        mem.loadBin(item.name, item.data);
        binNames.push(item.name);
      }
    }
    if (encJson && jsonNames.length > 0) await encJson.preload(jsonNames);
    if (encBin && binNames.length > 0) await encBin.preload(binNames);
  }

  async flush(
    mem: MemoryAdapter,
    encJson?: EncryptedAdapter | null,
    encBin?: EncryptedBinAdapter | null,
  ): Promise<void> {
    // Serialize: each call appends a doFlush to the chain so its takeDirty()
    // runs AFTER any earlier flush completed. A previous failure must not
    // poison the chain for subsequent callers.
    const chained = this.flushChain.then(() =>
      this.doFlush(mem, encJson ?? null, encBin ?? null),
    );
    this.flushChain = chained.catch(() => undefined);
    return chained;
  }

  private async doFlush(
    mem: MemoryAdapter,
    encJson: EncryptedAdapter | null,
    encBin: EncryptedBinAdapter | null,
  ): Promise<void> {
    if (encJson) await encJson.persist();
    if (encBin) await encBin.persist();

    const dirty = mem.takeDirty();
    if (
      dirty.jsonChanged.size === 0 &&
      dirty.binChanged.size === 0 &&
      dirty.deleted.size === 0
    ) {
      return;
    }
    await this.ensureDir();

    const jsonSnap = mem.snapshotJson();
    const binSnap = mem.snapshotBin();

    // Track entries that have NOT yet reached disk. If atomicWrite throws
    // mid-loop, restoreDirty re-marks the unwritten ones so the next flush
    // retries — preventing silent data loss from a transient FS error
    // (ENOSPC, EBUSY, antivirus lock, etc.).
    const remainingJson = new Set(dirty.jsonChanged);
    const remainingBin = new Set(dirty.binChanged);
    const remainingDeleted = new Set(dirty.deleted);

    try {
      for (const name of dirty.jsonChanged) {
        const data = jsonSnap.get(name);
        if (data !== undefined) {
          await this.atomicWrite(name, JSON.stringify(data), "utf8");
        }
        remainingJson.delete(name);
      }
      for (const name of dirty.binChanged) {
        const data = binSnap.get(name);
        if (data) {
          await this.atomicWrite(name, data);
        }
        remainingBin.delete(name);
      }
      for (const name of dirty.deleted) {
        await this.fs.rm(this.absPath(name), { force: true });
        remainingDeleted.delete(name);
      }
    } catch (err) {
      mem.restoreDirty({
        jsonChanged: remainingJson,
        binChanged: remainingBin,
        deleted: remainingDeleted,
      });
      throw err;
    }
  }

  private async atomicWrite(
    name: string,
    payload: string | Uint8Array,
    encoding?: "utf8",
  ): Promise<void> {
    const final = this.absPath(name);
    const tmp = this.absPath(`${name}.tmp`);
    try {
      if (encoding) {
        await this.fs.writeFile(tmp, payload as string, encoding);
      } else {
        await this.fs.writeFile(tmp, payload as Uint8Array);
      }
      await this.fs.mv(tmp, final);
    } catch (err) {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
