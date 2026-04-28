import type { CommandContext } from "just-bash";
import { flagBool, flagString, type ParsedArgs } from "../../lib/args.js";
import { CommandError, EXIT } from "../../lib/errors.js";
import type { PluginRegistry } from "../../registry.js";
import {
  parseVectorJson,
  requireVecColl,
  validateMetric,
  validateQuantize,
} from "./shared.js";

export const createOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  if (!coll) throw new CommandError(EXIT.USAGE, "usage: vec create <coll> --dim N");
  if (reg.getVectorCollection(coll)) {
    throw new CommandError(EXIT.VALIDATION, `validation: collection exists: ${coll}`);
  }
  const dimStr = flagString(parsed.flags, "dim");
  if (!dimStr) throw new CommandError(EXIT.USAGE, "missing --dim");
  const dim = Number(dimStr);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new CommandError(EXIT.USAGE, `invalid --dim: ${dimStr}`);
  }
  if (dim > 65536) {
    throw new CommandError(EXIT.USAGE, `--dim too large: ${dim} (max 65536)`);
  }
  const quantizeFlag = flagString(parsed.flags, "quantize");
  const quantize = quantizeFlag ? validateQuantize(quantizeFlag) : "float32";
  const metricFlag = flagString(parsed.flags, "metric");
  const metric = metricFlag ? validateMetric(metricFlag) : "cosine";

  // IVF config: --ivf flag enables it; --ivf-clusters / --ivf-probes tune.
  // Numeric flags imply --ivf even without the bool flag (DX shortcut).
  const ivfClustersStr = flagString(parsed.flags, "ivf-clusters");
  const ivfProbesStr = flagString(parsed.flags, "ivf-probes");
  const ivfRequested =
    flagBool(parsed.flags, "ivf") ||
    ivfClustersStr !== undefined ||
    ivfProbesStr !== undefined;
  let ivf: { numClusters: number; numProbes: number } | undefined;
  if (ivfRequested) {
    const numClusters = ivfClustersStr ? Number(ivfClustersStr) : 100;
    const numProbes = ivfProbesStr ? Number(ivfProbesStr) : 10;
    if (!Number.isInteger(numClusters) || numClusters <= 0) {
      throw new CommandError(EXIT.USAGE, `invalid --ivf-clusters: ${ivfClustersStr}`);
    }
    if (!Number.isInteger(numProbes) || numProbes <= 0) {
      throw new CommandError(EXIT.USAGE, `invalid --ivf-probes: ${ivfProbesStr}`);
    }
    if (numProbes > numClusters) {
      throw new CommandError(
        EXIT.USAGE,
        `--ivf-probes (${numProbes}) cannot exceed --ivf-clusters (${numClusters})`,
      );
    }
    ivf = { numClusters, numProbes };
  }

  const entry = reg.registerVectorCollection(coll, dim, quantize, metric, ivf);
  reg.persistVectorRegistry();
  const out: Record<string, unknown> = {
    coll,
    dim: entry.dim,
    quantize: entry.quantize,
    metric: entry.metric,
  };
  if (entry.ivf) out["ivf"] = entry.ivf;
  return { stdout: JSON.stringify(out) };
};

export const ivfOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const sub = parsed.positional[1];
  const coll = parsed.positional[2];
  if (!coll) {
    throw new CommandError(EXIT.USAGE, "usage: vec ivf <build|stats|drop> <coll>");
  }
  const entry = requireVecColl(reg, coll);
  if (!entry.ivfIndex) {
    throw new CommandError(
      EXIT.USAGE,
      `collection '${coll}' was not created with --ivf; recreate with --ivf or --ivf-clusters`,
    );
  }
  switch (sub) {
    case "build": {
      const sampleDimsStr = flagString(parsed.flags, "sample-dims");
      const sampleDims = sampleDimsStr ? Number(sampleDimsStr) : Math.min(128, entry.dim);
      try {
        const result = entry.ivfIndex.build(coll, sampleDims);
        return { stdout: JSON.stringify({ coll, ...result }) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("vacía") || msg.toLowerCase().includes("empty")) {
          throw new CommandError(EXIT.VALIDATION, `validation: collection is empty: ${coll}`);
        }
        throw err;
      }
    }
    case "stats": {
      const stats = entry.ivfIndex.indexStats(coll);
      if (!stats) {
        throw new CommandError(
          EXIT.NOT_FOUND,
          `not found: ivf index not built for ${coll} (run: vec ivf build ${coll})`,
        );
      }
      return {
        stdout: JSON.stringify({
          coll,
          ...stats,
          numVectors: entry.store.count(coll),
        }),
      };
    }
    case "drop": {
      if (!entry.ivfIndex.hasIndex(coll)) {
        throw new CommandError(EXIT.NOT_FOUND, `not found: ivf index for ${coll}`);
      }
      entry.ivfIndex.dropIndex(coll);
      return { stdout: JSON.stringify({ dropped: coll }) };
    }
    default:
      throw new CommandError(
        EXIT.USAGE,
        `usage: vec ivf <build|stats|drop> <coll>`,
      );
  }
};

export const storeOp = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  const id = parsed.positional[2];
  const vecArg = parsed.positional[3];
  if (!coll || !id) {
    throw new CommandError(EXIT.USAGE, "usage: vec store <coll> <id> <vector>");
  }
  const entry = requireVecColl(reg, coll);
  const vector = parseVectorJson(vecArg, ctx);
  if (vector.length !== entry.dim) {
    throw new CommandError(
      EXIT.VALIDATION,
      `validation: dim mismatch (got ${vector.length}, expected ${entry.dim})`,
    );
  }
  const metaFlag = flagString(parsed.flags, "meta");
  let meta: Record<string, unknown> = {};
  if (metaFlag !== undefined) {
    try {
      const parsedMeta = JSON.parse(metaFlag);
      if (typeof parsedMeta === "object" && parsedMeta !== null && !Array.isArray(parsedMeta)) {
        meta = parsedMeta as Record<string, unknown>;
      }
    } catch {
      throw new CommandError(EXIT.USAGE, "invalid --meta: not valid JSON");
    }
  }
  entry.store.set(coll, id, vector, meta);
  return { stdout: JSON.stringify({ id }) };
};

export const storeBatchOp = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  const src = parsed.positional[2];
  if (!coll || !src) {
    throw new CommandError(EXIT.USAGE, "usage: vec store-batch <coll> <jsonl-path-or-->");
  }
  const entry = requireVecColl(reg, coll);
  let text: string;
  if (src === "-") {
    text = ctx.stdin;
  } else {
    try {
      text = await ctx.fs.readFile(src, "utf8");
    } catch {
      throw new CommandError(EXIT.USAGE, `cannot read jsonl: ${src}`);
    }
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  let stored = 0;
  let skipped = 0;
  const errors: Array<{ line: number; reason: string }> = [];
  const skip = (line: number, reason: string): void => {
    skipped++;
    if (errors.length < 20) errors.push({ line, reason });
  };
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] as string;
    let parsedRec: unknown;
    try {
      parsedRec = JSON.parse(lineText);
    } catch {
      skip(i + 1, "invalid json");
      continue;
    }
    if (!parsedRec || typeof parsedRec !== "object" || Array.isArray(parsedRec)) {
      skip(i + 1, "not an object");
      continue;
    }
    const rec = parsedRec as Record<string, unknown>;
    const recId = rec["id"];
    const recVec = rec["vector"];
    if (typeof recId !== "string" || !Array.isArray(recVec)) {
      skip(i + 1, "missing id or vector");
      continue;
    }
    if (recVec.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      skip(i + 1, "non-finite numbers in vector");
      continue;
    }
    if (recVec.length !== entry.dim) {
      skip(i + 1, `dim mismatch (${recVec.length} vs ${entry.dim})`);
      continue;
    }
    if (entry.store.has(coll, recId)) {
      throw new CommandError(EXIT.VALIDATION, `validation: id collision: ${recId}`);
    }
    const recMeta = rec["meta"];
    const meta = recMeta && typeof recMeta === "object" && !Array.isArray(recMeta)
      ? (recMeta as Record<string, unknown>)
      : {};
    entry.store.set(coll, recId, recVec as number[], meta);
    stored++;
  }
  return { stdout: JSON.stringify({ stored, skipped, errors }) };
};

export const searchOp = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  const vecArg = parsed.positional[2];
  if (!coll) throw new CommandError(EXIT.USAGE, "usage: vec search <coll> <vector>");
  const entry = requireVecColl(reg, coll);
  const query = parseVectorJson(vecArg, ctx);
  const k = Number(flagString(parsed.flags, "k") ?? "10");
  const metricOverride = flagString(parsed.flags, "metric");
  const metric = metricOverride ? validateMetric(metricOverride) : entry.metric;
  const matryoshka = flagString(parsed.flags, "matryoshka");
  const noIvf = flagBool(parsed.flags, "no-ivf");

  // Route through IVF when available unless --no-ivf opts out. IVFIndex's
  // search uses cosine internally regardless of the collection's metric, so
  // --metric and IVF are mutually exclusive — fall back to brute-force if
  // an explicit metric override is requested.
  const useIvf =
    !noIvf &&
    !metricOverride &&
    entry.ivfIndex !== undefined &&
    entry.ivfIndex.hasIndex(coll);

  let hits;
  if (useIvf) {
    hits = matryoshka
      ? entry.ivfIndex!.matryoshkaSearch(
          coll,
          query,
          k,
          matryoshka.split(",").map((s) => Number(s.trim())),
        )
      : entry.ivfIndex!.search(coll, query, k);
  } else {
    hits = matryoshka
      ? entry.store.matryoshkaSearch(
          coll,
          query,
          k,
          matryoshka.split(",").map((s) => Number(s.trim())),
          metric,
        )
      : entry.store.search(coll, query, k, 0, metric, null);
  }
  return { stdout: JSON.stringify(hits) };
};

export const searchAcrossOp = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const collsArg = parsed.positional[1];
  const vecArg = parsed.positional[2];
  if (!collsArg) {
    throw new CommandError(EXIT.USAGE, "usage: vec search-across <coll-csv> <vector>");
  }
  const colls = collsArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (colls.length === 0) {
    throw new CommandError(EXIT.USAGE, "search-across needs at least one collection");
  }
  const entries = colls.map((c) => ({ coll: c, entry: requireVecColl(reg, c) }));
  const query = parseVectorJson(vecArg, ctx);
  const k = Number(flagString(parsed.flags, "k") ?? "10");
  const merged: Array<{ id: string; score: number; coll: string; metadata?: unknown }> = [];
  for (const { coll: c, entry } of entries) {
    const hits = entry.store.search(c, query, k, 0, entry.metric, null);
    for (const h of hits) {
      merged.push({ id: h.id, score: h.score, coll: c, metadata: h.metadata });
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return { stdout: JSON.stringify(merged.slice(0, k)) };
};

export const getOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  const id = parsed.positional[2];
  if (!coll || !id) throw new CommandError(EXIT.USAGE, "usage: vec get <coll> <id>");
  const entry = requireVecColl(reg, coll);
  const rec = entry.store.get(coll, id);
  if (!rec) throw new CommandError(EXIT.NOT_FOUND, `not found: ${coll}/${id}`);
  return { stdout: JSON.stringify({ id, ...rec }) };
};

export const removeOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  const id = parsed.positional[2];
  if (!coll || !id) throw new CommandError(EXIT.USAGE, "usage: vec remove <coll> <id>");
  const entry = requireVecColl(reg, coll);
  if (!entry.store.has(coll, id)) {
    throw new CommandError(EXIT.NOT_FOUND, `not found: ${coll}/${id}`);
  }
  entry.store.remove(coll, id);
  return { stdout: JSON.stringify({ removed: id }) };
};

export const statsOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  if (!coll) throw new CommandError(EXIT.USAGE, "usage: vec stats <coll>");
  const entry = requireVecColl(reg, coll);
  // Compute on-disk size from the in-memory adapter snapshot so the report
  // is consistent with what `vec export` would persist. Suffix per quantize
  // matches js-vector-store's _binFile() convention:
  //   float32   → <coll>.bin / <coll>.json
  //   int8      → <coll>.q8.bin / <coll>.q8.json
  //   binary    → <coll>.b1.bin / <coll>.b1.json
  //   polar     → <coll>.p3.bin / <coll>.p3.json
  const suffix =
    entry.quantize === "int8" ? ".q8" :
    entry.quantize === "binary" ? ".b1" :
    entry.quantize === "polar" ? ".p3" : "";
  const bin = reg.mem.snapshotBin().get(`${coll}${suffix}.bin`);
  const meta = reg.mem.snapshotJson().get(`${coll}${suffix}.json`);
  const binBytes = bin?.byteLength ?? 0;
  const metaBytes = meta ? new TextEncoder().encode(JSON.stringify(meta)).byteLength : 0;
  const out: Record<string, unknown> = {
    dim: entry.dim,
    count: entry.store.count(coll),
    quantize: entry.quantize,
    metric: entry.metric,
    sizeBytes: binBytes + metaBytes,
    binBytes,
    metaBytes,
  };
  if (entry.ivfIndex && entry.ivf) {
    out["ivf"] = {
      built: entry.ivfIndex.hasIndex(coll),
      numClusters: entry.ivf.numClusters,
      numProbes: entry.ivf.numProbes,
    };
  }
  return { stdout: JSON.stringify(out) };
};

export const dropOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  if (!coll) throw new CommandError(EXIT.USAGE, "usage: vec drop <coll>");
  const entry = requireVecColl(reg, coll);
  entry.store.drop(coll);
  reg.removeVectorCollection(coll);
  reg.persistVectorRegistry();
  return { stdout: JSON.stringify({ dropped: coll }) };
};

export const exportOp = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  if (!coll) throw new CommandError(EXIT.USAGE, "usage: vec export <coll>");
  const entry = requireVecColl(reg, coll);
  const records = entry.store.export(coll);
  return { stdout: JSON.stringify({ exported: records.length, records }) };
};

export const importOp = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const coll = parsed.positional[1];
  const src = parsed.positional[2];
  if (!coll || !src) {
    throw new CommandError(EXIT.USAGE, "usage: vec import <coll> <jsonl-path-or-->");
  }
  const entry = requireVecColl(reg, coll);
  let text: string;
  if (src === "-") {
    text = ctx.stdin;
  } else {
    try {
      text = await ctx.fs.readFile(src, "utf8");
    } catch {
      throw new CommandError(EXIT.USAGE, `cannot read input: ${src}`);
    }
  }
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(text);
  } catch {
    throw new CommandError(EXIT.VALIDATION, "validation: invalid JSON for import");
  }
  if (!Array.isArray(parsedInput)) {
    throw new CommandError(EXIT.VALIDATION, "validation: import expects an array of records");
  }
  entry.store.import(
    coll,
    parsedInput as Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>,
  );
  return { stdout: JSON.stringify({ imported: parsedInput.length }) };
};
