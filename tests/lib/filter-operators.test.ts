import { describe, expect, it } from "vitest";
import { validateFilterOperators } from "../../src/commands/db/shared.js";

const validate = (v: unknown): void => validateFilterOperators(v, "filter");

describe("validateFilterOperators — accepts canonical $-prefixed operators", () => {
  it("passes empty object", () => {
    expect(() => validate({})).not.toThrow();
  });

  it("passes simple field-equality filters", () => {
    expect(() => validate({ name: "Alice", age: 30 })).not.toThrow();
  });

  it("passes nested $-prefixed comparison operators", () => {
    expect(() => validate({ year: { $gt: 1950 } })).not.toThrow();
    expect(() => validate({ age: { $gte: 18, $lte: 65 } })).not.toThrow();
  });

  it("passes $or / $and / $not at any depth", () => {
    expect(() =>
      validate({ $or: [{ a: 1 }, { b: { $gt: 5 } }] }),
    ).not.toThrow();
    expect(() =>
      validate({ $and: [{ x: 1 }, { $or: [{ y: 2 }, { z: 3 }] }] }),
    ).not.toThrow();
  });

  it("passes $in / $nin / $exists / $regex / $contains / $size", () => {
    expect(() =>
      validate({
        tags: { $in: ["a", "b"] },
        author: { $exists: true },
        title: { $regex: "^X" },
        bio: { $contains: "writer" },
        list: { $size: 3 },
        excluded: { $nin: [1, 2] },
      }),
    ).not.toThrow();
  });
});

describe("validateFilterOperators — rejects bareword operators (missing $)", () => {
  it("the v0.4→v0.7 benchmark trap: {gt: 1950}", () => {
    expect(() => validate({ year: { gt: 1950 } })).toThrow(
      /missing \$ prefix.*\$gt/,
    );
  });

  it("flags every comparison operator without $", () => {
    for (const op of ["eq", "ne", "gt", "gte", "lt", "lte"]) {
      expect(() => validate({ x: { [op]: 1 } })).toThrow(
        new RegExp(`did you mean '\\$${op}'`),
      );
    }
  });

  it("flags membership operators without $", () => {
    expect(() => validate({ tags: { in: ["a"] } })).toThrow(/\$in/);
    expect(() => validate({ tags: { nin: ["a"] } })).toThrow(/\$nin/);
  });

  it("flags top-level logical operators without $", () => {
    expect(() => validate({ or: [{ a: 1 }, { b: 2 }] })).toThrow(/\$or/);
    expect(() => validate({ and: [{ a: 1 }, { b: 2 }] })).toThrow(/\$and/);
  });

  it("reports the path to the offending key", () => {
    let err: Error | null = null;
    try {
      validate({ user: { profile: { age: { gt: 18 } } } });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain("user.profile.age.gt");
  });

  it("descends into arrays and reports indexed paths", () => {
    let err: Error | null = null;
    try {
      validate({ $or: [{ a: 1 }, { b: { lt: 10 } }] });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain("$or[1].b.lt");
  });

  it("catches the FIRST bareword operator on the walk", () => {
    let err: Error | null = null;
    try {
      validate({ a: { gt: 1 }, b: { lt: 2 } });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/'\$gt'/);
  });
});

describe("validateFilterOperators — false-positive boundaries", () => {
  it("does NOT flag operator names appearing as STRING VALUES", () => {
    expect(() => validate({ note: "use $gt for ranges" })).not.toThrow();
    expect(() => validate({ tags: { $in: ["gt", "lt"] } })).not.toThrow();
  });

  it("does NOT flag legitimate non-operator field names", () => {
    expect(() =>
      validate({ name: "X", description: "Y", count: 5, sum: 10 }),
    ).not.toThrow();
  });

  it("does flag a legit-but-conflicting field named after an operator (documented limit)", () => {
    // If a user has a real field literally called 'gt' the validator can't
    // distinguish it from a missing-$ typo. The error message is explicit so
    // they can recover; this test pins the behavior.
    expect(() => validate({ gt: "highest" })).toThrow(/missing \$ prefix/);
  });

  it("does not crash on null / primitive top-level values", () => {
    expect(() => validate(null)).not.toThrow();
    expect(() => validate(42)).not.toThrow();
    expect(() => validate("hello")).not.toThrow();
    expect(() => validate(true)).not.toThrow();
  });
});

describe("validateFilterOperators — composite real-world LLM emission", () => {
  it("flags the exact Llama 3.2 3B benchmark trap (cmd #7)", () => {
    // After v0.6.0 lenient JSON, '{year: {gt: 1950}}' parses to this object.
    // v0.8.0 must catch it before the doc-store silently mismatches.
    expect(() => validate({ year: { gt: 1950 } })).toThrow(/\$gt/);
  });

  it("does NOT flag the corrected canonical form", () => {
    expect(() => validate({ year: { $gt: 1950 } })).not.toThrow();
  });

  it("survives the JS-literal-style relaxer round-trip for valid operators", () => {
    // Mimics what relaxJson + JSON.parse would produce for `{$gt: 1950}`.
    expect(() => validate({ year: { $gt: 1950, $lt: 2000 } })).not.toThrow();
  });
});
