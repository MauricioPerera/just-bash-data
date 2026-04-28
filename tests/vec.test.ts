import { type CommandContext, type ExecResult, InMemoryFs } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { buildVecCommand } from "../src/commands/vec.js";
import { PluginRegistry, type PluginOptions } from "../src/registry.js";

interface Harness {
  reg: PluginRegistry;
  fs: InMemoryFs;
  run: (args: string[], ctxOverrides?: Partial<CommandContext>) => Promise<ExecResult>;
}

const buildHarness = (opts: PluginOptions = {}): Harness => {
  const fs = new InMemoryFs({});
  const reg = new PluginRegistry(fs, opts);
  const cmd = buildVecCommand(() => reg);
  const baseCtx = (): CommandContext => ({
    fs,
    cwd: "/",
    env: new Map(),
    stdin: "",
  });
  const run = (args: string[], overrides?: Partial<CommandContext>): Promise<ExecResult> =>
    cmd.execute(args, { ...baseCtx(), ...overrides });
  return { reg, fs, run };
};

const okJson = <T>(r: ExecResult): T => {
  expect(r.exitCode, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
};

// Deterministic LCG so vector tests are reproducible
const seededVector = (seed: number, dim: number): number[] => {
  let state = seed >>> 0;
  return Array.from({ length: dim }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff - 0.5;
  });
};

describe("vec usage", () => {
  it("usage error when no subcommand", async () => {
    const r = await buildHarness().run([]);
    expect(r.exitCode).toBe(2);
  });

  it("unknown subcommand → exit 2", async () => {
    const r = await buildHarness().run(["nope"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("vec create", () => {
  it("creates float32 collection with cosine default", async () => {
    const h = buildHarness();
    const r = okJson<{ coll: string; dim: number; quantize: string; metric: string }>(
      await h.run(["create", "docs", "--dim", "4"]),
    );
    expect(r).toEqual({ coll: "docs", dim: 4, quantize: "float32", metric: "cosine" });
  });

  it("supports each quantize variant", async () => {
    for (const q of ["float32", "int8", "polar", "binary"] as const) {
      const h = buildHarness();
      okJson(await h.run(["create", "x", "--dim", "8", "--quantize", q]));
    }
  });

  it("rejects bad --dim", async () => {
    const r = await buildHarness().run(["create", "x", "--dim", "abc"]);
    expect(r.exitCode).toBe(2);
  });

  it("rejects duplicate collection (already exists)", async () => {
    const h = buildHarness();
    okJson(await h.run(["create", "docs", "--dim", "4"]));
    const r = await h.run(["create", "docs", "--dim", "4"]);
    expect(r.exitCode).toBe(5);
  });

  it("rejects unknown --quantize", async () => {
    const r = await buildHarness().run(["create", "x", "--dim", "4", "--quantize", "ultra"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("vec store / get / remove", () => {
  let h: Harness;
  beforeEach(async () => {
    h = buildHarness();
    okJson(await h.run(["create", "docs", "--dim", "4"]));
  });

  it("store + get roundtrip preserves vector (float32-clean values)", async () => {
    const v = [0.5, 0.25, 0.125, 0.0625];
    okJson(await h.run(["store", "docs", "a", JSON.stringify(v)]));
    const got = okJson<{ id: string; vector: number[] }>(
      await h.run(["get", "docs", "a"]),
    );
    expect(got.id).toBe("a");
    expect(got.vector).toEqual(v);
  });

  it("dim mismatch → exit 5", async () => {
    const r = await h.run(["store", "docs", "a", "[0.1,0.2]"]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/dim mismatch/);
  });

  it("invalid vector json → exit 2", async () => {
    const r = await h.run(["store", "docs", "a", "[0.1,not-a-number,0.3,0.4]"]);
    expect(r.exitCode).toBe(2);
  });

  it("get on missing id → exit 3", async () => {
    const r = await h.run(["get", "docs", "ghost"]);
    expect(r.exitCode).toBe(3);
  });

  it("remove existing id then get returns 3", async () => {
    okJson(await h.run(["store", "docs", "a", "[1,2,3,4]"]));
    okJson(await h.run(["remove", "docs", "a"]));
    expect((await h.run(["get", "docs", "a"])).exitCode).toBe(3);
  });
});

describe("vec store-batch", () => {
  let h: Harness;
  beforeEach(async () => {
    h = buildHarness();
    okJson(await h.run(["create", "docs", "--dim", "4"]));
  });

  it("imports clean records, counts skipped for malformed lines", async () => {
    const lines = [
      JSON.stringify({ id: "a", vector: [1, 2, 3, 4] }),
      "not-json",
      JSON.stringify({ id: "b", vector: [1, 2] }),
      JSON.stringify({ vector: [1, 2, 3, 4] }),
      JSON.stringify({ id: "c", vector: [1, 2, 3, NaN] }),
      JSON.stringify({ id: "d", vector: [9, 8, 7, 6] }),
    ].join("\n");
    const r = okJson<{ stored: number; skipped: number; errors: unknown[] }>(
      await h.run(["store-batch", "docs", "-"], { stdin: lines }),
    );
    expect(r.stored).toBe(2);
    expect(r.skipped).toBe(4);
    expect(r.errors.length).toBe(4);
  });

  it("id collision aborts batch with exit 5", async () => {
    okJson(await h.run(["store", "docs", "a", "[1,2,3,4]"]));
    const lines = JSON.stringify({ id: "a", vector: [9, 9, 9, 9] });
    const r = await h.run(["store-batch", "docs", "-"], { stdin: lines });
    expect(r.exitCode).toBe(5);
  });
});

describe("vec search", () => {
  let h: Harness;
  beforeEach(async () => {
    h = buildHarness();
    okJson(await h.run(["create", "docs", "--dim", "8"]));
    for (let i = 0; i < 20; i++) {
      const v = seededVector(i + 1, 8);
      okJson(await h.run(["store", "docs", `id-${i}`, JSON.stringify(v)]));
    }
  });

  it("returns up to k hits sorted by score desc", async () => {
    const q = seededVector(3, 8);
    const hits = okJson<Array<{ id: string; score: number }>>(
      await h.run(["search", "docs", JSON.stringify(q), "--k", "5"]),
    );
    expect(hits.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    expect(hits[0]?.id).toBe("id-2");
  });

  it("missing collection → exit 3", async () => {
    const r = await h.run(["search", "ghost", "[0,0,0,0,0,0,0,0]"]);
    expect(r.exitCode).toBe(3);
  });
});

describe("vec stats / drop", () => {
  it("stats reflects count + meta", async () => {
    const h = buildHarness();
    okJson(await h.run(["create", "x", "--dim", "4"]));
    okJson(await h.run(["store", "x", "a", "[1,2,3,4]"]));
    okJson(await h.run(["store", "x", "b", "[5,6,7,8]"]));
    const s = okJson<{ count: number; dim: number }>(await h.run(["stats", "x"]));
    expect(s.count).toBe(2);
    expect(s.dim).toBe(4);
  });

  it("drop removes the collection from the registry", async () => {
    const h = buildHarness();
    okJson(await h.run(["create", "x", "--dim", "4"]));
    okJson(await h.run(["drop", "x"]));
    expect((await h.run(["stats", "x"])).exitCode).toBe(3);
  });

  it("v0.4.0: stats includes sizeBytes (binBytes + metaBytes)", async () => {
    const h = buildHarness();
    okJson(await h.run(["create", "x", "--dim", "4"]));
    okJson(await h.run(["store", "x", "a", "[1,2,3,4]"]));
    okJson(await h.run(["store", "x", "b", "[5,6,7,8]"]));

    const s = okJson<{
      sizeBytes: number;
      binBytes: number;
      metaBytes: number;
      count: number;
      dim: number;
    }>(await h.run(["stats", "x"]));

    // 2 vectors × 4 dims × 4 bytes (float32) = 32 bytes minimum for the bin
    expect(s.binBytes).toBeGreaterThanOrEqual(32);
    expect(s.metaBytes).toBeGreaterThan(0);
    expect(s.sizeBytes).toBe(s.binBytes + s.metaBytes);
  });

  it("v0.4.0: stats sizeBytes scales with quantization", async () => {
    const h = buildHarness();
    okJson(await h.run(["create", "f32", "--dim", "16"]));
    okJson(await h.run(["create", "i8", "--dim", "16", "--quantize", "int8"]));
    for (const v of ["[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]", "[16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]"]) {
      okJson(await h.run(["store", "f32", String(Math.random()), v]));
      okJson(await h.run(["store", "i8", String(Math.random()), v]));
    }
    const f32Stats = okJson<{ binBytes: number }>(await h.run(["stats", "f32"]));
    const i8Stats = okJson<{ binBytes: number }>(await h.run(["stats", "i8"]));
    // int8 should be ~4× smaller than float32 for the bin payload
    expect(i8Stats.binBytes).toBeLessThan(f32Stats.binBytes);
  });
});

describe("vec persistence across registries (rehydrate)", () => {
  it("create + store, then a fresh registry on the same fs sees the data", async () => {
    const fs = new InMemoryFs({});
    const reg1 = new PluginRegistry(fs, {});
    const cmd1 = buildVecCommand(() => reg1);
    const ctx = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
    const r1 = await cmd1.execute(["create", "docs", "--dim", "4"], ctx());
    expect(r1.exitCode).toBe(0);
    const r2 = await cmd1.execute(["store", "docs", "a", "[1,2,3,4]"], ctx());
    expect(r2.exitCode).toBe(0);

    const reg2 = new PluginRegistry(fs, {});
    const cmd2 = buildVecCommand(() => reg2);
    const r3 = await cmd2.execute(["get", "docs", "a"], ctx());
    expect(r3.exitCode).toBe(0);
    const got = JSON.parse(r3.stdout) as { vector: number[] };
    expect(got.vector).toEqual([1, 2, 3, 4]);
  });
});
