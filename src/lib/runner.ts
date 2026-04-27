import type { ExecResult } from "just-bash";
import { CommandError, EXIT } from "./errors.js";

export type Handler = () => Promise<{ stdout: string }>;

export const runCommand = async (handler: Handler): Promise<ExecResult> => {
  try {
    const { stdout } = await handler();
    return { stdout, stderr: "", exitCode: EXIT.OK };
  } catch (err) {
    if (err instanceof CommandError) {
      return {
        stdout: "",
        stderr: `${err.message}\n`,
        exitCode: err.exitCode,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: `${msg}\n`, exitCode: EXIT.RUNTIME };
  }
};
