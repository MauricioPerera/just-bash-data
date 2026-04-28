// Tests for v1.1.0 additive features: PluginOptions.salt + vec verify.
import { type CommandContext, InMemoryFs } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { buildVecCommand } from "../src/commands/vec.js";
import { PluginRegistry, type PluginOptions } from "../src/registry.js";

const ctx = (fs: InMemoryFs, stdin = ""): CommandContext => ({
  fs,
  cwd: "/",
  env: new Map(),
  stdin,
});

// ─────────────────────────────────────────────────────────────────────────
// PluginOptions.salt
// ─────────────────────────────────────────────────────────────────────────

describe("v1.1.0: PluginOptions.salt", () => {
  it("default behavior unchanged when salt is omitted (backward compat)", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, { encryptionKey: "k" });
    const cmd = buildVecCommand(() => reg);
    expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
    expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);

    // Reopen with same key + no salt → should decrypt successfully.
    const reg2 = new PluginRegistry(fs, { encryptionKey: "k" });
    const cmd2 = buildVecCommand(() => reg2);
    const get = await cmd2.execute(["get", "v", "x"], ctx(fs));
    expect(get.exitCode).toBe(0);
    const parsed = JSON.parse(get.stdout) as { vector: number[] };
    expect(parsed.vector).toEqual([1, 0]);
  });

  it("custom salt: data written with salt='A' is unreadable with salt='B'", async () => {
    const fs = new InMemoryFs({});

    // Write with salt "A"
    {
      const reg = new PluginRegistry(fs, { encryptionKey: "k", salt: "A" });
      const cmd = buildVecCommand(() => reg);
      expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
      expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);
    }

    // Reopen with salt "B" — should fail to decrypt the bin file.
    const reg2 = new PluginRegistry(fs, { encryptionKey: "k", salt: "B" });
    const cmd2 = buildVecCommand(() => reg2);
    const stats = await cmd2.execute(["stats", "v"], ctx(fs));
    expect(stats.exitCode).toBe(0);
    const r = JSON.parse(stats.stdout) as Record<string, unknown>;
    expect(r["corrupted"]).toBe(true);
  });

  it("custom salt: same salt + same key round-trips correctly", async () => {
    const fs = new InMemoryFs({});

    {
      const reg = new PluginRegistry(fs, { encryptionKey: "k", salt: "shared-salt-2026" });
      const cmd = buildVecCommand(() => reg);
      expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
      expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);
    }

    const reg2 = new PluginRegistry(fs, { encryptionKey: "k", salt: "shared-salt-2026" });
    const cmd2 = buildVecCommand(() => reg2);
    const get = await cmd2.execute(["get", "v", "x"], ctx(fs));
    expect(get.exitCode).toBe(0);
    const parsed = JSON.parse(get.stdout) as { vector: number[] };
    expect(parsed.vector).toEqual([1, 0]);
  });

  it("custom salt: data written WITH custom salt is unreadable WITHOUT custom salt", async () => {
    // Cross-test the v1.0.x default vs v1.1.0+ explicit. Catches accidental
    // collision between defaults and a literal `js-vector-store-v1` user salt.
    const fs = new InMemoryFs({});

    {
      const reg = new PluginRegistry(fs, { encryptionKey: "k", salt: "explicit" });
      const cmd = buildVecCommand(() => reg);
      expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
      expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);
    }

    const reg2 = new PluginRegistry(fs, { encryptionKey: "k" }); // no salt → default
    const cmd2 = buildVecCommand(() => reg2);
    const stats = await cmd2.execute(["stats", "v"], ctx(fs));
    expect(stats.exitCode).toBe(0);
    const r = JSON.parse(stats.stdout) as Record<string, unknown>;
    expect(r["corrupted"]).toBe(true);
  });

  it("non-encrypted plugin ignores salt option (no-op)", async () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, { salt: "ignored" });
    const cmd = buildVecCommand(() => reg);
    expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
    expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);

    const stats = await cmd.execute(["stats", "v"], ctx(fs));
    expect(stats.exitCode).toBe(0);
    const r = JSON.parse(stats.stdout) as Record<string, unknown>;
    expect(r["corrupted"]).toBeUndefined(); // never set when no encryption
  });
});

// ─────────────────────────────────────────────────────────────────────────
// vec verify <coll>
// ─────────────────────────────────────────────────────────────────────────

describe("v1.1.0: vec verify", () => {
  let fs: InMemoryFs;
  let reg: PluginRegistry;
  let cmd: ReturnType<typeof buildVecCommand>;

  const setup = (opts: PluginOptions = {}): void => {
    fs = new InMemoryFs({});
    reg = new PluginRegistry(fs, opts);
    cmd = buildVecCommand(() => reg);
  };

  beforeEach(() => {
    setup({});
  });

  it("rejects missing collection arg with usage error", async () => {
    const r = await cmd.execute(["verify"], ctx(fs));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage: vec verify");
  });

  it("rejects unknown collection with not-found", async () => {
    const r = await cmd.execute(["verify", "nope"], ctx(fs));
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("not found");
  });

  it("rejects bad collection name (defense in depth via requireVecColl)", async () => {
    const r = await cmd.execute(["verify", "../escape"], ctx(fs));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid collection name");
  });

  it("non-encrypted: ok=true, encrypted=false", async () => {
    expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
    expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);

    const r = await cmd.execute(["verify", "v"], ctx(fs));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out["coll"]).toBe("v");
    expect(out["ok"]).toBe(true);
    expect(out["encrypted"]).toBe(false);
    expect(out["reason"]).toBeUndefined();
  });

  it("encrypted + correct key: ok=true, encrypted=true", async () => {
    setup({ encryptionKey: "k" });

    expect((await cmd.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
    expect((await cmd.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);

    // Reopen with same key (forces hydrate path that runs preload).
    const reg2 = new PluginRegistry(fs, { encryptionKey: "k" });
    const cmd2 = buildVecCommand(() => reg2);
    const r = await cmd2.execute(["verify", "v"], ctx(fs));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(out["encrypted"]).toBe(true);
  });

  it("encrypted + wrong key: ok=false, includes reason", async () => {
    {
      const reg1 = new PluginRegistry(fs, { encryptionKey: "k1" });
      const cmd1 = buildVecCommand(() => reg1);
      expect((await cmd1.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
      expect((await cmd1.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);
    }

    const reg2 = new PluginRegistry(fs, { encryptionKey: "k2" });
    const cmd2 = buildVecCommand(() => reg2);
    const r = await cmd2.execute(["verify", "v"], ctx(fs));
    expect(r.exitCode).toBe(0); // verify never throws
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out["ok"]).toBe(false);
    expect(out["encrypted"]).toBe(true);
    expect(typeof out["reason"]).toBe("string");
    expect(out["reason"]).toContain("decrypt failed");
  });

  it("encrypted + tampered ciphertext: ok=false", async () => {
    {
      const reg1 = new PluginRegistry(fs, { encryptionKey: "k" });
      const cmd1 = buildVecCommand(() => reg1);
      expect((await cmd1.execute(["create", "v", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
      expect((await cmd1.execute(["store", "v", "x", "[1,0]"], ctx(fs))).exitCode).toBe(0);
    }

    // Tamper the bin body.
    const orig = await fs.readFileBuffer("/data/v.bin");
    const tampered = new Uint8Array(orig);
    for (let i = 12; i < tampered.length; i++) {
      tampered[i] = (tampered[i] ?? 0) ^ 0xff;
    }
    await fs.writeFile("/data/v.bin", tampered);

    const reg2 = new PluginRegistry(fs, { encryptionKey: "k" });
    const cmd2 = buildVecCommand(() => reg2);
    const r = await cmd2.execute(["verify", "v"], ctx(fs));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out["ok"]).toBe(false);
    expect(out["reason"]).toContain("decrypt failed");
  });

  it("reports the correct binFile suffix per quantization", async () => {
    setup({});
    expect((await cmd.execute(["create", "f32", "--dim", "2"], ctx(fs))).exitCode).toBe(0);
    expect((await cmd.execute(["create", "i8", "--dim", "2", "--quantize", "int8"], ctx(fs))).exitCode).toBe(0);
    expect((await cmd.execute(["create", "b1", "--dim", "8", "--quantize", "binary"], ctx(fs))).exitCode).toBe(0);

    const r1 = JSON.parse((await cmd.execute(["verify", "f32"], ctx(fs))).stdout) as { binFile: string };
    const r2 = JSON.parse((await cmd.execute(["verify", "i8"], ctx(fs))).stdout) as { binFile: string };
    const r3 = JSON.parse((await cmd.execute(["verify", "b1"], ctx(fs))).stdout) as { binFile: string };
    expect(r1.binFile).toBe("f32.bin");
    expect(r2.binFile).toBe("i8.q8.bin");
    expect(r3.binFile).toBe("b1.b1.bin");
  });
});
