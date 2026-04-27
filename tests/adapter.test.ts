import { InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { EncryptedBinAdapter, MemoryAdapter } from "../src/adapter.js";
import { Persister } from "../src/persister.js";
import { PluginRegistry } from "../src/registry.js";

describe("MemoryAdapter", () => {
  it("readJson/writeJson roundtrip; missing returns null", () => {
    const m = new MemoryAdapter();
    expect(m.readJson("a.json")).toBeNull();
    m.writeJson("a.json", { x: 1 });
    expect(m.readJson("a.json")).toEqual({ x: 1 });
  });

  it("readBin/writeBin roundtrip (returns ArrayBuffer)", () => {
    const m = new MemoryAdapter();
    const buf = new Uint8Array([1, 2, 3, 4]);
    m.writeBin("v.bin", buf);
    const got = m.readBin("v.bin");
    expect(got).not.toBeNull();
    expect(new Uint8Array(got!)).toEqual(buf);
    expect(m.readBin("missing.bin")).toBeNull();
  });

  it("delete removes from both maps and tracks deletion", () => {
    const m = new MemoryAdapter();
    m.writeJson("x.json", { x: 1 });
    m.takeDirty();
    m.delete("x.json");
    expect(m.readJson("x.json")).toBeNull();
    const d = m.takeDirty();
    expect(d.deleted.has("x.json")).toBe(true);
  });

  it("takeDirty clears sets on second call", () => {
    const m = new MemoryAdapter();
    m.writeJson("a.json", 1);
    expect(m.takeDirty().jsonChanged.has("a.json")).toBe(true);
    expect(m.takeDirty().jsonChanged.size).toBe(0);
  });

  it("loadJson/loadBin do NOT mark dirty (hydration path)", () => {
    const m = new MemoryAdapter();
    m.loadJson("a.json", { y: 2 });
    m.loadBin("v.bin", new Uint8Array([9]));
    const d = m.takeDirty();
    expect(d.jsonChanged.size).toBe(0);
    expect(d.binChanged.size).toBe(0);
    expect(m.readJson("a.json")).toEqual({ y: 2 });
  });

  it("hasDirty reflects pending writes/deletes", () => {
    const m = new MemoryAdapter();
    expect(m.hasDirty()).toBe(false);
    m.writeJson("a.json", 1);
    expect(m.hasDirty()).toBe(true);
    m.takeDirty();
    expect(m.hasDirty()).toBe(false);
  });
});

describe("EncryptedBinAdapter", () => {
  it("readBin returns plaintext from cache after writeBin (no persist needed)", async () => {
    const inner = new MemoryAdapter();
    const enc = await EncryptedBinAdapter.create(inner, "pw");
    const pt = new Uint8Array([10, 20, 30, 40]);
    enc.writeBin("v.bin", pt);
    expect(new Uint8Array(enc.readBin("v.bin")!)).toEqual(pt);
  });

  it("after persist, inner.readBin returns ciphertext (≠ plaintext)", async () => {
    const inner = new MemoryAdapter();
    const enc = await EncryptedBinAdapter.create(inner, "pw");
    const pt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    enc.writeBin("v.bin", pt);
    await enc.persist();
    const ct = inner.readBin("v.bin");
    expect(ct).not.toBeNull();
    const ctU8 = new Uint8Array(ct!);
    expect(ctU8).not.toEqual(pt);
    expect(ctU8.length).toBe(12 + pt.length + 16);
  });

  it("preload populates cache so subsequent readBin returns plaintext", async () => {
    const inner = new MemoryAdapter();
    const enc1 = await EncryptedBinAdapter.create(inner, "pw");
    const pt = new Uint8Array([99, 98, 97]);
    enc1.writeBin("v.bin", pt);
    await enc1.persist();

    const enc2 = await EncryptedBinAdapter.create(inner, "pw");
    expect(enc2.readBin("v.bin")).toBeNull();
    await enc2.preload(["v.bin"]);
    expect(new Uint8Array(enc2.readBin("v.bin")!)).toEqual(pt);
  });

  it("wrong password leaves cache empty (zero-length stub) without throwing", async () => {
    const inner = new MemoryAdapter();
    const good = await EncryptedBinAdapter.create(inner, "good");
    good.writeBin("v.bin", new Uint8Array([1, 2, 3]));
    await good.persist();

    const bad = await EncryptedBinAdapter.create(inner, "wrong");
    await expect(bad.preload(["v.bin"])).resolves.toBeUndefined();
    const stub = bad.readBin("v.bin");
    expect(stub).not.toBeNull();
    expect(new Uint8Array(stub!).length).toBe(0);
  });
});

describe("Persister", () => {
  it("hydrate loads existing files via readdir + stat", async () => {
    const fs = new InMemoryFs({
      "/data/users.docs.json": JSON.stringify([{ _id: "1", name: "A" }]),
      "/data/v.bin": new Uint8Array([1, 2, 3]),
      "/data/skip.tmp": "ignored",
    });
    const mem = new MemoryAdapter();
    const p = new Persister(fs, "/data");
    await p.hydrate(mem);
    expect(mem.readJson("users.docs.json")).toEqual([{ _id: "1", name: "A" }]);
    expect(new Uint8Array(mem.readBin("v.bin")!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(mem.readJson("skip.tmp")).toBeNull();
    const d = mem.takeDirty();
    expect(d.jsonChanged.size).toBe(0);
    expect(d.binChanged.size).toBe(0);
  });

  it("flush writes via .tmp + mv (atomic) and persists deleted entries", async () => {
    const fs = new InMemoryFs({});
    const mvSpy = vi.spyOn(fs, "mv");
    const writeSpy = vi.spyOn(fs, "writeFile");
    const rmSpy = vi.spyOn(fs, "rm");

    const mem = new MemoryAdapter();
    mem.writeJson("a.json", { hi: true });
    mem.writeBin("v.bin", new Uint8Array([7, 8, 9]));

    const p = new Persister(fs, "/data");
    await p.flush(mem);

    expect(writeSpy).toHaveBeenCalled();
    expect(mvSpy).toHaveBeenCalledTimes(2);
    for (const call of writeSpy.mock.calls) {
      expect(String(call[0])).toMatch(/\.tmp$/);
    }
    expect(await fs.readFile("/data/a.json", "utf8")).toBe('{"hi":true}');
    expect(await fs.readFileBuffer("/data/v.bin")).toEqual(
      new Uint8Array([7, 8, 9]),
    );

    mem.delete("a.json");
    await p.flush(mem);
    expect(await fs.exists("/data/a.json")).toBe(false);
    const rmCalls = rmSpy.mock.calls.map((c) => c[0]);
    expect(rmCalls).toContain("/data/a.json");
  });

  it("flush is a no-op when nothing is dirty", async () => {
    const fs = new InMemoryFs({});
    const writeSpy = vi.spyOn(fs, "writeFile");
    const mem = new MemoryAdapter();
    const p = new Persister(fs, "/data");
    await p.flush(mem);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("mid-write failure cleans up the .tmp", async () => {
    const fs = new InMemoryFs({});
    const mem = new MemoryAdapter();
    mem.writeJson("a.json", { x: 1 });
    const p = new Persister(fs, "/data");

    const mvSpy = vi.spyOn(fs, "mv").mockRejectedValueOnce(new Error("mv fail"));
    const rmSpy = vi.spyOn(fs, "rm");
    await expect(p.flush(mem)).rejects.toThrow("mv fail");
    expect(mvSpy).toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalled();
    expect(await fs.exists("/data/a.json.tmp")).toBe(false);
  });
});

describe("PluginRegistry", () => {
  it("ensureHydrated runs hydrate exactly once under concurrent calls", async () => {
    const fs = new InMemoryFs({
      "/data/x.json": '{"x":1}',
    });
    const readSpy = vi.spyOn(fs, "readdir");

    const reg = new PluginRegistry(fs, {});
    await Promise.all([
      reg.ensureHydrated(),
      reg.ensureHydrated(),
      reg.ensureHydrated(),
    ]);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(reg.mem.readJson("x.json")).toEqual({ x: 1 });
  });

  it("flushIfDirty is a no-op when no dirty entries", async () => {
    const fs = new InMemoryFs({});
    const writeSpy = vi.spyOn(fs, "writeFile");
    const reg = new PluginRegistry(fs, {});
    await reg.ensureHydrated();
    await reg.flushIfDirty();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("registers a vector collection with each quantize variant without crashing", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    await reg.ensureHydrated();
    reg.registerVectorCollection("a", 4, "float32", "cosine");
    reg.registerVectorCollection("b", 4, "int8", "cosine");
    reg.registerVectorCollection("c", 4, "polar", "cosine");
    reg.registerVectorCollection("d", 4, "binary", "cosine");
    expect([...reg.vectorCollections()].length).toBe(4);
  });

  it("encryption: doc data persisted bytes do not contain plaintext value", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, { encryptionKey: "test-key" });
    await reg.ensureHydrated();
    const docs = reg.getDocStore().collection("notes");
    docs.insert({ secret: "PLAINTEXT-MARKER" });
    docs.flush();
    await reg.flushIfDirty();
    const raw = await fs.readFile("/data/notes.docs.json", "utf8");
    expect(raw).not.toContain("PLAINTEXT-MARKER");
  });
});
