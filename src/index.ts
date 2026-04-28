import type { CustomCommand, IFileSystem } from "just-bash";
import { buildDbCommand } from "./commands/db.js";
import { buildVecCommand } from "./commands/vec.js";
import { buildSentinelCommands } from "./commands/sentinel.js";
import { PluginRegistry, type PluginOptions } from "./registry.js";

export type { PluginOptions } from "./registry.js";
export { sentinelNames } from "./commands/sentinel.js";

export const createDataPlugin = (
  opts: PluginOptions = {},
): CustomCommand[] => {
  const cache = new WeakMap<IFileSystem, PluginRegistry>();
  const provide = (fs: IFileSystem): PluginRegistry => {
    let reg = cache.get(fs);
    if (!reg) {
      reg = new PluginRegistry(fs, opts);
      cache.set(fs, reg);
    }
    return reg;
  };
  return [
    buildDbCommand(provide),
    buildVecCommand(provide),
    ...buildSentinelCommands(),
  ];
};
