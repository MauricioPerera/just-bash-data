export const EXIT = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  VALIDATION: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CommandError extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

export const isCommandError = (e: unknown): e is CommandError =>
  e instanceof CommandError;

/**
 * Allowed collection-name shape. Conservative regex to prevent path traversal
 * and accidental conflicts with internal manifest filenames (which start with
 * '_' and may contain dots).
 *
 *  - First char: ASCII letter, digit, or underscore.
 *  - Subsequent: same plus hyphen.
 *  - Length cap: 64.
 *
 * NO dots, slashes, backslashes, spaces, or '..' sequences. This means that
 * `db ../escape insert ...` (which would resolve to a path outside rootDir)
 * never reaches the persister: the dispatcher rejects it with exit 2.
 *
 * Internal names like `_users`, `_sessions`, `_vec.registry.json` are written
 * by the plugin itself with hardcoded constants — they bypass this check.
 * User-facing handlers always validate.
 */
const COLL_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;

export const validateCollName = (name: string): void => {
  if (!COLL_NAME_RE.test(name)) {
    throw new CommandError(
      EXIT.USAGE,
      `invalid collection name: '${name}' — allowed: ^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}\$ (no dots, slashes, or path components)`,
    );
  }
};
