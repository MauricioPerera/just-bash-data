import type { CommandContext } from "just-bash";
import { CommandError, EXIT } from "../../lib/errors.js";
import { flagString, type ParsedArgs } from "../../lib/args.js";
import type { PluginRegistry } from "../../registry.js";

/**
 * Per-handler policy for the empty-string alias `''`:
 * - "filter": treat `''` as `{}` (match-all). Read-only handlers (find/count) opt in.
 * - "pipeline": treat `''` as `[]` (no-op pipeline). Aggregate handler opts in.
 * - "reject" (default): refuse empty input. Used by destructive handlers
 *   (remove/update) and content handlers (insert/import) where `''` is
 *   ambiguous and likely a syntax error.
 */
export type EmptyPolicy = "filter" | "pipeline" | "reject";

/**
 * Relaxes JS-object-literal style input into valid JSON. Handles three patterns
 * common in LLM emissions but invalid in strict JSON:
 *  - Bareword keys:        `{$gt: 1950}` → `{"$gt": 1950}`
 *  - Single-quoted strings: `{'name': 'Alice'}` → `{"name": "Alice"}`
 *  - Trailing commas:       `{a:1,}` and `[1,2,]` → `{a:1}` / `[1,2]`
 *
 * Walks char-by-char and only transforms tokens OUTSIDE string literals, so
 * a value like `{"x": "key: value"}` survives untouched.
 *
 * Tries to be a no-op on valid JSON. Used as a fallback when JSON.parse fails;
 * never the primary path.
 */
export const relaxJson = (input: string): string => {
  const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
  const isIdCont = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  let out = "";
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    // Double-quoted string: copy verbatim through to closing quote, respecting escapes.
    if (c === '"') {
      out += c;
      i++;
      while (i < input.length) {
        const ch = input[i] as string;
        out += ch;
        if (ch === "\\" && i + 1 < input.length) {
          out += input[i + 1] as string;
          i += 2;
          continue;
        }
        i++;
        if (ch === '"') break;
      }
      continue;
    }
    // Single-quoted string: rewrite as double-quoted, escaping inner `"` as needed.
    if (c === "'") {
      out += '"';
      i++;
      while (i < input.length && input[i] !== "'") {
        const ch = input[i] as string;
        if (ch === "\\" && i + 1 < input.length) {
          // Preserve escapes; convert \' to literal ' (no longer needs escaping inside ").
          const next = input[i + 1] as string;
          if (next === "'") {
            out += "'";
          } else {
            out += "\\" + next;
          }
          i += 2;
          continue;
        }
        if (ch === '"') {
          out += '\\"';
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      out += '"';
      i++; // skip closing single quote (or end of input)
      continue;
    }
    // Bareword identifier: quote it if followed (after whitespace) by `:`.
    if (isIdStart(c)) {
      const start = i;
      while (i < input.length && isIdCont(input[i] as string)) i++;
      const word = input.slice(start, i);
      let j = i;
      while (j < input.length && isWs(input[j] as string)) j++;
      // Quote only when serving as an object key. Leave true/false/null/value literals alone.
      if (input[j] === ":" && word !== "true" && word !== "false" && word !== "null") {
        out += `"${word}"`;
      } else {
        out += word;
      }
      continue;
    }
    // Trailing comma before `}` or `]`: drop it.
    if (c === ",") {
      let j = i + 1;
      while (j < input.length && isWs(input[j] as string)) j++;
      const next = input[j];
      if (next === "}" || next === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
};

/**
 * Mongo filter operators. If any of these names appears as an object key
 * WITHOUT a `$` prefix anywhere in a parsed filter, it is almost certainly
 * a missing-`$` typo by the model rather than a legitimate field named `gt`.
 *
 * v0.6.0's lenient JSON parser turns `{gt: 1950}` into `{"gt": 1950}` — valid
 * JSON, but `gt` (no `$`) is not a recognized operator, so the doc-store
 * silently mismatches and returns docs the agent did NOT ask for. v0.8.0
 * restores the loud-failure property: we walk the parsed filter and reject
 * with a clear "did you mean $gt?" message when bareword operators are seen.
 *
 * Set covers the operators documented in AGENTS.md `db find` filter syntax:
 * comparison, membership, existence, regex, contains, size, plus the
 * top-level logical combinators.
 */
const FILTER_OPERATOR_NAMES: ReadonlySet<string> = new Set([
  "eq", "ne", "gt", "gte", "lt", "lte",
  "in", "nin",
  "exists", "regex", "contains", "size",
  "and", "or", "not",
]);

/**
 * Walks a parsed filter value and throws if a non-`$`-prefixed operator name
 * appears as an object key. Recurses through arrays and nested objects so
 * `{$or: [{a: 1}, {b: {gt: 5}}]}` is caught at the inner `gt`.
 *
 * False-positive risk: a user with a legitimate field literally named `gt`
 * in their data. Rare, and the error message is explicit enough to recover
 * (rename the field or quote it inside `$eq`).
 */
export const validateFilterOperators = (
  value: unknown,
  fieldName: string,
  path: string = "",
): void => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateFilterOperators(value[i], fieldName, `${path}[${i}]`);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!k.startsWith("$") && FILTER_OPERATOR_NAMES.has(k)) {
      const here = path ? `${path}.${k}` : k;
      throw new CommandError(
        EXIT.VALIDATION,
        `validation: ${fieldName} operator '${k}' at ${here} is missing $ prefix — did you mean '$${k}'?`,
      );
    }
    validateFilterOperators(v, fieldName, path ? `${path}.${k}` : k);
  }
};

export const parseJson = (
  arg: string | undefined,
  ctx: CommandContext,
  fieldName: string,
  emptyPolicy: EmptyPolicy = "reject",
  validateFilter: boolean = false,
): unknown => {
  if (arg === undefined) {
    throw new CommandError(EXIT.USAGE, `missing ${fieldName} argument`);
  }
  const text = arg === "-" ? ctx.stdin : arg;
  if (text.trim() === "") {
    if (emptyPolicy === "filter") return {};
    if (emptyPolicy === "pipeline") return [];
    throw new CommandError(
      EXIT.USAGE,
      `${fieldName} cannot be empty (use '{}' explicitly if you mean an empty object)`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Fallback: try the lenient (JS-literal-style) parser. Covers bareword keys,
    // single-quoted strings, and trailing commas — the most common patterns
    // LLM agents emit instead of strict JSON.
    try {
      value = JSON.parse(relaxJson(text));
    } catch {
      throw new CommandError(EXIT.USAGE, `invalid json: ${fieldName}`);
    }
  }
  if (validateFilter) {
    validateFilterOperators(value, fieldName);
  }
  return value;
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
