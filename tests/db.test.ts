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

  it("v0.3.0 alias: empty string '' is treated as empty filter '{}'", async () => {
    const h = buildHarness();
    await h.run(["x", "insert", '{"a":1}']);
    await h.run(["x", "insert", '{"a":2}']);
    await h.run(["x", "insert", '{"a":3}']);

    const found = okJson<unknown[]>(await h.run(["x", "find", ""]));
    expect(found).toHaveLength(3);

    const counted = okJson<{ count: number }>(await h.run(["x", "count", ""]));
    expect(counted.count).toBe(3);
  });

  it("v0.3.0 alias: find accepts second positional as Mongo-style options object", async () => {
    const h = buildHarness();
    for (const n of [3, 1, 4, 1, 5, 9, 2, 6]) {
      await h.run(["x", "insert", `{"n":${n}}`]);
    }

    // sort via options
    const sorted = okJson<Array<{ n: number }>>(
      await h.run(["x", "find", "{}", '{"sort":{"n":-1}}']),
    );
    expect(sorted.map((d) => d.n)).toEqual([9, 6, 5, 4, 3, 2, 1, 1]);

    // sort + limit via options
    const top3 = okJson<Array<{ n: number }>>(
      await h.run(["x", "find", "{}", '{"sort":{"n":-1},"limit":3}']),
    );
    expect(top3.map((d) => d.n)).toEqual([9, 6, 5]);

    // skip + limit via options
    const window = okJson<Array<{ n: number }>>(
      await h.run(["x", "find", "{}", '{"sort":{"n":1},"skip":2,"limit":2}']),
    );
    expect(window.map((d) => d.n)).toEqual([2, 3]);

    // project via options
    const projected = okJson<Array<Record<string, unknown>>>(
      await h.run(["x", "find", '{"n":1}', '{"project":{"n":1}}']),
    );
    expect(projected[0]?.n).toBe(1);
  });

  it("v0.3.0: --sort flag overrides options object sort when both present", async () => {
    const h = buildHarness();
    await h.run(["x", "insert", '{"n":1}']);
    await h.run(["x", "insert", '{"n":3}']);
    await h.run(["x", "insert", '{"n":2}']);

    // flag says desc, options says asc → flag wins
    const r = okJson<Array<{ n: number }>>(
      await h.run(["x", "find", "{}", '{"sort":{"n":1}}', "--sort", "n:-1"]),
    );
    expect(r.map((d) => d.n)).toEqual([3, 2, 1]);
  });
});

describe("db v0.3.0 export / import roundtrip", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("export returns all docs in the collection", async () => {
    await h.run(["x", "insert", '{"_id":"a","name":"Alice"}']);
    await h.run(["x", "insert", '{"_id":"b","name":"Bob"}']);

    const r = okJson<{ exported: number; docs: Array<{ _id: string; name: string }> }>(
      await h.run(["x", "export"]),
    );
    expect(r.exported).toBe(2);
    expect(r.docs.map((d) => d.name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("import accepts an array of docs", async () => {
    const payload = JSON.stringify([
      { _id: "p1", v: 1 },
      { _id: "p2", v: 2 },
      { _id: "p3", v: 3 },
    ]);
    const r = okJson<{ imported: number }>(await h.run(["x", "import", payload]));
    expect(r.imported).toBe(3);

    const found = okJson<unknown[]>(await h.run(["x", "find", "{}"]));
    expect(found).toHaveLength(3);
  });

  it("export → drop → re-create → import roundtrip preserves data", async () => {
    // Set up admin-less harness so drop succeeds without RBAC
    await h.run(["x", "insert", '{"_id":"k1","tag":"keep"}']);
    await h.run(["x", "insert", '{"_id":"k2","tag":"keep"}']);

    const exported = okJson<{ exported: number; docs: unknown[] }>(
      await h.run(["x", "export"]),
    );

    okJson(await h.run(["x", "drop"]));
    expect((await h.run(["x", "stats"])).exitCode).toBe(3);

    okJson(await h.run(["x", "import", JSON.stringify(exported.docs)]));
    const after = okJson<{ count: number }>(await h.run(["x", "count", ""]));
    expect(after.count).toBe(2);
  });

  it("import rejects non-array payload with exit 2", async () => {
    const r = await h.run(["x", "import", '{"not":"an-array"}']);
    expect(r.exitCode).toBe(2);
  });

  it("import rejects array with non-object items with exit 2", async () => {
    const r = await h.run(["x", "import", '[{"ok":true}, "string"]']);
    expect(r.exitCode).toBe(2);
  });

  it("import error message includes the failing item index", async () => {
    const r = await h.run(["x", "import", '[{"ok":true}, "bad", {"also":"ok"}]']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/index 1/);
  });

  it("export of empty collection returns empty array", async () => {
    await h.run(["empty", "insert", '{"_id":"a"}']);
    await h.run(["empty", "remove", '{"_id":"a"}']);
    const r = okJson<{ exported: number; docs: unknown[] }>(
      await h.run(["empty", "export"]),
    );
    expect(r.exported).toBe(0);
    expect(r.docs).toEqual([]);
  });
});

describe("v0.3.1 H-3: per-handler empty-string policy", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("find/count accept '' as empty filter (read-only)", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    await h.run(["x", "insert", '{"a":2}']);
    expect(okJson<unknown[]>(await h.run(["x", "find", ""])).length).toBe(2);
    expect(okJson<{ count: number }>(await h.run(["x", "count", ""])).count).toBe(2);
  });

  it("remove rejects '' filter (forces explicit {})", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run(["x", "remove", ""]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/cannot be empty/);
    expect(okJson<{ count: number }>(await h.run(["x", "count", ""])).count).toBe(1);
  });

  it("update rejects '' filter (forces explicit {})", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run(["x", "update", "", '{"$set":{"b":2}}']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/filter cannot be empty/);
  });

  it("update rejects '' update spec", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run(["x", "update", '{"a":1}', ""]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/update cannot be empty/);
  });

  it("insert rejects '' document (no silent empty inserts)", async () => {
    const r = await h.run(["x", "insert", ""]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/document cannot be empty/);
  });

  it("import rejects '' payload", async () => {
    const r = await h.run(["x", "import", ""]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/cannot be empty/);
  });

  it("aggregate '' returns the original docs (empty pipeline = no-op)", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    await h.run(["x", "insert", '{"a":2}']);
    const r = okJson<unknown[]>(await h.run(["x", "aggregate", ""]));
    expect(r.length).toBe(2);
  });

  it("explicit '{}' still works for destructive handlers", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    await h.run(["x", "insert", '{"a":2}']);
    const r = okJson<{ removed: number }>(
      await h.run(["x", "remove", "{}", "--many"]),
    );
    expect(r.removed).toBe(2);
  });
});

describe("v0.6.0: lenient JSON parsing fallback", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("find accepts JS-literal Mongo filter (bareword $gt)", async () => {
    await h.run(["x", "insert", '{"year":1965}']);
    await h.run(["x", "insert", '{"year":1951}']);
    await h.run(["x", "insert", '{"year":1932}']);

    const r = okJson<Array<{ year: number }>>(
      await h.run(["x", "find", "{year: {$gt: 1950}}"]),
    );
    expect(r.map((d) => d.year).sort()).toEqual([1951, 1965]);
  });

  it("count accepts trailing comma in filter", async () => {
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    const r = okJson<{ count: number }>(
      await h.run(["x", "count", '{"genre":"scifi",}']),
    );
    expect(r.count).toBe(2);
  });

  it("insert accepts single-quoted JS-literal docs", async () => {
    okJson(await h.run(["x", "insert", "{'name': 'Alice', 'age': 30}"]));
    const found = okJson<Array<{ name: string; age: number }>>(
      await h.run(["x", "find", "{}"]),
    );
    expect(found[0]).toMatchObject({ name: "Alice", age: 30 });
  });

  it("aggregate accepts JS-literal pipeline (the benchmark trap)", async () => {
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    await h.run(["x", "insert", '{"genre":"fantasy"}']);
    const r = okJson<Array<{ _id: string; count: number }>>(
      await h.run([
        "x",
        "aggregate",
        "[{$group: {_id: '$genre', count: {$count: 1}}}]",
      ]),
    );
    const byId = Object.fromEntries(r.map((x) => [x._id, x.count]));
    expect(byId).toEqual({ scifi: 2, fantasy: 1 });
  });

  it("strict JSON unchanged: still parses and behaves identically", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const strict = okJson<unknown[]>(await h.run(["x", "find", '{"a":1}']));
    const lenient = okJson<unknown[]>(await h.run(["x", "find", "{a: 1}"]));
    expect(strict).toEqual(lenient);
  });

  it("rejects truly malformed input with exit 2", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run(["x", "find", "{this is not json at all !!!"]);
    expect(r.exitCode).toBe(2);
  });

  it("strings inside the input are not relaxed", async () => {
    // Document containing the literal text "$gt: 5" — must survive intact.
    await h.run(["x", "insert", '{"q":"$gt: 5"}']);
    const found = okJson<Array<{ q: string }>>(
      await h.run(["x", "find", "{q: '$gt: 5'}"]),
    );
    expect(found[0]?.q).toBe("$gt: 5");
  });
});

describe("v0.8.0: filter operator $-prefix validation", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("the v0.4→v0.7 silent regression now fails loud (exit 5)", async () => {
    // Llama 3.2 3B benchmark cmd #7 verbatim: missing $ on the operator name.
    // v0.4.0: exit 2 (invalid json). v0.6.0–v0.7.0: exit 0 returning ALL docs.
    // v0.8.0: exit 5 with a clear "did you mean $gt?" message.
    await h.run(["books", "insert", '{"year":1965}']);
    await h.run(["books", "insert", '{"year":1937}']);
    const r = await h.run(["books", "find", '{"year": {gt: 1950}}']);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("missing $ prefix");
    expect(r.stderr).toContain("$gt");
  });

  it("count rejects bareword operators in filter", async () => {
    await h.run(["x", "insert", '{"age":20}']);
    const r = await h.run(["x", "count", "{age: {gte: 18}}"]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$gte");
  });

  it("update rejects bareword operators in filter", async () => {
    await h.run(["x", "insert", '{"age":20}']);
    const r = await h.run(["x", "update", "{age: {lt: 18}}", '{"$set":{"y":1}}']);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$lt");
  });

  it("remove rejects bareword operators in filter", async () => {
    await h.run(["x", "insert", '{"tag":"a"}']);
    const r = await h.run(["x", "remove", "{tag: {in: [\"a\"]}}"]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$in");
  });

  it("error path includes the offending key location", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run(["x", "find", '{"user": {"profile": {"age": {"lt": 30}}}}']);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("user.profile.age.lt");
  });

  it("$-prefixed canonical form is unchanged", async () => {
    await h.run(["x", "insert", '{"year":1965}']);
    await h.run(["x", "insert", '{"year":1937}']);
    const r = okJson<Array<{ year: number }>>(
      await h.run(["x", "find", '{"year": {"$gt": 1950}}']),
    );
    expect(r.map((d) => d.year)).toEqual([1965]);
  });

  it("v0.6.0 lenient JSON still works for $-prefixed bareword keys", async () => {
    // {$gt: 1950} (with $) → relaxed to {"$gt": 1950} → valid operator.
    // This is the v0.6.0 happy path that v0.8.0 must NOT break.
    await h.run(["x", "insert", '{"year":1965}']);
    await h.run(["x", "insert", '{"year":1937}']);
    const r = okJson<Array<{ year: number }>>(
      await h.run(["x", "find", "{year: {$gt: 1950}}"]),
    );
    expect(r.map((d) => d.year)).toEqual([1965]);
  });

  it("operator-named keys inside string values do NOT trigger validation", async () => {
    await h.run(["x", "insert", '{"note":"use $gt for ranges"}']);
    const r = okJson<unknown[]>(
      await h.run(["x", "find", '{"note":"use $gt for ranges"}']),
    );
    expect(r).toHaveLength(1);
  });

  it("operator-named values inside $in arrays do NOT trigger validation", async () => {
    await h.run(["x", "insert", '{"tag":"gt"}']);
    await h.run(["x", "insert", '{"tag":"lt"}']);
    const r = okJson<unknown[]>(
      await h.run(["x", "find", '{"tag":{"$in":["gt","lt"]}}']),
    );
    expect(r).toHaveLength(2);
  });
});

describe("v0.8.1: pipeline + update operator validation", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it("aggregate rejects bareword stage names with $ hint", async () => {
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    const r = await h.run(["x", "aggregate", "[{match: {genre: 'scifi'}}]"]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$match");
    expect(r.stderr).toContain("[0].match");
  });

  it("aggregate rejects bareword stage names at index > 0", async () => {
    await h.run(["x", "insert", '{"a":1}']);
    const r = await h.run([
      "x",
      "aggregate",
      "[{$match: {a: 1}}, {group: {_id: null}}]",
    ]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$group");
    expect(r.stderr).toContain("[1].group");
  });

  it("aggregate recurses filter validation into $match value", async () => {
    await h.run(["x", "insert", '{"year":1965}']);
    const r = await h.run([
      "x",
      "aggregate",
      "[{$match: {year: {gt: 1950}}}]",
    ]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$gt");
  });

  it("aggregate flags bareword $-less group accumulators", async () => {
    await h.run(["x", "insert", '{"genre":"scifi","amount":10}']);
    const r = await h.run([
      "x",
      "aggregate",
      "[{$group: {_id: '$genre', total: {sum: '$amount'}}}]",
    ]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$sum");
    expect(r.stderr).toContain("[0].$group.total.sum");
  });

  it("aggregate happy path unchanged: canonical pipeline succeeds", async () => {
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    await h.run(["x", "insert", '{"genre":"fantasy"}']);
    const r = okJson<Array<{ _id: string; n: number }>>(
      await h.run([
        "x",
        "aggregate",
        "[{$group: {_id: '$genre', n: {$count: 1}}}]",
      ]),
    );
    expect(Object.fromEntries(r.map((x) => [x._id, x.n]))).toEqual({
      scifi: 2,
      fantasy: 1,
    });
  });

  it("v0.2.0 $sum:1 → $count:1 alias still works (must not regress)", async () => {
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    await h.run(["x", "insert", '{"genre":"scifi"}']);
    const r = okJson<Array<{ _id: string; n: number }>>(
      await h.run([
        "x",
        "aggregate",
        '[{"$group": {"_id": "$genre", "n": {"$sum": 1}}}]',
      ]),
    );
    expect(r[0]?.n).toBe(2);
  });

  it("update rejects bareword update operators", async () => {
    await h.run(["x", "insert", '{"name":"Alice","age":30}']);
    const r = await h.run(["x", "update", '{"name":"Alice"}', '{set: {age: 31}}']);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("$set");
  });

  it("update happy path unchanged: $set works", async () => {
    await h.run(["x", "insert", '{"name":"Alice","age":30}']);
    const r = okJson<{ matched: number; modified: number }>(
      await h.run(["x", "update", '{"name":"Alice"}', '{"$set":{"age":31}}']),
    );
    expect(r.modified).toBe(1);
  });

  it("update does NOT recurse into $set value (field literally named 'push' is fine)", async () => {
    await h.run(["x", "insert", '{"name":"Alice"}']);
    const r = okJson<{ modified: number }>(
      await h.run([
        "x",
        "update",
        '{"name":"Alice"}',
        '{"$set":{"push":"sticky","set":42}}',
      ]),
    );
    expect(r.modified).toBe(1);
    const found = okJson<Array<Record<string, unknown>>>(
      await h.run(["x", "find", "{}"]),
    );
    expect(found[0]).toMatchObject({ push: "sticky", set: 42 });
  });

  it("flags every update operator name with $-hint", async () => {
    await h.run(["x", "insert", '{"y":1}']);
    for (const op of ["set", "unset", "inc", "push", "pull", "rename"]) {
      const r = await h.run([
        "x",
        "update",
        '{"y":1}',
        `{${op}: {z: 1}}`,
      ]);
      expect(r.exitCode).toBe(5);
      expect(r.stderr).toContain(`$${op}`);
    }
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
