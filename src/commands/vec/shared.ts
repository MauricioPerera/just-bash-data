import type { CommandContext } from "just-bash";
import type { Metric } from "js-vector-store";
import { CommandError, EXIT, validateCollName } from "../../lib/errors.js";
import type { PluginRegistry, Quantize, VectorCollection } from "../../registry.js";

export { validateCollName };

const QUANTIZE_VALUES: readonly Quantize[] = ["float32", "int8", "polar", "binary"];
const METRIC_VALUES: readonly Metric[] = ["cosine", "euclidean", "dot", "manhattan"];

export const parseVectorJson = (
  arg: string | undefined,
  ctx: CommandContext,
): number[] => {
  if (arg === undefined) {
    throw new CommandError(EXIT.USAGE, "missing vector argument");
  }
  const text = arg === "-" ? ctx.stdin : arg;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CommandError(EXIT.USAGE, "invalid vector: not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new CommandError(EXIT.USAGE, "invalid vector: expected number[]");
  }
  return parsed as number[];
};

export const requireVecColl = (
  reg: PluginRegistry,
  coll: string,
): VectorCollection => {
  // Validate name BEFORE the lookup — even read paths must reject malicious
  // names so that a future feature inadvertently using `coll` in a path can't
  // be exploited. The Map lookup itself is safe but we want defense in depth.
  validateCollName(coll);
  const entry = reg.getVectorCollection(coll);
  if (!entry) throw new CommandError(EXIT.NOT_FOUND, `not found: ${coll}`);
  return entry;
};

export const validateQuantize = (v: string): Quantize => {
  if ((QUANTIZE_VALUES as readonly string[]).includes(v)) return v as Quantize;
  throw new CommandError(
    EXIT.USAGE,
    `invalid --quantize: ${v} (allowed: ${QUANTIZE_VALUES.join("|")})`,
  );
};

export const validateMetric = (v: string): Metric => {
  if ((METRIC_VALUES as readonly string[]).includes(v)) return v as Metric;
  throw new CommandError(
    EXIT.USAGE,
    `invalid --metric: ${v} (allowed: ${METRIC_VALUES.join("|")})`,
  );
};

/**
 * Runtime shape check for a vector record. Used by both `vec store-batch`
 * (JSONL line by line) and `vec import` (array element by element). Returns
 * a discriminated result so each caller can decide whether to skip or abort
 * the batch.
 *
 * `meta`/`metadata` field names are NOT checked here — `store-batch` uses
 * `meta`, `vec import` uses `metadata` (mirroring upstream `vec export`'s
 * output). Callers handle their own naming.
 */
export type VectorRecordCheck =
  | { ok: true; id: string; vector: number[] }
  | { ok: false; reason: string };

export const checkVectorRecord = (
  rec: unknown,
  dim: number,
): VectorRecordCheck => {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    return { ok: false, reason: "not an object" };
  }
  const r = rec as Record<string, unknown>;
  const id = r["id"];
  const vec = r["vector"];
  if (typeof id !== "string") return { ok: false, reason: "missing or non-string id" };
  if (!Array.isArray(vec)) return { ok: false, reason: "missing or non-array vector" };
  if (vec.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return { ok: false, reason: "non-finite numbers in vector" };
  }
  if (vec.length !== dim) {
    return { ok: false, reason: `dim mismatch (${vec.length} vs ${dim})` };
  }
  return { ok: true, id, vector: vec as number[] };
};
