import { describe, expect, it } from "vitest";
import { CommandError, EXIT } from "../../src/lib/errors.js";
import { runCommand } from "../../src/lib/runner.js";

describe("runCommand", () => {
  it("maps a successful handler to exit 0", async () => {
    const r = await runCommand(async () => ({ stdout: '{"ok":true}' }));
    expect(r).toEqual({ stdout: '{"ok":true}', stderr: "", exitCode: 0 });
  });

  it("maps CommandError to its exitCode and stderr with newline", async () => {
    const r = await runCommand(async () => {
      throw new CommandError(EXIT.NOT_FOUND, "not found: users");
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("not found: users\n");
  });

  it("maps a generic Error to exit 1", async () => {
    const r = await runCommand(async () => {
      throw new Error("boom");
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("boom\n");
  });

  it("maps a thrown non-Error value to exit 1", async () => {
    const r = await runCommand(async () => {
      throw "string-thrown";
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("string-thrown\n");
  });
});
