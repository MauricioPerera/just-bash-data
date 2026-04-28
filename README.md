# `just-bash-data`

[![npm](https://img.shields.io/npm/v/just-bash-data.svg)](https://www.npmjs.com/package/just-bash-data)
[![CI](https://github.com/MauricioPerera/just-bash-data/actions/workflows/ci.yml/badge.svg)](https://github.com/MauricioPerera/just-bash-data/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CHANGELOG](https://img.shields.io/badge/CHANGELOG-md-blue.svg)](CHANGELOG.md)

A plugin for [`just-bash`](https://github.com/vercel-labs/just-bash) that gives an in-shell agent two structured-data commands:

- **`db`** — MongoDB-style document store backed by [`js-doc-store`](https://github.com/MauricioPerera/js-doc-store): CRUD, indexes, aggregations, JWT auth, RBAC, optional AES-256-GCM encryption.
- **`vec`** — vector similarity search backed by [`js-vector-store`](https://github.com/MauricioPerera/js-vector-store): float32 + 3 quantizations, IVF, matryoshka, cross-collection search.

Both share a single in-memory state hydrated from `IFileSystem` on first use and atomically flushed back after every mutating command.

> **Sister project**: [`agent-skills`](https://github.com/MauricioPerera/agent-skills) is an open specification for distributing tools to LLM agents (an alternative to MCP) that uses `just-bash-data` as its reference runtime. The spec defines the format and protocol; this package provides the storage + retrieval primitives a conformant skill bank needs. See [agent-skills/IMPLEMENTATION.md](https://github.com/MauricioPerera/agent-skills/blob/main/IMPLEMENTATION.md) for how to build a skill bank atop just-bash-data.

> **Benchmark**: 8 Cloudflare Workers AI models (Granite 4.0, Llama 3.1/3.2 8B family, Llama 4 Scout MoE, GPT-OSS-20B, Gemma 4 26B) tested as agents driving the `db` command. **Granite wins on cost** ($0.000107/task, 7/7 completion). **GPT-OSS-20B wins on turns** (2 turns to DONE, 92% precision). **Gemma 4 wins on precision** (100%, zero retries, 16× the cost). Permissive-parsing aliases (v0.2.0 → v0.3.1) cut total cost by **41%** vs v0.1.0 with zero breaking changes. v0.6.0–v0.8.1 added lenient JSON parsing + operator `$`-prefix validation, taking the agent-trace replay to **103/107 commands exit 0 (96.3%)** with zero regressions across all 8 models — full v0.8.1 retest report at [examples/smoke/v8-benchmark-report.md](examples/smoke/v8-benchmark-report.md). Original cost analysis: [examples/smoke/BENCHMARK.md](examples/smoke/BENCHMARK.md).

## Install

```bash
npm i just-bash-data just-bash
# or pin to a specific version
npm i just-bash-data@1.1.0 just-bash
```

The plugin pulls its two upstream libs (`js-doc-store`, `js-vector-store`) directly from GitHub at install time — neither is published to npm. `npm` / `pnpm` / `yarn` all handle this transparently.

If you need a specific commit or branch instead of the published release:

```bash
npm i github:MauricioPerera/just-bash-data#v1.1.0 just-bash
```

## Quick start

```typescript
import { Bash, InMemoryFs } from "just-bash";
import { createDataPlugin } from "just-bash-data";

const bash = new Bash({
  fs: new InMemoryFs({}),
  customCommands: createDataPlugin({
    authSecret: "jwt-signing-secret",   // optional: enables RBAC
    encryptionKey: "aes-key",           // optional: AES-256-GCM at rest
    rootDir: "/data",                   // optional: default "/data"
  }),
});

await bash.exec(`db users insert '{"name":"Alice","age":30}'`);
await bash.exec(`db users find '{"age":{"$gte":18}}' --sort age:-1`);

await bash.exec(`vec create docs --dim 1536 --quantize int8`);
await bash.exec(`vec store docs doc-1 '${JSON.stringify(embedding)}'`);
await bash.exec(`vec search docs '${JSON.stringify(query)}' --k 5`);
```

`createDataPlugin` returns a `CustomCommand[]` ready to plug into `Bash`. Each call gets its own state, scoped to the `IFileSystem` instance it sees at runtime — multiple `Bash` instances do not share data unless they share an `IFileSystem`.

## Architecture

The two upstream libraries call their adapters synchronously, while just-bash `IFileSystem` is fully async. Three thin layers bridge them:

```
            IFileSystem  (async)
                 ↑ ↓     Persister    hydrate / flush
            MemoryAdapter  (sync, Map-backed)
                 ↑        EncryptedAdapter (json) / EncryptedBinAdapter (bin)  ← optional
       DocStore / VectorStore  (sync clients)
```

- The `MemoryAdapter` is the single source of truth at runtime. Reads and writes are O(1).
- The `Persister` hydrates the adapter from `<root>/` lazily on first command, then flushes dirty entries atomically (`<name>.tmp` + `fs.mv`) after every mutating command.
- Encryption is an optional sandwich: `EncryptedAdapter` (from upstream) wraps JSON; a small internal `EncryptedBinAdapter` mirrors the same pattern for binary blobs (vector files).
- A `PluginRegistry` is cached per `IFileSystem` instance via `WeakMap`, so different `Bash` instances get isolated state automatically.

Concurrent `flush` calls are serialized: each call appends a `doFlush` to a chain so its `takeDirty()` runs after all earlier flushes complete. Failures don't poison the chain.

## `db` command

```
db <coll|auth> <subcommand> [args...] [flags...]
```

### Document operations

| Subcommand | Effect |
|---|---|
| `db <coll> insert <json>` | Insert one doc. Generates `_id` if missing. Returns `{_id}`. |
| `db <coll> find <filter> [--sort f:1\|-1] [--limit N] [--skip N] [--project f1,f2]` | Mongo-style query. Returns `Doc[]`. |
| `db <coll> count <filter>` | Returns `{count}`. |
| `db <coll> update <filter> <update> [--many]` | Returns `{matched, modified}` (matched is capped at 1 in single mode). |
| `db <coll> remove <filter> [--many]` | Returns `{removed}`. |
| `db <coll> aggregate <pipeline>` | Pipeline: `$match`/`$lookup`/`$group`/`$sort`/`$limit`/`$skip`/`$project`/`$unwind`. Accumulators: `$count`/`$sum`/`$avg`/`$min`/`$max`/`$push`/`$first`/`$last`. |
| `db <coll> drop` | Removes the collection. **Requires `admin` role** when auth is configured. |
| `db <coll> stats` | Returns `{count, indexes, sizeBytes}`. |

Any positional JSON argument can be `-` to read from stdin: `echo '{"a":1}' \| db users insert -` (only one `-` per invocation).

### Indexes

```bash
db <coll> index create <field> [--sorted] [--unique]
db <coll> index drop <field>
db <coll> index list
```

- Default is a hash index. `--sorted` creates a sorted index for range queries.
- `--unique` adds a uniqueness constraint. Insert/update collisions exit with `5`.

### Query operators (all upstream)

`$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$exists` `$regex` `$contains` `$size` `$and` `$or` `$not` — plus dot notation for nested fields (`addr.city`).

### Update operators

`$set` `$unset` `$inc` `$push` `$pull` `$rename`.

### Auth

Set `PluginOptions.authSecret` to enable JWT + RBAC. When unset, the entire auth surface is a no-op (every command is public).

```bash
db auth register <email> <pass> [--roles=role1,role2]
db auth login    <email> <pass>                       # → {token, expiresAt}
db auth verify   [--token=<jwt>]                      # → {user, roles, expiresAt}
db auth logout   [--token=<jwt>] [--all]
db auth role assign <user-id> <role> [--token=<jwt>]  # admin only
db auth role remove <user-id> <role> [--token=<jwt>]
```

The token is read from `--token=<jwt>` first, falling back to `ctx.env.AUTH_TOKEN`. Use `--token` in tests; use the env var in real shell pipelines.

When `authSecret` is set, these operations require a valid JWT:

`insert`, `update`, `remove`, `drop`, `index create`, `index drop`, `auth role assign`, `auth role remove`.

These remain public:

`find`, `count`, `aggregate`, `stats`, `index list`, `auth verify`, `auth login`, `auth register`, `auth logout`.

`drop`, `auth role assign`, and `auth role remove` additionally require the `admin` role.

## `vec` command

```
vec <subcommand> [args...] [flags...]
```

| Subcommand | Effect |
|---|---|
| `vec create <coll> --dim N [--quantize float32\|int8\|polar\|binary] [--metric cosine\|euclidean\|dot\|manhattan]` | Creates a collection. `--dim` capped at 65536. |
| `vec store <coll> <id> <vector-json> [--meta <json>]` | Single vector. JSON arg may be `-` for stdin. |
| `vec store-batch <coll> <jsonl-path-or-->` | One JSONL record per line `{id, vector, meta?}`. Reports `{stored, skipped, errors[]}`. ID collisions abort the batch with exit 5. |
| `vec search <coll> <vector-json> [--k N=10] [--metric M] [--matryoshka 64,256,1024]` | Returns `[{id, score, metadata?}, ...]` sorted by score desc (higher = more similar, regardless of metric). |
| `vec search-across <coll-csv> <vector-json> [--k N]` | Merges per-collection search results, returns `[{id, score, coll, metadata?}, ...]`. |
| `vec get <coll> <id>` | Returns `{id, vector, metadata}`. |
| `vec remove <coll> <id>` | Returns `{removed}`. |
| `vec stats <coll>` | Returns `{dim, count, quantize, metric}`. |
| `vec export <coll>` | Returns `{exported, records}`. |
| `vec import <coll> <json-path-or-->` | Imports an array of `{id, vector, metadata?}` records. |
| `vec drop <coll>` | Removes the collection. |

### Quantization choices

| Quantize | Bits/dim | Compression vs float32 | Recall trade-off |
|---|---:|---:|---|
| `float32` | 32 | 1× | exact |
| `int8` | 8 | ~4× | ≥ 0.7 top-K overlap |
| `polar` | 3 | ~21× | rough, fast |
| `binary` | 1 | ~32× | very rough, very fast |

Quantization is per-collection and immutable. To change it: `vec drop` + `vec create` + reinsert.

## Plugin options

```typescript
type PluginOptions = {
  encryptionKey?: string;  // AES-256-GCM at rest (PBKDF2 100k iter)
  authSecret?: string;     // HMAC-SHA256 JWT signing key
  rootDir?: string;        // default: "/data"
};
```

### Encryption

When `encryptionKey` is set:

- All JSON files (including `_users.docs.json`) are encrypted via upstream `EncryptedAdapter` before reaching `IFileSystem`.
- Vector binary files are encrypted via the internal `EncryptedBinAdapter` with the same key (separate IV per write).
- A consumer with the wrong key sees empty collections — no plaintext leaks.

### Auth secret

When `authSecret` is set, JWT issuance and verification become mandatory for the auth-required operations listed above. Tokens default to 24h expiry.

### Custom root dir

The default `rootDir` is `/data` inside the virtual FS. Files written are listed below.

## Persistence layout (under `<rootDir>`)

| File | Owner |
|---|---|
| `<coll>.docs.json` | doc-store: documents |
| `<coll>.meta.json` | doc-store: index metadata |
| `<coll>.<field>.idx.json` | doc-store: hash index |
| `<coll>.<field>.sidx.json` | doc-store: sorted index |
| `<coll>.bin` / `<coll>.q8.bin` / `<coll>.b1.bin` / `<coll>.p3.bin` | vector-store: vectors per quantization |
| `<coll>.json` (and quantized variants) | vector-store: per-collection manifest |
| `_users.docs.json` | auth users |
| `_sessions.docs.json` | active JWT sessions |
| `_vec.registry.json` | per-coll vec metadata (dim, quantize, metric) |

## Exit codes (uniform across both commands)

| Code | Meaning |
|---:|---|
| `0` | success — `stdout` is JSON |
| `1` | runtime / internal error |
| `2` | usage error (bad args, malformed JSON, dim too large) |
| `3` | not found (missing collection or id) |
| `4` | auth error (missing / invalid / expired token, role required) |
| `5` | validation error (unique constraint, dim mismatch, collection exists, etc.) |

`stderr` is always plain text on non-zero exit.

## Common recipes

### RAG with external embeddings + auth

```bash
TOKEN=$(db auth login alice@x.com 's3cret123' | jq -r '.token')
EMB=$(curl -s api.openai.com/v1/embeddings \
       -H "Authorization: Bearer $OPENAI_KEY" \
       -d "{\"input\":\"$Q\",\"model\":\"text-embedding-3-small\"}" \
     | jq '.data[0].embedding')

vec search docs "$EMB" --k 5 \
  | jq -r '.[] | .id' \
  | xargs -I{} db chunks find "{\"_id\":\"{}\"}" --token="$TOKEN" \
  | jq '{title, body}'
```

### Indexed read-heavy workload

```bash
db users index create email --unique
db users index create age --sorted
db users find '{"age":{"$gte":21}}' --sort age:1 --limit 100
```

### Cross-collection semantic search

```bash
vec create faq --dim 384
vec create tickets --dim 384
vec create docs --dim 384
# … populate each …
vec search-across "faq,tickets,docs" "$EMB" --k 10
```

### Encrypted persistent state across shells

```typescript
const fs = new InMemoryFs({});
const opts = { encryptionKey: "k", authSecret: "s" };

import { createDataPlugin } from "just-bash-data";

// Shell 1
const bash1 = new Bash({ fs, customCommands: createDataPlugin(opts) });
await bash1.exec(`db notes insert '{"secret":"value"}'`);

// Shell 2 (same fs, same key) — data rehydrates and decrypts transparently
const bash2 = new Bash({ fs, customCommands: createDataPlugin(opts) });
await bash2.exec(`db notes find '{}'`);   // sees the doc
```

## Limitations / known deviations from spec

- **`searchAcross` is implemented in this plugin, not upstream.** Each `vec create` produces an independent store instance, so cross-collection search is performed by merging per-collection searches by score. Functionally equivalent for non-IVF cases.
- **`db.<coll>.<method>(...)` parens form is uninterceptable.** Bash fails with a parse error on `(` before any command dispatch happens. The space-separated `db <coll> <method>` form is the only one this plugin can serve. The dot-syntax-without-parens form (`db.<coll> <method>`) is caught by sentinels for ~30 common collection names — see v0.7.0 release notes.
- **TypeScript consumers may need `--skipLibCheck`** if the installed `just-bash@2.14.3` reproduces the upstream `.d.ts` packaging issue (publishes `.d.ts` files referencing paths not in the tarball). This plugin's own types are clean.

## Development

```bash
pnpm install
pnpm typecheck     # strict, no `any`
pnpm lint
pnpm test          # 264 unit + integration tests
pnpm build         # ESM + CJS + .d.ts via tsup
pnpm pack          # produces local-just-bash-data-0.0.0.tgz
```

A full E2E smoke lives at `examples/smoke/smoke-full.mjs` (243 assertions across every subcommand, every operator, every exit code, plus encryption + salt round-trip, IVF lifecycle, sentinels, operator validators, and `vec verify`).

```bash
pnpm install
pnpm smoke         # builds + runs the full E2E
```

## License

MIT.
