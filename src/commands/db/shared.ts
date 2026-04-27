import type { CommandContext } from "just-bash";
import { CommandError, EXIT } from "../../lib/errors.js";
import { flagString, type ParsedArgs } from "../../lib/args.js";
import type { PluginRegistry } from "../../registry.js";

export const parseJson = (
  arg: string | undefined,
  ctx: CommandContext,
  fieldName: string,
): unknown => {
  if (arg === undefined) {
    throw new CommandError(EXIT.USAGE, `missing ${fieldName} argument`);
  }
  const text = arg === "-" ? ctx.stdin : arg;
  try {
    return JSON.parse(text);
  } catch {
    throw new CommandError(EXIT.USAGE, `invalid json: ${fieldName}`);
  }
};

export const ensureSingleStdinDash = (positionals: readonly string[]): void => {
  const dashCount = positionals.filter((p) => p === "-").length;
  if (dashCount > 1) {
    throw new CommandError(
      EXIT.USAGE,
      "usage: only one positional may read from stdin",
    );
  }
};

export const resolveToken = (
  ctx: CommandContext,
  parsed: ParsedArgs,
): string | undefined => {
  return flagString(parsed.flags, "token") ?? ctx.env.get("AUTH_TOKEN");
};

export const requireAuth = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ sub: string; roles: string[] }> => {
  if (!reg.opts.authSecret) {
    return { sub: "anonymous", roles: [] };
  }
  const token = resolveToken(ctx, parsed);
  if (!token) {
    throw new CommandError(EXIT.AUTH, "auth: missing token");
  }
  const auth = await reg.getAuth();
  const payload = await auth.verify(token);
  if (!payload) {
    throw new CommandError(EXIT.AUTH, "auth: invalid token");
  }
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
    throw new CommandError(EXIT.AUTH, "auth: expired token");
  }
  return { sub: payload.sub, roles: payload.roles };
};

export const requireRole = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
  role: string,
): Promise<{ sub: string; roles: string[] }> => {
  const payload = await requireAuth(reg, ctx, parsed);
  if (reg.opts.authSecret && !payload.roles.includes(role)) {
    throw new CommandError(EXIT.AUTH, `auth: role required: ${role}`);
  }
  return payload;
};

export const ensureCollExists = (
  reg: PluginRegistry,
  coll: string,
): void => {
  const meta = reg.mem.readJson(`${coll}.meta.json`);
  const docs = reg.mem.readJson(`${coll}.docs.json`);
  if (meta === null && docs === null) {
    throw new CommandError(EXIT.NOT_FOUND, `not found: ${coll}`);
  }
};

export const isFilter = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
