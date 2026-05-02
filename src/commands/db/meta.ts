import type { CommandContext } from "just-bash";
import { flagBool, type ParsedArgs } from "../../lib/args.js";
import { CommandError, EXIT } from "../../lib/errors.js";
import type { PluginRegistry } from "../../registry.js";
import {
  ensureCollExists,
  isFilter,
  parseJson,
  requireAuth,
  requireRole,
} from "./shared.js";

export const indexHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  const sub = parsed.positional[2];
  const c = reg.getDocStore().collection(coll);
  switch (sub) {
    case "create": {
      await requireAuth(reg, ctx, parsed);
      const field = parsed.positional[3];
      if (!field) throw new CommandError(EXIT.USAGE, "usage: db <coll> index create <field>");
      const sorted = flagBool(parsed.flags, "sorted");
      const unique = flagBool(parsed.flags, "unique");
      try {
        c.createIndex(field, { type: sorted ? "sorted" : "hash", unique });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Unique constraint")) {
          throw new CommandError(EXIT.VALIDATION, `validation: ${msg}`);
        }
        throw err;
      }
      return {
        stdout: JSON.stringify({ created: field, type: sorted ? "sorted" : "hash" }),
      };
    }
    case "drop": {
      await requireAuth(reg, ctx, parsed);
      const field = parsed.positional[3];
      if (!field) throw new CommandError(EXIT.USAGE, "usage: db <coll> index drop <field>");
      ensureCollExists(reg, coll);
      const exists = c.getIndexes().some((idx) => idx.field === field);
      if (!exists) {
        throw new CommandError(EXIT.NOT_FOUND, `not found: index ${field}`);
      }
      c.dropIndex(field);
      return { stdout: JSON.stringify({ dropped: field }) };
    }
    case "list": {
      ensureCollExists(reg, coll);
      return { stdout: JSON.stringify(c.getIndexes()) };
    }
    default:
      throw new CommandError(
        EXIT.USAGE,
        "usage: db <coll> index <create|drop|list> [...]",
      );
  }
};

export const dropHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  await requireRole(reg, ctx, parsed, "admin");
  ensureCollExists(reg, coll);
  reg.getDocStore().drop(coll);
  return { stdout: JSON.stringify({ dropped: coll }) };
};

export const statsHandler = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  _parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  ensureCollExists(reg, coll);
  const c = reg.getDocStore().collection(coll);
  const docs = reg.mem.readJson(`${coll}.docs.json`);
  // UTF-8 byte length, not String.length (which is UTF-16 code-unit count).
  // Matches `vec stats`'s convention so users can compare across the two
  // commands without surprises on non-ASCII data.
  const sizeBytes = docs
    ? new TextEncoder().encode(JSON.stringify(docs)).byteLength
    : 0;
  return {
    stdout: JSON.stringify({
      count: c.count(),
      indexes: c.getIndexes(),
      sizeBytes,
    }),
  };
};

export const exportHandler = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  _parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  ensureCollExists(reg, coll);
  const docs = reg.getDocStore().collection(coll).export();
  return { stdout: JSON.stringify({ exported: docs.length, docs }) };
};

export const importHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  await requireAuth(reg, ctx, parsed);
  const arg = parsed.positional[2];
  const data = parseJson(arg, ctx, "import data", "reject");
  if (!Array.isArray(data)) {
    throw new CommandError(EXIT.USAGE, "import expects an array of documents");
  }
  for (let i = 0; i < data.length; i++) {
    if (!isFilter(data[i])) {
      throw new CommandError(
        EXIT.USAGE,
        `import item at index ${i} is not an object`,
      );
    }
  }
  reg.getDocStore().collection(coll).import(data as Record<string, unknown>[]);
  return { stdout: JSON.stringify({ imported: data.length }) };
};
