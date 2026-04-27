import { describe, expect, it } from "vitest";
import { CommandError } from "../../src/lib/errors.js";
import { flagBool, flagString, parseCommandArgs } from "../../src/lib/args.js";

describe("parseCommandArgs", () => {
  it("collects positional and ignores order between flags", () => {
    const r = parseCommandArgs(["users", "find", "--limit", "10", "{}"], {
      string: ["limit"],
    });
    expect(r.positional).toEqual(["users", "find", "{}"]);
    expect(flagString(r.flags, "limit")).toBe("10");
  });

  it("supports --name=value form", () => {
    const r = parseCommandArgs(["--token=abc", "find"]);
    expect(flagString(r.flags, "token")).toBe("abc");
    expect(r.positional).toEqual(["find"]);
  });

  it("treats declared bool flags as boolean true", () => {
    const r = parseCommandArgs(["--many", "--json", "x"], {
      bool: ["many", "json"],
    });
    expect(flagBool(r.flags, "many")).toBe(true);
    expect(flagBool(r.flags, "json")).toBe(true);
    expect(r.positional).toEqual(["x"]);
  });

  it("throws USAGE when a non-bool flag has no value", () => {
    expect(() => parseCommandArgs(["--token"])).toThrowError(CommandError);
    try {
      parseCommandArgs(["--token", "--other"]);
    } catch (e) {
      expect((e as CommandError).exitCode).toBe(2);
      expect((e as CommandError).message).toContain("--token");
    }
  });

  it("'-' is positional, not a flag", () => {
    const r = parseCommandArgs(["users", "insert", "-"]);
    expect(r.positional).toEqual(["users", "insert", "-"]);
  });

  it("'--' starts passthrough so subsequent --foo become positional", () => {
    const r = parseCommandArgs(["users", "--", "--not-a-flag", "x"]);
    expect(r.positional).toEqual(["users", "--not-a-flag", "x"]);
    expect(r.flags.size).toBe(0);
  });

  it("flagBool returns false for missing or string-valued flags", () => {
    const r = parseCommandArgs(["--name=alice"], { string: ["name"] });
    expect(flagBool(r.flags, "name")).toBe(false);
    expect(flagBool(r.flags, "missing")).toBe(false);
  });
});
