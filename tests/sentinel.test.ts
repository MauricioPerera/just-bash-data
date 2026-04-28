import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { createDataPlugin, sentinelNames } from "../src/index.js";

const buildBash = (): Bash =>
  new Bash({
    fs: new InMemoryFs({}),
    customCommands: createDataPlugin(),
  });

describe("sentinel: MongoDB-shell-style dot syntax", () => {
  it("registers a sentinel for every (tool, collection) pair", () => {
    const names = sentinelNames();
    // We have 30 collections × 2 tools = 60 sentinels in the v0.7.0 list.
    expect(names.length).toBeGreaterThanOrEqual(60);
    expect(names).toContain("db.books");
    expect(names).toContain("vec.docs");
  });

  it("'db.books find {}' returns exit 2 with redirect message", async () => {
    const bash = buildBash();
    const result = await bash.exec(`db.books find '{}'`);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("'db.books'");
    expect(result.stderr).toContain("MongoDB-shell-style");
    expect(result.stderr).toContain("db books find '{}'");
  });

  it("'vec.docs stats' returns exit 2 with redirect message", async () => {
    const bash = buildBash();
    const result = await bash.exec(`vec.docs stats`);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("'vec.docs'");
    expect(result.stderr).toContain("vec docs stats");
  });

  it("redirect example uses the canonical space-separated form", async () => {
    const bash = buildBash();
    const result = await bash.exec(`db.users insert ignored`);
    // Sentinel doesn't dispatch by subcommand — it always emits the same redirect.
    // Whatever the user typed, the message points at the canonical form.
    expect(result.stderr).toMatch(/Example: db users find '\{\}'/);
  });

  it("does NOT shadow the real 'db'/'vec' commands", async () => {
    const bash = buildBash();
    // Real command still works for canonical syntax.
    const ok = await bash.exec(`db users insert '{"name":"X"}'`);
    expect(ok.exitCode).toBe(0);
    const found = await bash.exec(`db users find '{}'`);
    expect(found.exitCode).toBe(0);
  });

  it("uncovered collection names fall through to bash's native error", async () => {
    const bash = buildBash();
    // 'gadgets42' is intentionally not in COMMON_COLLECTIONS.
    const result = await bash.exec(`db.gadgets42 find '{}'`);
    // No sentinel registered → bash emits its own command-not-found.
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(2); // not our sentinel's exit
  });

  it("mentions the parens-form limitation in stderr", async () => {
    const bash = buildBash();
    const result = await bash.exec(`db.books find '{}'`);
    expect(result.stderr).toContain("rejected by bash itself");
  });
});
