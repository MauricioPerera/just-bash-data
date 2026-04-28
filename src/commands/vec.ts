import { defineCommand, type Command, type IFileSystem } from "just-bash";
import { parseCommandArgs } from "../lib/args.js";
import { CommandError, EXIT } from "../lib/errors.js";
import { runCommand } from "../lib/runner.js";
import type { PluginRegistry } from "../registry.js";
import {
  createOp,
  dropOp,
  exportOp,
  getOp,
  importOp,
  ivfOp,
  removeOp,
  searchAcrossOp,
  searchOp,
  statsOp,
  storeBatchOp,
  storeOp,
} from "./vec/ops.js";

const FLAG_SPEC = {
  bool: ["json", "ivf", "no-ivf"] as const,
  string: [
    "dim",
    "quantize",
    "metric",
    "k",
    "probe",
    "matryoshka",
    "meta",
    "ivf-clusters",
    "ivf-probes",
    "sample-dims",
  ] as const,
};

const READ_ONLY = new Set([
  "search",
  "search-across",
  "get",
  "stats",
  "export",
]);

export type RegistryProvider = (fs: IFileSystem) => PluginRegistry;

export const buildVecCommand = (provide: RegistryProvider): Command =>
  defineCommand("vec", async (args, ctx) =>
    runCommand(async () => {
      const reg = provide(ctx.fs);
      const parsed = parseCommandArgs(args, FLAG_SPEC);
      const sub = parsed.positional[0];
      if (!sub) {
        throw new CommandError(EXIT.USAGE, "usage: vec <subcommand> [...]");
      }
      await reg.ensureHydrated();
      let result: { stdout: string };
      switch (sub) {
        case "create":
          result = await createOp(reg, ctx, parsed);
          break;
        case "store":
          result = await storeOp(reg, ctx, parsed);
          break;
        case "store-batch":
          result = await storeBatchOp(reg, ctx, parsed);
          break;
        case "search":
          result = await searchOp(reg, ctx, parsed);
          break;
        case "search-across":
          result = await searchAcrossOp(reg, ctx, parsed);
          break;
        case "get":
          result = await getOp(reg, ctx, parsed);
          break;
        case "remove":
          result = await removeOp(reg, ctx, parsed);
          break;
        case "stats":
          result = await statsOp(reg, ctx, parsed);
          break;
        case "import":
          result = await importOp(reg, ctx, parsed);
          break;
        case "export":
          result = await exportOp(reg, ctx, parsed);
          break;
        case "drop":
          result = await dropOp(reg, ctx, parsed);
          break;
        case "ivf":
          result = await ivfOp(reg, ctx, parsed);
          break;
        default:
          throw new CommandError(EXIT.USAGE, `unknown subcommand: vec ${sub}`);
      }
      // ivf build/drop mutate the index file; ivf stats is read-only.
      const isIvfReadOnly = sub === "ivf" && parsed.positional[1] === "stats";
      if (!READ_ONLY.has(sub) && !isIvfReadOnly) {
        for (const [, entry] of reg.vectorCollections()) {
          entry.store.flush();
        }
        await reg.flushIfDirty();
      }
      return result;
    }),
  );
