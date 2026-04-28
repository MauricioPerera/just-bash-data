import { describe, expect, it } from "vitest";
import { relaxJson } from "../../src/commands/db/shared.js";

const parse = (s: string): unknown => JSON.parse(relaxJson(s));

describe("relaxJson — bareword keys", () => {
  it("quotes plain bareword keys", () => {
    expect(parse("{a: 1}")).toEqual({ a: 1 });
  });

  it("quotes Mongo-style $-prefixed keys (the benchmark trap)", () => {
    expect(parse("{$gt: 1950}")).toEqual({ $gt: 1950 });
    expect(parse('{year: {$gt: 1950}}')).toEqual({ year: { $gt: 1950 } });
  });

  it("quotes underscore-prefixed and digit-containing identifiers", () => {
    expect(parse("{_id: 7, k1: 2}")).toEqual({ _id: 7, k1: 2 });
  });

  it("does NOT quote literal true/false/null", () => {
    expect(parse("[true, false, null]")).toEqual([true, false, null]);
    expect(parse("{a: true, b: false, c: null}")).toEqual({
      a: true,
      b: false,
      c: null,
    });
  });
});

describe("relaxJson — single-quoted strings", () => {
  it("rewrites single-quoted strings as double-quoted", () => {
    expect(parse("{'name': 'Alice'}")).toEqual({ name: "Alice" });
  });

  it("escapes embedded double quotes when re-quoting", () => {
    expect(parse(`{'msg': 'she said "hi"'}`)).toEqual({ msg: 'she said "hi"' });
  });

  it("preserves backslash escapes inside single-quoted strings", () => {
    expect(parse("{'path': 'a\\nb'}")).toEqual({ path: "a\nb" });
  });

  it("converts \\\\' in single-quoted to literal apostrophe", () => {
    expect(parse("{'q': 'it\\'s ok'}")).toEqual({ q: "it's ok" });
  });
});

describe("relaxJson — trailing commas", () => {
  it("strips trailing comma before object close", () => {
    expect(parse('{"a": 1,}')).toEqual({ a: 1 });
  });

  it("strips trailing comma before array close", () => {
    expect(parse("[1, 2, 3,]")).toEqual([1, 2, 3]);
  });

  it("preserves non-trailing commas inside the structure", () => {
    expect(parse("{a: 1, b: 2,}")).toEqual({ a: 1, b: 2 });
  });
});

describe("relaxJson — string content is sacred", () => {
  it("does NOT touch barewords or colons inside double-quoted strings", () => {
    expect(parse('{"msg": "key: value"}')).toEqual({ msg: "key: value" });
    expect(parse('{"q": "$gt: 5"}')).toEqual({ q: "$gt: 5" });
  });

  it("does NOT touch trailing-comma-looking text inside strings", () => {
    expect(parse('{"raw": "foo, ]"}')).toEqual({ raw: "foo, ]" });
  });

  it("does NOT confuse single-quote inside a double-quoted string", () => {
    expect(parse(`{"q": "it's fine"}`)).toEqual({ q: "it's fine" });
  });
});

describe("relaxJson — valid JSON is a no-op semantically", () => {
  it("returns same object for already-valid JSON", () => {
    const original = '{"a":1,"b":[2,3],"c":{"d":"e"}}';
    expect(parse(original)).toEqual({ a: 1, b: [2, 3], c: { d: "e" } });
  });

  it("preserves number formats", () => {
    expect(parse("[1, -2, 3.14, 1e10]")).toEqual([1, -2, 3.14, 1e10]);
  });
});

describe("relaxJson — composite real-world LLM emissions", () => {
  it("benchmark trap: Llama 3.2 3B / Llama 3.1 8B FP find filter", () => {
    // Actual emission from the benchmark: `{"year": {$gt: 1950}}`
    expect(parse('{"year": {$gt: 1950}}')).toEqual({ year: { $gt: 1950 } });
  });

  it("Mongo find with options object using barewords", () => {
    expect(
      parse("{filter: {age: {$gte: 18}}, sort: {age: -1}, limit: 10}"),
    ).toEqual({
      filter: { age: { $gte: 18 } },
      sort: { age: -1 },
      limit: 10,
    });
  });

  it("aggregate pipeline with all 3 quirks at once", () => {
    expect(
      parse(
        "[{$match: {genre: 'scifi'}}, {$group: {_id: '$genre', count: {$count: 1}},}]",
      ),
    ).toEqual([
      { $match: { genre: "scifi" } },
      { $group: { _id: "$genre", count: { $count: 1 } } },
    ]);
  });
});

describe("relaxJson — gives up cleanly on actually-malformed input", () => {
  it("unbalanced braces still throw via JSON.parse downstream", () => {
    expect(() => parse("{a: 1")).toThrow();
  });

  it("garbage stays garbage", () => {
    expect(() => parse("not json at all !!!")).toThrow();
  });
});
