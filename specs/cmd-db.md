# Command Spec — `db`

Document store backed by `js-doc-store`. Persists under `JustBashAdapter` rooted at `PluginOptions.rootDir` (default `/data`).

## Invocation

```
db <subcommand> [args...] [flags...]
```

Auth token, when required, is read from `ctx.env.get("AUTH_TOKEN")` or the flag `--token=<jwt>`. The flag wins. `ctx.env` is a `Map<string, string>` (per just-bash `CommandContext`), not a plain object.

## Global flags

| flag | meaning |
|------|---------|
| `--token=<jwt>` | auth token override (wins over `ctx.env.AUTH_TOKEN`) |
| `--root=<path>` | overrides `PluginOptions.rootDir` for this invocation only; new collections under the override go to a separate registry slot |
| `--json` | force machine-readable stdout (default for exitCode=0) |

## Auth model

- **Auth required** (`authSecret` set + valid token mandatory): `insert`, `update`, `remove`, `drop`, `index create`, `index drop`, `auth role assign`, `auth role remove`.
- **Role required** (`admin` role on the resolved token): `drop`, `auth role assign`, `auth role remove`.
- **Public** (no token needed even when `authSecret` is set): `find`, `count`, `aggregate`, `stats`, `index list`, `auth verify`, `auth login`, `auth register`, `auth logout` (logout still requires the token of the session being closed).
- "RBAC active" means `authSecret` is configured. Role checks fire only on the subcommands listed above.

## Subcommands

### `db <coll> insert <json>`
- Inserts one document. Generates `_id` if absent (`crypto.randomUUID()`).
- Auth: if `authSecret` configured, writes require valid token.
- stdout: `{ "_id": "<id>" }`
- exit: 0 ok | 2 bad json | 4 auth | 5 schema/index violation

### `db <coll> find <query-json> [--sort <field>:<1|-1>] [--limit N] [--skip N] [--project <fields-csv>]`
- Mongo-style query operators per js-doc-store.
- stdout: JSON array of matched docs.
- exit: 0 ok | 2 bad query json | 3 collection missing

### `db <coll> count <query-json>`
- stdout: `{ "count": N }`
- exit: 0 | 2 | 3

### `db <coll> update <query-json> <update-json> [--many]`
- Default updates first match. `--many` updates all matches.
- stdout: `{ "matched": N, "modified": M }`
- exit: 0 | 2 | 4 | 5

### `db <coll> remove <query-json> [--many]`
- stdout: `{ "removed": N }`
- exit: 0 | 2 | 4

### `db <coll> aggregate <pipeline-json>`
- stdout: JSON array.
- exit: 0 | 2 | 3

### `db <coll> index create <field> [--sorted] [--unique]`
- Default: hash index. `--sorted` creates sorted index. `--unique` adds uniqueness constraint.
- stdout: `{ "created": "<field>", "type": "hash"|"sorted" }`
- exit: 0 | 2 | 5 (duplicate violation)

### `db <coll> index drop <field>`
- stdout: `{ "dropped": "<field>" }`
- exit: 0 | 3

### `db <coll> index list`
- stdout: `[{ "field": "...", "type": "...", "unique": bool }]`
- exit: 0 | 3

### `db <coll> drop`
- Removes the collection and all its files.
- Auth: requires valid token AND `admin` role.
- stdout: `{ "dropped": "<coll>" }`
- exit: 0 | 3 | 4

### `db <coll> stats`
- stdout: `{ "count": N, "indexes": [...], "sizeBytes": N }`
- exit: 0 | 3

### Auth subcommands

#### `db auth register <user> <pass> [--roles=admin,editor]`
- stdout: `{ "user": "<user>", "id": "<id>" }`
- exit: 0 | 2 | 5 (duplicate user)

#### `db auth login <user> <pass>`
- stdout: `{ "token": "<jwt>", "expiresAt": "<iso>" }`
- exit: 0 | 2 | 4

#### `db auth verify [--token=<jwt>]`
- Token from flag or `ctx.env.AUTH_TOKEN`.
- stdout: `{ "user": "...", "roles": [...], "expiresAt": "<iso>" }`
- exit: 0 | 4

#### `db auth logout [--token=<jwt>] [--all]`
- `--all` invalidates every session for the user.
- stdout: `{ "loggedOut": true }`
- exit: 0 | 4

#### `db auth role assign <user> <role>` / `db auth role remove <user> <role>`
- Requires admin token.
- stdout: `{ "user": "...", "roles": [...] }`
- exit: 0 | 4 | 3

## stdin behavior

For `insert`, `update`, `aggregate`, `find`: if **exactly one** JSON positional arg is `-`, that one is read from `ctx.stdin`. Two `-` in the same invocation (e.g., `db users update - -`) is a usage error (exit 2): `usage: only one positional may read from stdin`.

## Stderr conventions

- Usage error (exit 2): `usage: db <coll> <subcommand> [...]\n<short hint>`
- Auth error (exit 4): `auth: <reason>` where reason ∈ `{ "missing token", "invalid token", "expired token", "role required: <role>" }`
- Validation (exit 5): `validation: <field> <reason>`
- Not found (exit 3): `not found: <coll>` or `not found: index <field>`

## Examples

```bash
# Insert + index + query
db users insert '{"name":"Alice","age":30}'
db users index create age --sorted
db users find '{"age":{"$gte":18}}' --sort age:-1 --limit 10

# Aggregation
db orders aggregate '[
  {"$match":{"status":"paid"}},
  {"$lookup":{"from":"users","localField":"userId","foreignField":"_id","as":"user","single":true}},
  {"$group":{"_id":"$user.country","total":{"$sum":"$amount"}}}
]'

# Auth flow
TOKEN=$(db auth login alice s3cret | jq -r '.token')
db users remove '{"name":"Bob"}' --token="$TOKEN"
```
