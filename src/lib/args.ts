import { CommandError, EXIT } from "./errors.js";

export interface ParseSpec {
  /** Flag names that take no value (e.g. "many", "json"). */
  bool?: readonly string[];
  /** Flag names that take a value (e.g. "token", "k"). Anything not in `bool` is treated as string-valued. */
  string?: readonly string[];
}

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

const DASH_DASH = "--";

export const parseCommandArgs = (
  argv: readonly string[],
  spec: ParseSpec = {},
): ParsedArgs => {
  const bool = new Set(spec.bool ?? []);
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (passthrough) {
      positional.push(tok);
      continue;
    }
    if (tok === DASH_DASH) {
      passthrough = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
        continue;
      }
      const name = tok.slice(2);
      if (bool.has(name)) {
        flags.set(name, true);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CommandError(EXIT.USAGE, `missing value for --${name}`);
      }
      flags.set(name, next);
      i++;
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
};

export const flagString = (
  flags: Map<string, string | boolean>,
  name: string,
): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};

export const flagBool = (
  flags: Map<string, string | boolean>,
  name: string,
): boolean => flags.get(name) === true;
