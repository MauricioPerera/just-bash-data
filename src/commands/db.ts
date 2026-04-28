import { defineCommand, type Command, type IFileSystem } from "just-bash";
import { parseCommandArgs } from "../lib/args.js";
import { CommandError, EXIT, validateCollName } from "../lib/errors.js";
import { runCommand } from "../lib/runner.js";
import type { PluginRegistry } from "../registry.js";
import { authHandler } from "./db/auth.js";
import {
  aggregateHandler,
  countHandler,
  findHandler,
  insertHandler,
  removeHandler,
  updateHandler,
} from "./db/crud.js";
import {
  dropHandler,
  exportHandler,
  importHandler,
  indexHandler,
  statsHandler,
} from "./db/meta.js";
import { ensureSingleStdinDash } from "./db/shared.js";

const FLAG_SPEC = {
  bool: ["many", "json", "sorted", "unique", "all"] as const,
  string: ["token", "sort", "limit", "skip", "project", "roles"] as const,
};

export type RegistryProvider = (fs: IFileSystem) => PluginRegistry;

export const buildDbCommand = (provide: RegistryProvider): Command =>
  defineCommand("db", async (args, ctx) =>
    runCommand(async () => {
      const reg = provide(ctx.fs);
      const parsed = parseCommandArgs(args, FLAG_SPEC);
      ensureSingleStdinDash(parsed.positional);
      const first = parsed.positional[0];
      if (!first) {
        throw new CommandError(
          EXIT.USAGE,
          "usage: db <coll|auth> <subcommand> [args...]",
        );
      }

      await reg.ensureHydrated();

      let result: { stdout: string };
      let mutated = false;

      if (first === "auth") {
        result = await authHandler(reg, ctx, parsed);
        const sub = parsed.positional[1];
        mutated = sub === "register" || sub === "login" || sub === "logout" || sub === "role";
      } else {
        const coll = first;
        validateCollName(coll);
        const sub = parsed.positional[1];
        if (!sub) {
          throw new CommandError(
            EXIT.USAGE,
            "usage: db <coll> <subcommand> [args...]",
          );
        }
        switch (sub) {
          case "insert":
            result = await insertHandler(reg, ctx, parsed, coll);
            mutated = true;
            break;
          case "find":
            result = await findHandler(reg, ctx, parsed, coll);
            break;
          case "count":
            result = await countHandler(reg, ctx, parsed, coll);
            break;
          case "update":
            result = await updateHandler(reg, ctx, parsed, coll);
            mutated = true;
            break;
          case "remove":
            result = await removeHandler(reg, ctx, parsed, coll);
            mutated = true;
            break;
          case "aggregate":
            result = await aggregateHandler(reg, ctx, parsed, coll);
            break;
          case "index": {
            result = await indexHandler(reg, ctx, parsed, coll);
            const idxOp = parsed.positional[2];
            mutated = idxOp === "create" || idxOp === "drop";
            break;
          }
          case "drop":
            result = await dropHandler(reg, ctx, parsed, coll);
            mutated = true;
            break;
          case "stats":
            result = await statsHandler(reg, ctx, parsed, coll);
            break;
          case "export":
            result = await exportHandler(reg, ctx, parsed, coll);
            break;
          case "import":
            result = await importHandler(reg, ctx, parsed, coll);
            mutated = true;
            break;
          default:
            throw new CommandError(EXIT.USAGE, `unknown subcommand: db <coll> ${sub}`);
        }
      }

      if (mutated) {
        reg.getDocStore().flush();
        await reg.flushIfDirty();
      }
      return result;
    }),
  );
