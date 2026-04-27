import { describe, expect, it } from "vitest";
import { CommandError, EXIT, isCommandError } from "../../src/lib/errors.js";

describe("CommandError", () => {
  it("carries exitCode and message", () => {
    const e = new CommandError(EXIT.AUTH, "bad token");
    expect(e.exitCode).toBe(4);
    expect(e.message).toBe("bad token");
    expect(e.name).toBe("CommandError");
    expect(e instanceof Error).toBe(true);
  });

  it("isCommandError narrows correctly", () => {
    const e: unknown = new CommandError(EXIT.NOT_FOUND, "x");
    expect(isCommandError(e)).toBe(true);
    expect(isCommandError(new Error("x"))).toBe(false);
    expect(isCommandError("nope")).toBe(false);
  });

  it("EXIT covers 0..5 with stable codes", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.RUNTIME).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.NOT_FOUND).toBe(3);
    expect(EXIT.AUTH).toBe(4);
    expect(EXIT.VALIDATION).toBe(5);
  });
});
