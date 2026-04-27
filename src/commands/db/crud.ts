import type { CommandContext } from "just-bash";
import { flagBool, flagString, type ParsedArgs } from "../../lib/args.js";
import { CommandError, EXIT } from "../../lib/errors.js";
import type { PluginRegistry } from "../../registry.js";
import {
  ensureCollExists,
  isFilter,
  parseJson,
  requireAuth,
} from "./shared.js";

export const insertHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  await requireAuth(reg, ctx, parsed);
  const docArg = parsed.positional[2];
  const doc = parseJson(docArg, ctx, "document");
  if (!isFilter(doc)) {
    throw new CommandError(EXIT.USAGE, "document must be an object");
  }
  try {
    const result = reg.getDocStore().collection(coll).insert(doc);
    return { stdout: JSON.stringify({ _id: result._id }) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Unique constraint")) {
      throw new CommandError(EXIT.VALIDATION, `validation: ${msg}`);
    }
    throw err;
  }
};

const buildCursor = (
  reg: PluginRegistry,
  coll: string,
  filter: Record<string, unknown>,
  parsed: ParsedArgs,
): unknown[] => {
  let cursor = reg.getDocStore().collection(coll).find(filter);
  const sort = flagString(parsed.flags, "sort");
  if (sort) {
    const [field, dir] = sort.split(":");
    if (!field) throw new CommandError(EXIT.USAGE, "invalid --sort");
    const order: 1 | -1 = dir === "-1" ? -1 : 1;
    cursor = cursor.sort({ [field]: order });
  }
  const skip = flagString(parsed.flags, "skip");
  if (skip) cursor = cursor.skip(Number(skip));
  const limit = flagString(parsed.flags, "limit");
  if (limit) cursor = cursor.limit(Number(limit));
  const project = flagString(parsed.flags, "project");
  if (project) {
    const spec: Record<string, 1> = {};
    for (const f of project.split(",")) spec[f.trim()] = 1;
    cursor = cursor.project(spec);
  }
  return cursor.toArray();
};

export const findHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  ensureCollExists(reg, coll);
  const filter = parseJson(parsed.positional[2] ?? "{}", ctx, "filter");
  if (!isFilter(filter)) {
    throw new CommandError(EXIT.USAGE, "filter must be an object");
  }
  const docs = buildCursor(reg, coll, filter, parsed);
  return { stdout: JSON.stringify(docs) };
};

export const countHandler = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  ensureCollExists(reg, coll);
  const filter = parseJson(parsed.positional[2] ?? "{}", _ctx, "filter");
  if (!isFilter(filter)) {
    throw new CommandError(EXIT.USAGE, "filter must be an object");
  }
  const n = reg.getDocStore().collection(coll).count(filter);
  return { stdout: JSON.stringify({ count: n }) };
};

export const updateHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  await requireAuth(reg, ctx, parsed);
  ensureCollExists(reg, coll);
  const filter = parseJson(parsed.positional[2], ctx, "filter");
  const update = parseJson(parsed.positional[3], ctx, "update");
  if (!isFilter(filter) || !isFilter(update)) {
    throw new CommandError(EXIT.USAGE, "filter and update must be objects");
  }
  const c = reg.getDocStore().collection(coll);
  const many = flagBool(parsed.flags, "many");
  try {
    const before = c.count(filter);
    const modified = many ? c.updateMany(filter, update) : c.update(filter, update);
    // Mongo updateOne semantics: matched is capped at 1 in single mode.
    const matched = many ? before : (before > 0 ? 1 : 0);
    return {
      stdout: JSON.stringify({ matched, modified }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Unique constraint")) {
      throw new CommandError(EXIT.VALIDATION, `validation: ${msg}`);
    }
    throw err;
  }
};

export const removeHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  await requireAuth(reg, ctx, parsed);
  ensureCollExists(reg, coll);
  const filter = parseJson(parsed.positional[2], ctx, "filter");
  if (!isFilter(filter)) {
    throw new CommandError(EXIT.USAGE, "filter must be an object");
  }
  const c = reg.getDocStore().collection(coll);
  const many = flagBool(parsed.flags, "many");
  const removed = many ? c.removeMany(filter) : c.remove(filter);
  return { stdout: JSON.stringify({ removed }) };
};

export const aggregateHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  coll: string,
): Promise<{ stdout: string }> => {
  ensureCollExists(reg, coll);
  const pipeline = parseJson(parsed.positional[2], ctx, "pipeline");
  if (!Array.isArray(pipeline)) {
    throw new CommandError(EXIT.USAGE, "pipeline must be an array");
  }
  let pipe = reg.getDocStore().collection(coll).aggregate();
  for (const stage of pipeline) {
    if (!isFilter(stage)) {
      throw new CommandError(EXIT.USAGE, "each pipeline stage must be an object");
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      throw new CommandError(EXIT.USAGE, "each stage must have exactly one operator");
    }
    const op = keys[0] as string;
    const arg = stage[op];
    switch (op) {
      case "$match":
        pipe = pipe.match(arg as Record<string, unknown>);
        break;
      case "$lookup":
        pipe = pipe.lookup(arg as Record<string, unknown>);
        break;
      case "$group": {
        if (!isFilter(arg)) {
          throw new CommandError(EXIT.USAGE, "$group must be an object");
        }
        const spec = arg;
        const idVal = spec["_id"];
        let field: string | null = null;
        if (typeof idVal === "string") {
          field = idVal.startsWith("$") ? idVal.slice(1) : idVal;
        }
        const accumulators: Record<string, unknown> = {};
        for (const [accName, accDef] of Object.entries(spec)) {
          if (accName === "_id") continue;
          if (!isFilter(accDef)) continue;
          const out: Record<string, unknown> = {};
          for (const [opName, opVal] of Object.entries(accDef)) {
            // Mongo idiom alias: {"$sum": <number>} means "count items per group"
            // (each doc contributes the numeric value, with 1 being the canonical
            // form). Upstream doc-store's $sum expects a string field path, so
            // {"$sum": 1} crashes with "path.includes is not a function". Rewrite
            // the well-known counting idiom to the upstream-native $count.
            if (opName === "$sum" && typeof opVal !== "string") {
              out["$count"] = 1;
              continue;
            }
            out[opName] =
              typeof opVal === "string" && opVal.startsWith("$")
                ? opVal.slice(1)
                : opVal;
          }
          accumulators[accName] = out;
        }
        pipe = pipe.group(field as unknown as string, accumulators);
        break;
      }
      case "$sort":
        pipe = pipe.sort(arg as Record<string, 1 | -1>);
        break;
      case "$limit":
        pipe = pipe.limit(arg as number);
        break;
      case "$skip":
        pipe = pipe.skip(arg as number);
        break;
      case "$project":
        pipe = pipe.project(arg as Record<string, unknown>);
        break;
      case "$unwind":
        pipe = pipe.unwind(arg as string);
        break;
      default:
        throw new CommandError(EXIT.USAGE, `unknown aggregation operator: ${op}`);
    }
  }
  return { stdout: JSON.stringify(pipe.toArray()) };
};
