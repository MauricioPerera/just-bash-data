import { type CommandContext, type ExecResult, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../src/adapter.js";
import { buildDbCommand } from "../src/commands/db.js";
import { Persister } from "../src/persister.js";
import { PluginRegistry, type PluginOptions } from "../src/registry.js";

describe("H-1: concurrent flush serializes writes (would lose data with old singleton)", () => {
  it("two flushes interleaved with writes both reach disk", async () => {
    const fs = new InMemoryFs({});
    const mem = new MemoryAdapter();
    const p = new Persister(fs, "/data");

    // Caller A queues write A and starts flush.
    mem.writeJson("a.json", { from: "A" });
    const flushA = p.flush(mem);

    // Before A's flush resolves, caller B writes and starts a flush.
    // The OLD impl would return A's inflight promise to B, so B's writes
    // (which arrived AFTER A's takeDirty snapshot) are silently skipped.
    mem.writeJson("b.json", { from: "B" });
    const flushB = p.flush(mem);

    await Promise.all([flushA, flushB]);

    // After both flushes settle, BOTH files must exist on disk.
    expect(await fs.exists("/data/a.json")).toBe(true);
    expect(await fs.exists("/data/b.json")).toBe(true);
    expect(JSON.parse(await fs.readFile("/data/a.json", "utf8"))).toEqual({ from: "A" });
    expect(JSON.parse(await fs.readFile("/data/b.json", "utf8"))).toEqual({ from: "B" });

    // After all flushes resolve, no dirty data should remain.
    expect(mem.hasDirty()).toBe(false);
  });

  it("a failing flush does not poison subsequent flushes", async () => {
    const fs = new InMemoryFs({});
    const mem = new MemoryAdapter();
    const p = new Persister(fs, "/data");

    // First write + flush will fail because we monkey-patch mv to reject once.
    mem.writeJson("a.json", { v: 1 });
    const origMv = fs.mv.bind(fs);
    let firstCall = true;
    fs.mv = ((src: string, dest: string) => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error("simulated mv failure"));
      }
      return origMv(src, dest);
    }) as typeof fs.mv;

    await expect(p.flush(mem)).rejects.toThrow(/simulated mv failure/);

    // Second write + flush should succeed despite the previous chain link rejecting.
    mem.writeJson("b.json", { v: 2 });
    await expect(p.flush(mem)).resolves.toBeUndefined();
    expect(await fs.exists("/data/b.json")).toBe(true);
  });
});

describe("H-2: db find --sort and --project actually order/project (not just length)", () => {
  const buildHarness = () => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, {});
    const cmd = buildDbCommand(() => reg);
    const ctx = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
    return {
      run: (args: string[]): Promise<ExecResult> => cmd.execute(args, ctx()),
    };
  };
  const okJson = <T>(r: ExecResult): T => {
    expect(r.exitCode, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as T;
  };

  it("--sort n:-1 actually returns desc order", async () => {
    const h = buildHarness();
    for (const n of [3, 1, 4, 1, 5, 9, 2, 6]) {
      await h.run(["x", "insert", `{"n":${n}}`]);
    }
    const r = okJson<Array<{ n: number }>>(
      await h.run(["x", "find", "{}", "--sort", "n:-1"]),
    );
    expect(r.map((d) => d.n)).toEqual([9, 6, 5, 4, 3, 2, 1, 1]);
  });

  it("--sort + --limit returns top-N in order", async () => {
    const h = buildHarness();
    for (const n of [3, 1, 4, 1, 5, 9, 2, 6]) {
      await h.run(["x", "insert", `{"n":${n}}`]);
    }
    const r = okJson<Array<{ n: number }>>(
      await h.run(["x", "find", "{}", "--sort", "n:-1", "--limit", "3"]),
    );
    expect(r.map((d) => d.n)).toEqual([9, 6, 5]);
  });

  it("--project n,tag includes those keys + _id, excludes others", async () => {
    const h = buildHarness();
    await h.run(["x", "insert", '{"n":1,"tag":"a","extra":"hidden"}']);
    const r = okJson<Array<Record<string, unknown>>>(
      await h.run(["x", "find", "{}", "--project", "n,tag"]),
    );
    expect(r[0]?.n).toBe(1);
    expect(r[0]?.tag).toBe("a");
    expect(r[0]?.extra).toBeUndefined();
  });
});

describe("M-1: db update single returns matched=1 even when filter matches many", () => {
  const buildHarness = (opts: PluginOptions = {}) => {
    const fs = new InMemoryFs({});
    const reg = new PluginRegistry(fs, opts);
    const cmd = buildDbCommand(() => reg);
    const ctx = (): CommandContext => ({ fs, cwd: "/", env: new Map(), stdin: "" });
    return {
      run: (args: string[]): Promise<ExecResult> => cmd.execute(args, ctx()),
    };
  };
  const okJson = <T>(r: ExecResult): T => {
    expect(r.exitCode, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as T;
  };

  it("3 docs match the filter; single update reports matched=1, modified=1", async () => {
    const h = buildHarness();
    okJson(await h.run(["x", "insert", '{"tag":"old","i":1}']));
    okJson(await h.run(["x", "insert", '{"tag":"old","i":2}']));
    okJson(await h.run(["x", "insert", '{"tag":"old","i":3}']));

    const single = okJson<{ matched: number; modified: number }>(
      await h.run(["x", "update", '{"tag":"old"}', '{"$set":{"tag":"new"}}']),
    );
    // Old impl returned matched=3 (= filter count). Mongo updateOne caps at 1.
    expect(single).toEqual({ matched: 1, modified: 1 });
  });

  it("--many still reports the full filter match count", async () => {
    const h = buildHarness();
    okJson(await h.run(["x", "insert", '{"tag":"old"}']));
    okJson(await h.run(["x", "insert", '{"tag":"old"}']));
    okJson(await h.run(["x", "insert", '{"tag":"old"}']));

    const many = okJson<{ matched: number; modified: number }>(
      await h.run(["x", "update", '{"tag":"old"}', '{"$set":{"tag":"new"}}', "--many"]),
    );
    expect(many).toEqual({ matched: 3, modified: 3 });
  });

  it("filter matches zero docs → matched=0, modified=0", async () => {
    const h = buildHarness();
    okJson(await h.run(["x", "insert", '{"tag":"a"}']));
    const r = okJson<{ matched: number; modified: number }>(
      await h.run(["x", "update", '{"tag":"missing"}', '{"$set":{"tag":"x"}}']),
    );
    expect(r).toEqual({ matched: 0, modified: 0 });
  });
});
