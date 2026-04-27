import type { CommandContext } from "just-bash";
import { flagBool, type ParsedArgs } from "../../lib/args.js";
import { CommandError, EXIT } from "../../lib/errors.js";
import type { PluginRegistry } from "../../registry.js";
import { requireAuth, requireRole, resolveToken } from "./shared.js";

const requireAuthSecret = (reg: PluginRegistry): void => {
  if (!reg.opts.authSecret) {
    throw new CommandError(
      EXIT.AUTH,
      "auth: not configured (PluginOptions.authSecret missing)",
    );
  }
};

export const authHandler = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  const sub = parsed.positional[1];
  switch (sub) {
    case "register":
      return registerSub(reg, ctx, parsed);
    case "login":
      return loginSub(reg, parsed);
    case "verify":
      return verifySub(reg, ctx, parsed);
    case "logout":
      return logoutSub(reg, ctx, parsed);
    case "role":
      return roleSub(reg, ctx, parsed);
    default:
      throw new CommandError(
        EXIT.USAGE,
        "usage: db auth <register|login|verify|logout|role> [...]",
      );
  }
};

const registerSub = async (
  reg: PluginRegistry,
  _ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  requireAuthSecret(reg);
  const user = parsed.positional[2];
  const pass = parsed.positional[3];
  if (!user || !pass) {
    throw new CommandError(
      EXIT.USAGE,
      "usage: db auth register <user> <pass> [--roles=a,b]",
    );
  }
  const auth = await reg.getAuth();
  const rolesFlag = parsed.flags.get("roles");
  const profile: Record<string, unknown> = {};
  if (typeof rolesFlag === "string") {
    profile["roles"] = rolesFlag.split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    const created = await auth.register(user, pass, profile);
    return {
      stdout: JSON.stringify({ user: created["email"], id: created._id }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Unique constraint") || msg.toLowerCase().includes("duplicate")) {
      throw new CommandError(EXIT.VALIDATION, `validation: duplicate user: ${user}`);
    }
    if (msg.includes("Password must be") || msg.includes("Email and password")) {
      throw new CommandError(EXIT.USAGE, msg);
    }
    throw err;
  }
};

const loginSub = async (
  reg: PluginRegistry,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  requireAuthSecret(reg);
  const user = parsed.positional[2];
  const pass = parsed.positional[3];
  if (!user || !pass) {
    throw new CommandError(EXIT.USAGE, "usage: db auth login <user> <pass>");
  }
  const auth = await reg.getAuth();
  try {
    const result = await auth.login(user, pass);
    return {
      stdout: JSON.stringify({
        token: result.token,
        expiresAt: new Date(
          Date.now() + 86400 * 1000,
        ).toISOString(),
      }),
    };
  } catch {
    throw new CommandError(EXIT.AUTH, "auth: invalid credentials");
  }
};

const verifySub = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  requireAuthSecret(reg);
  const token = resolveToken(ctx, parsed);
  if (!token) throw new CommandError(EXIT.AUTH, "auth: missing token");
  const auth = await reg.getAuth();
  const payload = await auth.verify(token);
  if (!payload) throw new CommandError(EXIT.AUTH, "auth: invalid token");
  return {
    stdout: JSON.stringify({
      user: payload.email,
      roles: payload.roles,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    }),
  };
};

const logoutSub = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  requireAuthSecret(reg);
  const token = resolveToken(ctx, parsed);
  if (!token) throw new CommandError(EXIT.AUTH, "auth: missing token");
  const auth = await reg.getAuth();
  const payload = await auth.verify(token);
  if (!payload) throw new CommandError(EXIT.AUTH, "auth: invalid token");
  if (flagBool(parsed.flags, "all")) {
    auth.logoutAll(payload.sub);
  } else {
    auth.logout(token);
  }
  return { stdout: JSON.stringify({ loggedOut: true }) };
};

const roleSub = async (
  reg: PluginRegistry,
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<{ stdout: string }> => {
  requireAuthSecret(reg);
  await requireRole(reg, ctx, parsed, "admin");
  const op = parsed.positional[2];
  const targetUser = parsed.positional[3];
  const role = parsed.positional[4];
  if (!op || !targetUser || !role) {
    throw new CommandError(
      EXIT.USAGE,
      "usage: db auth role <assign|remove> <user-id> <role>",
    );
  }
  const auth = await reg.getAuth();
  try {
    if (op === "assign") auth.assignRole(targetUser, role);
    else if (op === "remove") auth.removeRole(targetUser, role);
    else throw new CommandError(EXIT.USAGE, `unknown role op: ${op}`);
  } catch (err) {
    if (err instanceof CommandError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("User not found")) {
      throw new CommandError(EXIT.NOT_FOUND, `not found: user ${targetUser}`);
    }
    throw err;
  }
  return { stdout: JSON.stringify({ user: targetUser, op }) };
};
