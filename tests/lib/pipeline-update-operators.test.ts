import { describe, expect, it } from "vitest";
import {
  validatePipeline,
  validateUpdateOperators,
} from "../../src/commands/db/shared.js";

describe("validatePipeline — accepts canonical $-prefixed stages", () => {
  it("passes empty pipeline", () => {
    expect(() => validatePipeline([], "pipeline")).not.toThrow();
  });

  it("passes a single $match stage", () => {
    expect(() =>
      validatePipeline([{ $match: { name: "Alice" } }], "pipeline"),
    ).not.toThrow();
  });

  it("passes the canonical RAG-style group pipeline", () => {
    expect(() =>
      validatePipeline(
        [
          { $match: { genre: "scifi" } },
          { $group: { _id: "$author", n: { $count: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 10 },
        ],
        "pipeline",
      ),
    ).not.toThrow();
  });

  it("non-array input is left for the handler to reject (no throw here)", () => {
    expect(() => validatePipeline({ $match: {} }, "pipeline")).not.toThrow();
    expect(() => validatePipeline(null, "pipeline")).not.toThrow();
    expect(() => validatePipeline("nope", "pipeline")).not.toThrow();
  });
});

describe("validatePipeline — rejects bareword stage names", () => {
  it("flags 'match' without $", () => {
    expect(() =>
      validatePipeline([{ match: { x: 1 } }], "pipeline"),
    ).toThrow(/'\$match'/);
  });

  it("flags 'group' without $ at later index", () => {
    let err: Error | null = null;
    try {
      validatePipeline(
        [{ $match: { x: 1 } }, { group: { _id: null } }],
        "pipeline",
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/'\$group'/);
    expect(err?.message).toContain("[1].group");
  });

  it("flags every pipeline stage name", () => {
    for (const stage of [
      "match", "lookup", "group", "sort", "limit", "skip", "project", "unwind",
    ]) {
      expect(() =>
        validatePipeline([{ [stage]: {} }], "pipeline"),
      ).toThrow(new RegExp(`did you mean '\\$${stage}'`));
    }
  });
});

describe("validatePipeline — recurses filter validation into $match", () => {
  it("flags bareword $-less operator inside $match value", () => {
    expect(() =>
      validatePipeline(
        [{ $match: { year: { gt: 1950 } } }],
        "pipeline",
      ),
    ).toThrow(/\$gt/);
  });

  it("does NOT flag valid $-prefixed operators inside $match", () => {
    expect(() =>
      validatePipeline(
        [{ $match: { year: { $gt: 1950 } } }],
        "pipeline",
      ),
    ).not.toThrow();
  });
});

describe("validatePipeline — group accumulator validation", () => {
  it("flags bareword 'sum' inside $group accumulator", () => {
    let err: Error | null = null;
    try {
      validatePipeline(
        [{ $group: { _id: null, n: { sum: 1 } } }],
        "pipeline",
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/'\$sum'/);
    expect(err?.message).toContain("[0].$group.n.sum");
  });

  it("flags every group accumulator name", () => {
    for (const acc of ["count", "sum", "avg", "min", "max", "push", "first", "last"]) {
      expect(() =>
        validatePipeline(
          [{ $group: { _id: null, x: { [acc]: 1 } } }],
          "pipeline",
        ),
      ).toThrow(new RegExp(`did you mean '\\$${acc}'`));
    }
  });

  it("does NOT flag _id or canonical $-prefixed accumulators", () => {
    expect(() =>
      validatePipeline(
        [
          {
            $group: {
              _id: "$genre",
              total: { $sum: "$amount" },
              n: { $count: 1 },
            },
          },
        ],
        "pipeline",
      ),
    ).not.toThrow();
  });

  it("survives accumulator value being non-object", () => {
    // Defensive: doc-store may handle later, but validator must not crash.
    expect(() =>
      validatePipeline(
        [{ $group: { _id: null, n: 42 } }],
        "pipeline",
      ),
    ).not.toThrow();
  });
});

describe("validateUpdateOperators — accepts canonical $-prefixed forms", () => {
  it("passes $set / $inc / $unset / $push / $pull / $rename", () => {
    expect(() =>
      validateUpdateOperators(
        {
          $set: { name: "Bob" },
          $inc: { hits: 1 },
          $unset: { stale: "" },
          $push: { tags: "new" },
          $pull: { items: "old" },
          $rename: { oldKey: "newKey" },
        },
        "update",
      ),
    ).not.toThrow();
  });

  it("does NOT recurse into operator values (user data is sacred)", () => {
    // {$set: {push: "value"}} is legitimate — the user is setting a field
    // literally named 'push'. The validator must not flag it.
    expect(() =>
      validateUpdateOperators(
        { $set: { push: "value", set: 1, inc: 2 } },
        "update",
      ),
    ).not.toThrow();
  });
});

describe("validateUpdateOperators — rejects bareword update operators", () => {
  it("flags 'set' without $", () => {
    expect(() =>
      validateUpdateOperators({ set: { x: 1 } }, "update"),
    ).toThrow(/'\$set'/);
  });

  it("flags every update operator name", () => {
    for (const op of ["set", "unset", "inc", "push", "pull", "rename"]) {
      expect(() =>
        validateUpdateOperators({ [op]: { x: 1 } }, "update"),
      ).toThrow(new RegExp(`did you mean '\\$${op}'`));
    }
  });

  it("ignores non-object input gracefully", () => {
    expect(() => validateUpdateOperators(null, "update")).not.toThrow();
    expect(() => validateUpdateOperators(42, "update")).not.toThrow();
    expect(() => validateUpdateOperators([1, 2], "update")).not.toThrow();
  });
});
