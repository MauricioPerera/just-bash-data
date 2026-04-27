import type { CommandContext } from "just-bash";
import type { Metric } from "js-vector-store";
import { CommandError, EXIT } from "../../lib/errors.js";
import type { PluginRegistry, Quantize, VectorCollection } from "../../registry.js";

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
