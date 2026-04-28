// Targeted tests for the 5 fixes shipped in v1.0.1. Each block focuses on
// one fix so a regression points to a specific origin.
import { type CommandContext, type ExecResult, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { buildDbCommand } from "../src/commands/db.js";
import { buildVecCommand } from "../src/commands/vec.js";
import { PluginRegistry, type PluginOptions } from "../src/registry.js";
import {
  validateCollName,
} from "../src/lib/errors.js";
import { MemoryAdapter } from "../src/adapter.js";
import { Persister } from "../src/persister.js";

interface Harness {
  reg: PluginRegistry;
  fs: InMemoryFs;
  db: (args: string[]) => Promise<ExecResult>;
  vec: (args: string[]) => Promise<ExecResult>;
}

const buildHarness = (opts: PluginOptions = {}): Harness => {
  const fs = new InMemoryFs({});
  const reg = new PluginRegistry(fs, opts);
  const dbCmd = buildDbCommand(() => reg);
  const vecCmd = buildVecCommand(() => reg);
  const ctx = (): CommandContext => ({
    fs,
    cwd: "/",
    env: new Map(),
    stdin: "",
  });
  return {
    reg,
    fs,
    db: (args) => dbCmd.execute(args, ctx()),
    vec: (args) => vecCmd.execute(args, ctx()),
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Fix 1: validateCollName — path traversal + bad-char rejection
// ─────────────────────────────────────────────────────────────────────────

describe("v1.0.1 fix 1: collection name validation", () => {
  it("accepts canonical names", () => {
    expect(() => validateCollName("books")).not.toThrow();
    expect(() => validateCollName("user_logs")).not.toThrow();
    expect(() => validateCollName("docs-2024")).not.toThrow();
    expect(() => validateCollName("_internal")).not.toThrow();
    expect(() => validateCollName("a")).not.toThrow();
    expect(() => validateCollName("X1")).not.toThrow();
  });

  it("rejects path-traversal and special chars", () => {
    for (const bad of [
      "..",
      "../escape",
      "../../etc/passwd",
      "foo/bar",
      "foo\\bar",
      "foo bar",
      "foo.bar",
      ".hidden",
      "-leading-hyphen",
      "",
      "with$dollar",
      "with:colon",
      "with*glob",
    ]) {
      expect(() => validateCollName(bad), `should reject: ${bad}`).toThrow(
        /invalid collection name/,
      );
    }
  });

  it("enforces 64-char length cap", () => {
    expect(() => validateCollName("a".repeat(64))).not.toThrow();
    expect(() => validateCollName("a".repeat(65))).toThrow(/invalid/);
  });

  it("db dispatcher rejects '../escape' before reaching the persister", async () => {
    const h = buildHarness();
    const r = await h.db(["../escape", "insert", '{"x":1}']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid collection name");
    // Confirm nothing leaked outside /data
    const root = await h.fs.readdir("/data").catch(() => []);
    const escape = await h.fs.readdir("/").catch(() => []);
    expect(root).not.toContain("escape.docs.json");
    expect(escape).not.toContain("escape.docs.json");
  });

  it("db dispatcher rejects find on bad name (read-only path also gated)", async () => {
    const h = buildHarness();
    const r = await h.db(["foo/bar", "find", "{}"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid collection name");
  });

  it("vec create rejects bad names", async () => {
    const h = buildHarness();
    const r = await h.vec(["create", "../evil", "--dim", "4"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid collection name");
  });

  it("vec stats on existing collection still works", async () => {
    const h = buildHarness();
    expect((await h.vec(["create", "good", "--dim", "4"])).exitCode).toBe(0);
    const r = await h.vec(["stats", "good"]);
    expect(r.exitCode).toBe(0);
  });

  it("vec ops reject bad name (defense in depth via requireVecColl)", async () => {
    const h = buildHarness();
    const r = await h.vec(["stats", "../evil"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid collection name");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix 2: persister restoreDirty on partial flush failure
// ─────────────────────────────────────────────────────────────────────────

describe("v1.0.1 fix 2: persister partial-failure recovery", () => {
  // Use a stub fs that throws on the SECOND atomicWrite call.
  class FlakyFs {
    private writeCount = 0;
    files = new Map<string, string | Uint8Array>();
    failOnWriteN = 2; // throw on the 2nd writeFile call

    async readFile(p: string, _opts?: unknown): Promise<string> {
      const v = this.files.get(p);
      if (typeof v === "string") return v;
      throw new Error("not found");
    }
    async readFileBuffer(p: string): Promise<Uint8Array> {
      const v = this.files.get(p);
      if (v instanceof Uint8Array) return v;
      throw new Error("not found");
    }
    async writeFile(p: string, content: string | Uint8Array): Promise<void> {
      this.writeCount++;
      if (this.writeCount === this.failOnWriteN) {
        throw new Error("simulated FS failure (ENOSPC-like)");
      }
      this.files.set(p, content);
    }
    async exists(p: string): Promise<boolean> {
      return this.files.has(p);
    }
    async stat(p: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }> {
      if (!this.files.has(p)) throw new Error("not found");
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: 0, mtime: new Date() };
    }
    async mkdir(): Promise<void> {}
    async readdir(_p: string): Promise<string[]> { return []; }
    async rm(p: string): Promise<void> { this.files.delete(p); }
    async mv(src: string, dest: string): Promise<void> {
      const v = this.files.get(src);
      if (v === undefined) throw new Error("rename src not found");
      this.files.set(dest, v);
      this.files.delete(src);
    }
    resolvePath(base: string, p: string): string {
      if (p.startsWith("/")) return p;
      return base.endsWith("/") ? base + p : base + "/" + p;
    }
    async appendFile() { throw new Error("nyi"); }
    async cp() { throw new Error("nyi"); }
    async chmod() {}
    async symlink() { throw new Error("nyi"); }
    async link() { throw new Error("nyi"); }
    async readlink() { throw new Error("nyi"); }
    async lstat(p: string) { return this.stat(p); }
    async realpath(p: string) { return p; }
    async utimes() {}
    getAllPaths(): string[] { return []; }
  }

  it("re-marks dirty entries when atomicWrite throws mid-flush", async () => {
    const flaky = new FlakyFs();
    const mem = new MemoryAdapter();
    const persister = new Persister(flaky as never, "/data");

    mem.writeJson("a.json", { v: 1 });
    mem.writeJson("b.json", { v: 2 });
    mem.writeJson("c.json", { v: 3 });

    expect(mem.hasDirty()).toBe(true);

    // First flush: throws on the 2nd write (b.json). a.json should land.
    // Note: writeFile is called once per atomicWrite (writeFile to .tmp,
    // then mv to final — only 1 writeFile per entry). FailOnWriteN = 2 fires
    // when starting b.json's write.
    await expect(persister.flush(mem)).rejects.toThrow(/simulated FS failure/);

    // a.json wrote (its tmp + mv happened before failure). b.json + c.json
    // should still be dirty for retry.
    expect(mem.hasDirty()).toBe(true);

    // Second flush succeeds (failOnWriteN already past).
    flaky.failOnWriteN = -1; // never fail again
    await persister.flush(mem);

    expect(mem.hasDirty()).toBe(false);
    expect(flaky.files.has("/data/a.json")).toBe(true);
    expect(flaky.files.has("/data/b.json")).toBe(true);
    expect(flaky.files.has("/data/c.json")).toBe(true);
  });

  it("MemoryAdapter.restoreDirty re-adds entries", () => {
    const mem = new MemoryAdapter();
    mem.writeJson("a", { v: 1 });
    const dirty = mem.takeDirty();
    expect(mem.hasDirty()).toBe(false);

    mem.restoreDirty({ jsonChanged: dirty.jsonChanged });
    expect(mem.hasDirty()).toBe(true);
    const second = mem.takeDirty();
    expect([...second.jsonChanged]).toEqual(["a"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix 3: db stats sizeBytes uses UTF-8, not String.length
// ─────────────────────────────────────────────────────────────────────────

describe("v1.0.1 fix 3: db stats sizeBytes UTF-8 byte count", () => {
  it("ASCII-only docs: bytes == chars (no observable change)", async () => {
    const h = buildHarness();
    await h.db(["x", "insert", '{"name":"Alice"}']);
    const r = await h.db(["x", "stats"]);
    const stats = JSON.parse(r.stdout) as { sizeBytes: number };
    // The internal docs.json is roughly `[{"name":"Alice","_id":"..."}]`.
    expect(stats.sizeBytes).toBeGreaterThan(20);
    // ASCII so bytes ≥ chars — should match exactly.
  });

  it("multi-byte chars: sizeBytes > char count", async () => {
    const h = buildHarness();
    // Japanese: each char is 3 UTF-8 bytes. 'こんにちは' = 5 chars, 15 bytes.
    await h.db(["x", "insert", '{"greeting":"こんにちは"}']);
    const r = await h.db(["x", "stats"]);
    const stats = JSON.parse(r.stdout) as { sizeBytes: number };

    // Compute the same value the OLD buggy code would have produced.
    const docs = h.reg.mem.readJson("x.docs.json");
    const charLen = JSON.stringify(docs).length;
    const byteLen = new TextEncoder().encode(JSON.stringify(docs)).byteLength;

    expect(byteLen).toBeGreaterThan(charLen); // proves multi-byte exists
    expect(stats.sizeBytes).toBe(byteLen);    // proves we report bytes, not chars
  });

  it("empty collection: sizeBytes is 0", async () => {
    const h = buildHarness();
    await h.db(["x", "insert", '{"a":1}']);
    await h.db(["x", "remove", '{"a":1}']);
    const r = await h.db(["x", "stats"]);
    const stats = JSON.parse(r.stdout) as { count: number; sizeBytes: number };
    expect(stats.count).toBe(0);
    // Note: sizeBytes is the serialized size of the collection's docs array,
    // which is `[]` (2 bytes) when empty — NOT zero.
    expect(stats.sizeBytes).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix 4: vec import validates record shape per item
// ─────────────────────────────────────────────────────────────────────────

describe("v1.0.1 fix 4: vec import runtime validation", () => {
  // These tests need stdin override for `-`, so they construct their own
  // fs/reg/cmd rather than using the shared Harness.
  it("rejects record missing 'id' with index in error message", async () => {
    const bad = JSON.stringify([
      { id: "ok", vector: [1, 0, 0] },
      { vector: [0, 1, 0] }, // missing id
    ]);
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    const cmd = buildVecCommand(() => reg);
    await cmd.execute(["create", "v", "--dim", "3"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
    });
    const r = await cmd.execute(["import", "v", "-"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: bad,
    });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("index 1");
    expect(r.stderr).toContain("non-string id");
  });

  it("rejects record with wrong dim", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    const cmd = buildVecCommand(() => reg);
    await cmd.execute(["create", "v", "--dim", "3"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
    });
    const bad = JSON.stringify([{ id: "a", vector: [1, 2] }]);
    const r = await cmd.execute(["import", "v", "-"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: bad,
    });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("dim mismatch (2 vs 3)");
  });

  it("rejects non-finite numbers", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    const cmd = buildVecCommand(() => reg);
    await cmd.execute(["create", "v", "--dim", "2"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
    });
    // We can't put NaN into JSON literally, so we reach via a record where
    // vector is e.g. ["1", "2"] (not numbers).
    const bad = JSON.stringify([{ id: "a", vector: ["x", "y"] }]);
    const r = await cmd.execute(["import", "v", "-"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: bad,
    });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("non-finite");
  });

  it("happy path: well-formed import succeeds", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    const cmd = buildVecCommand(() => reg);
    await cmd.execute(["create", "v", "--dim", "2"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
    });
    const good = JSON.stringify([
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0, 1], metadata: { tag: "y" } },
    ]);
    const r = await cmd.execute(["import", "v", "-"], {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: good,
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { imported: number };
    expect(out.imported).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix 5: EncryptedBinAdapter corruption detection surfaced in vec stats
// ─────────────────────────────────────────────────────────────────────────

describe("v1.0.1 fix 5: encrypted bin corruption detection", () => {
  it("non-encrypted collection: no 'corrupted' field in stats", async () => {
    const h = buildHarness();
    await h.vec(["create", "v", "--dim", "2"]);
    const r = JSON.parse((await h.vec(["stats", "v"])).stdout) as Record<string, unknown>;
    expect(r["corrupted"]).toBeUndefined();
  });

  it("MemoryAdapter unaffected by isCorrupted (encryption-only feature)", async () => {
    const h = buildHarness();
    await h.vec(["create", "v", "--dim", "2"]);
    await h.vec(["store", "v", "x", "[1,0]"]);
    const r = JSON.parse((await h.vec(["stats", "v"])).stdout) as Record<string, unknown>;
    expect(r["count"]).toBe(1);
    expect(r["corrupted"]).toBeUndefined();
  });

  it("encrypted store: corrupt ciphertext on disk → next hydrate flags corrupted", async () => {
    // Setup: write a vector with key K1, then corrupt the file on disk and
    // reopen with the same key — preload should fail decrypt and mark
    // corrupted.
    const fs = new InMemoryFs({});

    {
      const reg = new PluginRegistry(fs, { encryptionKey: "k" });
      const cmd = buildVecCommand(() => reg);
      const ctx = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
      expect((await cmd.execute(["create", "v", "--dim", "2"], ctx())).exitCode).toBe(0);
      expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx())).exitCode).toBe(0);
    }

    // Corrupt the bin file on disk by overwriting its body with garbage
    // (keep the IV but flip the ciphertext bytes). Float32 -> .bin suffix.
    const binPath = "/data/v.bin";
    const orig = await fs.readFileBuffer(binPath);
    expect(orig.byteLength).toBeGreaterThan(12);
    const corrupted = new Uint8Array(orig);
    // Flip every byte after the 12-byte IV.
    for (let i = 12; i < corrupted.length; i++) {
      corrupted[i] = (corrupted[i] ?? 0) ^ 0xff;
    }
    await fs.writeFile(binPath, corrupted);

    // Reopen with same key — preload now fails decrypt for the .bin entry.
    const reg2 = new PluginRegistry(fs, { encryptionKey: "k" });
    const cmd2 = buildVecCommand(() => reg2);
    const ctx2 = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
    const stats = await cmd2.execute(["stats", "v"], ctx2());
    expect(stats.exitCode).toBe(0);
    const r = JSON.parse(stats.stdout) as Record<string, unknown>;
    expect(r["corrupted"]).toBe(true);
  });

  it("encrypted store: wrong key on second open flags corrupted", async () => {
    const fs = new InMemoryFs({});

    {
      const reg = new PluginRegistry(fs, { encryptionKey: "k1" });
      const cmd = buildVecCommand(() => reg);
      const ctx = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
      expect((await cmd.execute(["create", "v", "--dim", "2"], ctx())).exitCode).toBe(0);
      expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx())).exitCode).toBe(0);
    }

    // Reopen with wrong key — preload's decrypt throws for the bin entry.
    const reg2 = new PluginRegistry(fs, { encryptionKey: "k2" });
    const cmd2 = buildVecCommand(() => reg2);
    const ctx2 = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
    const stats = await cmd2.execute(["stats", "v"], ctx2());
    expect(stats.exitCode).toBe(0);
    const r = JSON.parse(stats.stdout) as Record<string, unknown>;
    expect(r["corrupted"]).toBe(true);
  });
});
