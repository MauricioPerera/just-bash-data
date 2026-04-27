import { type CommandContext, type ExecResult, InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { EncryptedBinAdapter, MemoryAdapter } from "../src/adapter.js";
import { buildVecCommand } from "../src/commands/vec.js";
import { Persister } from "../src/persister.js";
import { PluginRegistry } from "../src/registry.js";

const okJson = <T>(r: ExecResult): T => {
  expect(r.exitCode, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
};

describe("L-1: vec create --dim upper bound", () => {
  const buildVec = () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    const cmd = buildVecCommand(() => reg);
    const ctx = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
    return (args: string[]): Promise<ExecResult> => cmd.execute(args, ctx());
  };

  it("rejects --dim above 65536", async () => {
    const run = buildVec();
    const r = await run(["create", "huge", "--dim", "65537"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--dim too large/);
  });

  it("accepts --dim=65536 (boundary)", async () => {
    const run = buildVec();
    okJson(await run(["create", "edge", "--dim", "65536"]));
  });

  it("rejects --dim=0 and negative", async () => {
    const run = buildVec();
    expect((await run(["create", "z", "--dim", "0"])).exitCode).toBe(2);
    expect((await run(["create", "n", "--dim", "-3"])).exitCode).toBe(2);
  });
});

describe("L-2: Persister.hydrate parallelizes per-file reads", () => {
  it("loads all files in parallel (readFile call count matches file count)", async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      initial[`/data/c${i}.docs.json`] = JSON.stringify([{ _id: `id-${i}`, n: i }]);
    }
    const fs = new InMemoryFs(initial);
    const readSpy = vi.spyOn(fs, "readFile");
    const mem = new MemoryAdapter();
    const p = new Persister(fs, "/data");

    await p.hydrate(mem);

    // All 8 json files should be present in mem.
    for (let i = 0; i < 8; i++) {
      expect(mem.readJson(`c${i}.docs.json`)).toEqual([{ _id: `id-${i}`, n: i }]);
    }
    expect(readSpy).toHaveBeenCalledTimes(8);
  });
});

describe("Gap-1: hydrate gracefully skips corrupt JSON without crashing", () => {
  it("corrupt file is null in mem, sibling files load normally", async () => {
    const fs = new InMemoryFs({
      "/data/good.docs.json": JSON.stringify([{ _id: "1" }]),
      "/data/broken.docs.json": "{not valid json",
      "/data/v.bin": new Uint8Array([1, 2, 3]),
    });
    const mem = new MemoryAdapter();
    const p = new Persister(fs, "/data");

    await expect(p.hydrate(mem)).resolves.toBeUndefined();

    expect(mem.readJson("good.docs.json")).toEqual([{ _id: "1" }]);
    expect(mem.readJson("broken.docs.json")).toBeNull();
    expect(new Uint8Array(mem.readBin("v.bin")!)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("Gap-2: EncryptedBinAdapter.persist() failure leaves pending intact for retry", () => {
  it("throws on encrypt failure and pending is not cleared", async () => {
    const inner = new MemoryAdapter();
    const enc = await EncryptedBinAdapter.create(inner, "pw");

    enc.writeBin("a.bin", new Uint8Array([1, 2, 3]));
    enc.writeBin("b.bin", new Uint8Array([4, 5, 6]));

    // Sabotage subtle.encrypt to fail on the first call only.
    let calls = 0;
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(
      globalThis.crypto.subtle,
    );
    const spy = vi
      .spyOn(globalThis.crypto.subtle, "encrypt")
      .mockImplementation((alg, key, data) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("simulated encrypt failure"));
        return originalEncrypt(alg, key, data);
      });

    await expect(enc.persist()).rejects.toThrow(/simulated encrypt failure/);

    // After failure: nothing was written to inner (the failed name didn't reach inner.writeBin
    // because it threw before that line). The pending set still contains BOTH names so the next
    // persist retries them.
    expect(inner.readBin("a.bin")).toBeNull();
    expect(inner.readBin("b.bin")).toBeNull();

    // Retry without sabotage succeeds.
    spy.mockRestore();
    await expect(enc.persist()).resolves.toBeUndefined();
    expect(inner.readBin("a.bin")).not.toBeNull();
    expect(inner.readBin("b.bin")).not.toBeNull();
  });
});
