import { type CommandContext, type ExecResult, InMemoryFs } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDbCommand } from "../src/commands/db.js";
import { PluginRegistry, type PluginOptions } from "../src/registry.js";

interface Harness {
  reg: PluginRegistry;
  fs: InMemoryFs;
  run: (args: string[], ctxOverrides?: Partial<CommandContext>) => Promise<ExecResult>;
}

const buildHarness = (opts: PluginOptions = {}): Harness => {
  const fs = new InMemoryFs({});
  const reg = new PluginRegistry(fs, opts);
  const cmd = buildDbCommand(() => reg);
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

describe("db usage / dispatch", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("usage error when no positional given", async () => {
    const r = await h.run([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });

  it("usage error when subcommand missing", async () => {
    const r = await h.run(["users"]);
    expect(r.exitCode).toBe(2);
  });

  it("usage error on unknown subcommand", async () => {
    const r = await h.run(["users", "nope"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unknown subcommand/);
  });

  it("rejects two `-` positionals", async () => {
    const r = await h.run(["users", "update", "-", "-"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/only one positional/);
  });
});

describe("db CRUD", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("insert returns _id", async () => {
    const out = okJson<{ _id: string }>(
      await h.run(["users", "insert", '{"name":"Alice","age":30}']),
    );
    expect(out._id).toBeTypeOf("string");
  });

  it("insert with bad JSON → exit 2", async () => {
    const r = await h.run(["users", "insert", "{invalid"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/invalid json/);
  });

  it("insert via stdin (-)", async () => {
    const out = okJson<{ _id: string }>(
      await h.run(["users", "insert", "-"], { stdin: '{"name":"Bob","age":25}' }),
    );
    expect(out._id).toBeTypeOf("string");
    const found = okJson<unknown[]>(
      await h.run(["users", "find", '{"name":"Bob"}']),
    );
    expect(found).toHaveLength(1);
  });

  it("find with $eq, $gt, $in, $regex, dot notation, sort, limit", async () => {
    await h.run(["users", "insert", '{"name":"Alice","age":30,"addr":{"city":"BA"}}']);
    await h.run(["users", "insert", '{"name":"Bob","age":25,"addr":{"city":"NYC"}}']);
    await h.run(["users", "insert", '{"name":"Carol","age":40,"addr":{"city":"BA"}}']);

    const eq = okJson<Array<{ name: string }>>(
      await h.run(["users", "find", '{"name":{"$eq":"Alice"}}']),
    );
    expect(eq).toHaveLength(1);

    const gt = okJson<unknown[]>(
      await h.run(["users", "find", '{"age":{"$gt":25}}', "--sort", "age:-1"]),
    );
    expect(gt).toHaveLength(2);

    const inOp = okJson<unknown[]>(
      await h.run(["users", "find", '{"name":{"$in":["Alice","Bob"]}}']),
    );
    expect(inOp).toHaveLength(2);

    const reg = okJson<unknown[]>(
      await h.run(["users", "find", '{"name":{"$regex":"^A"}}']),
    );
    expect(reg).toHaveLength(1);

    const dot = okJson<unknown[]>(
      await h.run(["users", "find", '{"addr.city":"BA"}', "--limit", "1"]),
    );
    expect(dot).toHaveLength(1);
  });

  it("find on missing collection → exit 3", async () => {
    const r = await h.run(["ghosts", "find", "{}"]);
    expect(r.exitCode).toBe(3);
  });

  it("count", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    await h.run(["x", "insert", '{"a":2}']);
    expect(okJson<{ count: number }>(await h.run(["x", "count", "{}"])).count).toBe(2);
  });

  it("update single + --many", async () => {
    await h.run(["x", "insert", '{"a":1,"tag":"old"}']);
    await h.run(["x", "insert", '{"a":2,"tag":"old"}']);

    const single = okJson<{ matched: number; modified: number }>(
      await h.run(["x", "update", '{"tag":"old"}', '{"$set":{"tag":"new"}}']),
    );
    expect(single.modified).toBe(1);

    const many = okJson<{ matched: number; modified: number }>(
      await h.run(["x", "update", '{"tag":"old"}', '{"$set":{"tag":"new"}}', "--many"]),
    );
    expect(many.modified).toBe(1);
  });

  it("remove single + --many", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    await h.run(["x", "insert", '{"a":2}']);
    expect(okJson<{ removed: number }>(await h.run(["x", "remove", "{}"])).removed).toBe(1);
    expect(
      okJson<{ removed: number }>(await h.run(["x", "remove", "{}", "--many"])).removed,
    ).toBe(1);
  });

  it("aggregate with $match, $group ($sum)", async () => {
    await h.run(["o", "insert", '{"status":"paid","amt":10}']);
    await h.run(["o", "insert", '{"status":"paid","amt":20}']);
    await h.run(["o", "insert", '{"status":"open","amt":5}']);

    const r = await h.run([
      "o",
      "aggregate",
      JSON.stringify([
        { $match: { status: "paid" } },
        { $group: { _id: "$status", total: { $sum: "$amt" } } },
      ]),
    ]);
    const arr = okJson<Array<{ _id: string; total: number }>>(r);
    expect(arr).toHaveLength(1);
    expect(arr[0]?.total).toBe(30);
    expect(arr[0]?._id).toBe("paid");
  });

  it("aggregate Mongo idiom: {$sum: 1} treated as {$count: 1} (count items per group)", async () => {
    const h = buildHarness();
    await h.run(["b", "insert", '{"genre":"scifi","y":1965}']);
    await h.run(["b", "insert", '{"genre":"scifi","y":1951}']);
    await h.run(["b", "insert", '{"genre":"dystopia","y":1949}']);
    await h.run(["b", "insert", '{"genre":"dystopia","y":1932}']);
    await h.run(["b", "insert", '{"genre":"fantasy","y":1937}']);

    const r = await h.run([
      "b",
      "aggregate",
      JSON.stringify([
        { $group: { _id: "$genre", count: { $sum: 1 } } },
      ]),
    ]);
    const arr = okJson<Array<{ _id: string; count: number }>>(r);
    const byId = Object.fromEntries(arr.map((x) => [x._id, x.count]));
    expect(byId).toEqual({ scifi: 2, dystopia: 2, fantasy: 1 });
  });

  it("aggregate: {$sum: '$field'} still sums field values (alias only fires for non-string)", async () => {
    const h = buildHarness();
    await h.run(["o", "insert", '{"amt":10}']);
    await h.run(["o", "insert", '{"amt":20}']);
    await h.run(["o", "insert", '{"amt":7}']);

    // String operand → real $sum semantics (sum of values, not count)
    const r = await h.run([
      "o",
      "aggregate",
      JSON.stringify([{ $group: { _id: null, total: { $sum: "$amt" } } }]),
    ]);
    const arr = okJson<Array<{ total: number }>>(r);
    expect(arr[0]?.total).toBe(37);
  });
});

describe("db indexes", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("hash + sorted + unique creation; list reflects them", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    okJson(await h.run(["x", "index", "create", "a"]));
    okJson(await h.run(["x", "index", "create", "b", "--sorted"]));
    okJson(await h.run(["x", "index", "create", "email", "--unique"]));
    const list = okJson<Array<{ field: string }>>(
      await h.run(["x", "index", "list"]),
    );
    expect(list.map((i) => i.field).sort()).toEqual(["a", "b", "email"]);
  });

  it("unique violation → exit 5", async () => {
    await h.run(["u", "insert", '{"email":"a@x"}']);
    okJson(await h.run(["u", "index", "create", "email", "--unique"]));
    const r = await h.run(["u", "insert", '{"email":"a@x"}']);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/validation:/);
  });

  it("drop on unknown index → exit 3", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run(["x", "index", "drop", "ghost"]);
    expect(r.exitCode).toBe(3);
  });
});

describe("db stats / drop (no auth)", () => {
  it("stats returns count + indexes", async () => {
    const h = buildHarness();
    await h.run(["x", "insert", '{"a":1}']);
    const s = okJson<{ count: number; indexes: unknown[] }>(
      await h.run(["x", "stats"]),
    );
    expect(s.count).toBe(1);
    expect(Array.isArray(s.indexes)).toBe(true);
  });
});

describe("db auth (when authSecret set)", () => {
  it("write without token → exit 4", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    const r = await h.run(["x", "insert", '{"a":1}']);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/missing token/);
  });

  it("read without token works (find is public)", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    // bootstrap: register a user via auth (does not require token)
    okJson(await h.run(["auth", "register", "alice@x.com", "secret123"]));
    // login (does not require token)
    const login = okJson<{ token: string }>(
      await h.run(["auth", "login", "alice@x.com", "secret123"]),
    );
    // insert needs the token
    okJson(
      await h.run(["x", "insert", '{"a":1}'], {
        env: new Map([["AUTH_TOKEN", login.token]]),
      }),
    );
    // find without token: ok (public)
    expect(okJson<unknown[]>(await h.run(["x", "find", "{}"]))).toHaveLength(1);
  });

  it("--token overrides ctx.env.AUTH_TOKEN", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
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

  it("invalid token → exit 4", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    const r = await h.run(["x", "insert", '{"a":1}', "--token=junk"]);
    expect(r.exitCode).toBe(4);
  });

  it("login with wrong password → exit 4", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    okJson(await h.run(["auth", "register", "u@x.com", "abcdef"]));
    const r = await h.run(["auth", "login", "u@x.com", "WRONG"]);
    expect(r.exitCode).toBe(4);
  });

  it("verify returns user + roles", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    okJson(await h.run(["auth", "register", "u@x.com", "abcdef"]));
    const login = okJson<{ token: string }>(
      await h.run(["auth", "login", "u@x.com", "abcdef"]),
    );
    const v = okJson<{ user: string; roles: string[] }>(
      await h.run(["auth", "verify", `--token=${login.token}`]),
    );
    expect(v.user).toBe("u@x.com");
    expect(v.roles).toContain("user");
  });

  it("logout invalidates the session", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    okJson(await h.run(["auth", "register", "u@x.com", "abcdef"]));
    const login = okJson<{ token: string }>(
      await h.run(["auth", "login", "u@x.com", "abcdef"]),
    );
    okJson(await h.run(["auth", "logout", `--token=${login.token}`]));
    const r = await h.run(["auth", "verify", `--token=${login.token}`]);
    expect(r.exitCode).toBe(4);
  });

  it("drop without admin role → exit 4", async () => {
    const h = buildHarness({ authSecret: "s3cr3t" });
    okJson(await h.run(["auth", "register", "u@x.com", "abcdef"]));
    const login = okJson<{ token: string }>(
      await h.run(["auth", "login", "u@x.com", "abcdef"]),
    );
    await h.run(["x", "insert", '{"a":1}', `--token=${login.token}`]);
    const r = await h.run(["x", "drop", `--token=${login.token}`]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/role required: admin/);
  });
});
