import { defineCommand, type Command } from "just-bash";

/**
 * MongoDB-shell-style emissions like `db.books find '{}'` aren't parseable by
 * the `db` / `vec` commands because bash dispatches them to a *different*
 * command name (`db.books`). We can't catch the parenthesised form
 * `db.books.find(...)` — bash fails with a syntax error before any command
 * dispatch — but we can pre-register sentinels for common dot-separated
 * collection names and respond with a redirect to the canonical syntax.
 *
 * Coverage is intentionally limited to a fixed list. If an agent picks an
 * unusual collection name (`db.gadgets42`), bash falls back to its native
 * "command not found" error which is still informative enough.
 */

const COMMON_COLLECTIONS = [
  // Observed in the 8-model benchmark transcripts:
  "books", "users", "docs", "notes", "chunks", "concepts", "people",
  // Common DB-domain names:
  "items", "events", "logs", "messages", "posts", "products", "orders",
  "comments", "sessions", "tokens", "files", "tasks", "jobs", "metrics",
  // Generic / placeholder / test idioms:
  "x", "y", "test", "demo", "coll", "collection", "data", "t", "foo", "bar",
] as const;

const buildRedirectMessage = (tool: "db" | "vec", coll: string): string => {
  const example = tool === "db"
    ? `${tool} ${coll} find '{}'`
    : `${tool} ${coll} stats`;
  return (
    `'${tool}.${coll}' is MongoDB-shell-style syntax. ` +
    `This plugin uses space-separated form: '${tool} ${coll} <subcommand>'.\n` +
    `Example: ${example}\n` +
    `(Tip: the parenthesised form '${tool}.${coll}.method(...)' is rejected by bash itself before reaching the plugin — there is no way to intercept it from inside.)\n`
  );
};

const buildSentinel = (tool: "db" | "vec", coll: string): Command =>
  defineCommand(`${tool}.${coll}`, async () => ({
    stdout: "",
    stderr: buildRedirectMessage(tool, coll),
    exitCode: 2,
  }));

export const buildSentinelCommands = (): Command[] => {
  const all: Command[] = [];
  for (const coll of COMMON_COLLECTIONS) {
    all.push(buildSentinel("db", coll));
    all.push(buildSentinel("vec", coll));
  }
  return all;
};

// Exposed for tests / introspection.
export const sentinelNames = (): string[] => {
  const names: string[] = [];
  for (const coll of COMMON_COLLECTIONS) {
    names.push(`db.${coll}`);
    names.push(`vec.${coll}`);
  }
  return names;
};
