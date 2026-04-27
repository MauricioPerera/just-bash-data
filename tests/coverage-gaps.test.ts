import { type CommandContext, type ExecResult, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { buildDbCommand } from "../src/commands/db.js";
import { buildVecCommand } from "../src/commands/vec.js";
import { PluginRegistry, type PluginOptions } from "../src/registry.js";
import { sampleVectors, SeededPrng } from "./fixtures/data.js";

interface DbHarness {
  reg: PluginRegistry;
  fs: InMemoryFs;
  run: (args: string[], ctxOverrides?: Partial<CommandContext>) => Promise<ExecResult>;
}

interface VecHarness extends DbHarness {
  runVec: (args: string[], ctxOverrides?: Partial<CommandContext>) => Promise<ExecResult>;
}

const buildVecHarness = (opts: PluginOptions = {}): VecHarness => {
  const fs = new InMemoryFs({});
  const reg = new PluginRegistry(fs, opts);
  const dbCmd = buildDbCommand(() => reg);
  const vecCmd = buildVecCommand(() => reg);
  const baseCtx = (): CommandContext => ({
    fs,
    cwd: "/",
    env: new Map(),
    stdin: "",
  });
  return {
    reg,
    fs,
    run: (args, overrides) => dbCmd.execute(args, { ...baseCtx(), ...overrides }),
    runVec: (args, overrides) => vecCmd.execute(args, { ...baseCtx(), ...overrides }),
  };
};

const okJson = <T>(r: ExecResult): T => {
  expect(r.exitCode, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
};

describe("vec export / import roundtrip", () => {
  it("export then drop then re-create + import restores collection", async () => {
    const h = buildVecHarness();
    okJson(await h.runVec(["create", "docs", "--dim", "4"]));
    const records = sampleVectors(10, 4, 99);
    for (const r of records) {
      okJson(
        await h.runVec([
          "store",
          "docs",
          r.id,
          JSON.stringify(r.vector),
          "--meta",
          JSON.stringify(r.metadata ?? {}),
        ]),
      );
    }

    const exported = okJson<{ exported: number; records: typeof records }>(
      await h.runVec(["export", "docs"]),
    );
    expect(exported.exported).toBe(10);
    expect(exported.records).toHaveLength(10);

    okJson(await h.runVec(["drop", "docs"]));
    expect((await h.runVec(["stats", "docs"])).exitCode).toBe(3);

    okJson(await h.runVec(["create", "docs", "--dim", "4"]));
    const imported = okJson<{ imported: number }>(
      await h.runVec(
        ["import", "docs", "-"],
        { stdin: JSON.stringify(exported.records) },
      ),
    );
    expect(imported.imported).toBe(10);
    expect(okJson<{ count: number }>(await h.runVec(["stats", "docs"])).count).toBe(10);
  });

  it("import with malformed JSON → exit 5", async () => {
    const h = buildVecHarness();
    okJson(await h.runVec(["create", "docs", "--dim", "4"]));
    const r = await h.runVec(["import", "docs", "-"], { stdin: "{not-json" });
    expect(r.exitCode).toBe(5);
  });
});

describe("vec search-across", () => {
  it("merges hits across collections, sorted desc by score", async () => {
    const h = buildVecHarness();
    okJson(await h.runVec(["create", "a", "--dim", "4"]));
    okJson(await h.runVec(["create", "b", "--dim", "4"]));

    okJson(await h.runVec(["store", "a", "a1", "[1,0,0,0]"]));
    okJson(await h.runVec(["store", "a", "a2", "[0,1,0,0]"]));
    okJson(await h.runVec(["store", "b", "b1", "[1,0,0,0]"]));
    okJson(await h.runVec(["store", "b", "b2", "[0,0,1,0]"]));

    const hits = okJson<Array<{ id: string; score: number; coll: string }>>(
      await h.runVec(["search-across", "a,b", "[1,0,0,0]", "--k", "3"]),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    const topIds = hits.slice(0, 2).map((h) => `${h.coll}/${h.id}`);
    expect(topIds).toEqual(expect.arrayContaining(["a/a1", "b/b1"]));
  });

  it("missing collection in the list → exit 3", async () => {
    const h = buildVecHarness();
    okJson(await h.runVec(["create", "a", "--dim", "4"]));
    const r = await h.runVec(["search-across", "a,ghost", "[1,0,0,0]"]);
    expect(r.exitCode).toBe(3);
  });
});

describe("vec matryoshka", () => {
  it("returns hits sorted desc with progressive-dim filtering", async () => {
    const h = buildVecHarness();
    const dim = 8;
    okJson(await h.runVec(["create", "docs", "--dim", String(dim)]));
    const prng = new SeededPrng(7);
    const stored = Array.from({ length: 12 }, (_, i) => ({
      id: `id-${i}`,
      v: prng.vector(dim),
    }));
    for (const s of stored) {
      okJson(await h.runVec(["store", "docs", s.id, JSON.stringify(s.v)]));
    }
    const queryVec = stored[3]!.v;
    const hits = okJson<Array<{ id: string; score: number }>>(
      await h.runVec([
        "search",
        "docs",
        JSON.stringify(queryVec),
        "--k",
        "5",
        "--matryoshka",
        "4,6,8",
      ]),
    );
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    expect(hits[0]?.id).toBe("id-3");
  });
});

describe("db auth role assign / remove", () => {
  const setupAdmin = async (h: DbHarness): Promise<{ adminToken: string; userId: string; userToken: string }> => {
    okJson(
      await h.run([
        "auth",
        "register",
        "boss@x.com",
        "secret123",
        "--roles=admin",
      ]),
    );
    const adminLogin = okJson<{ token: string }>(
      await h.run(["auth", "login", "boss@x.com", "secret123"]),
    );

    const created = okJson<{ user: string; id: string }>(
      await h.run(["auth", "register", "u@x.com", "secret123"]),
    );
    const userLogin = okJson<{ token: string }>(
      await h.run(["auth", "login", "u@x.com", "secret123"]),
    );
    return {
      adminToken: adminLogin.token,
      userId: created.id,
      userToken: userLogin.token,
    };
  };

  it("assign + remove role with admin token", async () => {
    const h = buildVecHarness({ authSecret: "s3cr3t" });
    const { adminToken, userId } = await setupAdmin(h);

    okJson(
      await h.run([
        "auth",
        "role",
        "assign",
        userId,
        "editor",
        `--token=${adminToken}`,
      ]),
    );
    okJson(
      await h.run([
        "auth",
        "role",
        "remove",
        userId,
        "editor",
        `--token=${adminToken}`,
      ]),
    );
  });

  it("assign without admin token → exit 4", async () => {
    const h = buildVecHarness({ authSecret: "s3cr3t" });
    const { userId, userToken } = await setupAdmin(h);
    const r = await h.run([
      "auth",
      "role",
      "assign",
      userId,
      "editor",
      `--token=${userToken}`,
    ]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/role required: admin/);
  });

  it("assign on nonexistent user → exit 3", async () => {
    const h = buildVecHarness({ authSecret: "s3cr3t" });
    const { adminToken } = await setupAdmin(h);
    const r = await h.run([
      "auth",
      "role",
      "assign",
      "ghost-id",
      "editor",
      `--token=${adminToken}`,
    ]);
    expect(r.exitCode).toBe(3);
  });
});

describe("db --token overrides ctx.env", () => {
  it("explicit --token wins over ctx.env.AUTH_TOKEN", async () => {
    const h = buildVecHarness({ authSecret: "s3cr3t" });
    okJson(await h.run(["auth", "register", "u@x.com", "abcdef"]));
    const login = okJson<{ token: string }>(
      await h.run(["auth", "login", "u@x.com", "abcdef"]),
    );
    okJson(
      await h.run(
        ["x", "insert", '{"a":1}', `--token=${login.token}`],
        { env: new Map([["AUTH_TOKEN", "garbage"]]) },
      ),
    );
  });
});
