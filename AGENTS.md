# Agent reference: `db` and `vec` commands

This file is written for an LLM agent operating *inside* a `just-bash` shell that has the `just-bash-data` plugin loaded. It is not a tutorial — it is the minimal set of facts you need to use the commands accurately.

## Calling convention

Both commands write JSON to stdout on success and plain text to stderr on failure. Exit codes are uniform:

```
0  success      → stdout is JSON
2  bad args     → stderr starts with "usage:"
3  not found    → stderr "not found: <thing>"
4  auth error   → stderr "auth: <reason>"
5  validation   → stderr "validation: <reason>"
1  runtime      → stderr is the underlying error message
```

You can dispatch on `$?` directly:

```bash
out=$(db users find '{"_id":"abc"}' 2>/dev/null)
case $? in
  0) echo "$out" | jq '.[0]' ;;
  3) echo "collection missing, creating" ; db users insert '...' ;;
  *) echo "unexpected: $out" >&2 ;;
esac
```

JSON arguments may be `-` to read from stdin:

```bash
echo '{"name":"Alice"}' | db users insert -
```

Only **one** `-` per invocation.

## `db`

### Inserting

```bash
db <coll> insert <json>
```

The collection is created on first insert. `_id` is auto-generated unless you supply one.

### Querying (`find`)

```bash
db <coll> find <filter-json> [--sort field:1|-1] [--limit N] [--skip N] [--project f1,f2]
```

Filter operators (Mongo-compatible):

```
$eq $ne $gt $gte $lt $lte
$in $nin
$exists $regex $contains $size
$and $or $not
```

Use dot notation for nested fields: `{"addr.city":"BA"}`.

`--sort` is a single field at a time (`age:-1`). `--project f1,f2` returns those keys plus `_id`. Both `--limit` and `--skip` are integers.

### Counting / updating / removing

```bash
db <coll> count <filter>                                           # → {count}
db <coll> update <filter> <update> [--many]                        # → {matched, modified}
db <coll> remove <filter> [--many]                                 # → {removed}
```

Update operators: `$set` `$unset` `$inc` `$push` `$pull` `$rename`.

`update` without `--many` modifies at most one doc (matched is 0 or 1). With `--many`, both matched and modified reflect the full set.

### Aggregation

```bash
db <coll> aggregate <pipeline-json>
```

Pipeline stages: `$match` `$lookup` `$group` `$sort` `$limit` `$skip` `$project` `$unwind`.

Group accumulators: `$count` `$sum` `$avg` `$min` `$max` `$push` `$first` `$last`.

**Counting items per group** uses `$count`. The MongoDB idiom `{"$sum": 1}` is also accepted (rewritten to `{"$count": 1}` automatically). Both forms produce the same result. `$sum` with a string operand still computes the sum of that field, e.g. `{"$sum": "$amount"}`. **Note**: `{"$sum": N}` with `N ≠ 1` is treated as `{"$count": 1}` regardless of `N` — this tool's `$count` does not support a multiplier; use `{"$sum": "$field"}` if you need weighted sums of an actual numeric field.

`$lookup` syntax:

```json
{"$lookup":{"from":"users","localField":"userId","foreignField":"_id","as":"user","single":true}}
```

`single:true` returns a one-to-one object; omit it (or `false`) for a one-to-many array.

### Mongo-style aliases (v0.3.0+)

To reduce friction with models trained on MongoDB conventions:

- **Empty string is empty filter (read-only handlers only)**: `db users find ''` and `db users count ''` are equivalent to using `'{}'`. Aggregate accepts `''` as the empty pipeline `[]` (no-op). **Destructive handlers reject `''`**: `remove`, `update`, `insert`, and `import` require explicit `'{}'` / `'[]'` to avoid silent mass-mutation if a model emits an empty arg by mistake.

- **`find` accepts an options object as second positional**: `db users find '{}' '{"sort":{"age":-1},"limit":10}'` works alongside the flag form `db users find '{}' --sort age:-1 --limit 10`. When both are present, flags win.

- **`db <coll> export` / `db <coll> import`**: dump/restore documents as a JSON array — symmetric with `vec export` / `vec import`. Useful for backup, migration between collections, or syncing test fixtures.

- **Lenient JSON fallback (v0.6.0+)**: when strict `JSON.parse` fails on a positional JSON arg, the plugin retries with a permissive parser that accepts JS-object-literal style: bareword keys (`{$gt: 1950}`), single-quoted strings (`{'a': 'b'}`), and trailing commas (`{a:1,}`). Strict JSON behavior is unchanged. String content (the actual text, e.g. `"foo: bar"`) is never modified by the relaxer. If neither strict nor lenient parsing succeeds, you still get `exit 2 invalid json: <field>`.

- **Dot-syntax sentinels (v0.7.0+)**: if you emit MongoDB-shell-style `db.books find '{}'`, bash will dispatch to the literal command `db.books` (not `db` with an arg). For ~30 common collection names the plugin pre-registers a sentinel that responds with `exit 2` and a redirect message pointing at the canonical space-separated form `db books find '{}'`. **The parenthesised form `db.books.find(...)` is rejected by bash itself before any command dispatch — it is uninterceptable.** Always use `<tool> <coll> <subcommand>` (space-separated, no dots, no parens).

- **Operator $-prefix validation (v0.8.0+, expanded in v0.8.1)**: every operator MUST be `$`-prefixed. The lenient JSON parser will happily quote bareword keys (`{gt: 1950}` → `{"gt": 1950}`), but the validator catches non-`$` operator names and rejects with **exit 5** + a "did you mean `$gt`?" hint that includes the offending path. Coverage as of v0.8.1:
  - **Filter operators** (in `find`, `count`, `update`, `remove`): `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `exists`, `regex`, `contains`, `size`, `and`, `or`, `not`
  - **Pipeline stages** (in `aggregate`): `match`, `lookup`, `group`, `sort`, `limit`, `skip`, `project`, `unwind`
  - **Group accumulators** (inside `$group`): `count`, `sum`, `avg`, `min`, `max`, `push`, `first`, `last`
  - **Update operators** (in `update`'s second arg, top-level only): `set`, `unset`, `inc`, `push`, `pull`, `rename`

  Update operator validation does NOT recurse into values, so `{"$set": {"push": "sticky"}}` (a legit field assignment) is accepted.

- **Collection name validation (v1.0.1+)**: `db <coll>` and `vec <coll>` reject names that don't match `^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$` with **exit 2**. This blocks path traversal (`db ../escape insert ...`) and accidental conflicts with internal manifest filenames. Allowed: `books`, `user_logs`, `docs-2024`, `_cache`. Rejected: `foo.bar`, `with space`, `../evil`.

### IVF index for vector search (v0.5.0+)

For collections with >10K vectors where exhaustive search becomes slow, enable IVF (Inverted File) clustering at create time:

```bash
vec create docs --dim 768 --quantize int8 --ivf-clusters 100 --ivf-probes 10
# ... insert N vectors ...
vec ivf build docs                                  # one-time k-means training
vec search docs '<embedding>' --k 5                 # auto-uses IVF
vec search docs '<embedding>' --k 5 --no-ivf        # brute-force fallback
vec ivf stats docs                                  # {numClusters, numProbes, numVectors}
vec ivf drop docs                                   # remove the index (collection survives)
```

`numProbes` is the accuracy/speed knob: smaller = faster but lower recall. Cap is `numProbes ≤ numClusters`. IVF survives plugin restarts (the centroids file `<coll>.ivf.json` rehydrates automatically). When `vec search` is called with an explicit `--metric` flag, IVF falls back to brute-force regardless (upstream IVF always uses cosine internally).

### Indexes

```bash
db <coll> index create <field> [--sorted] [--unique]
db <coll> index drop <field>
db <coll> index list
```

Sorted indexes accelerate `--sort` and range filters. Unique indexes throw exit 5 on collision (and on `--unique` creation if duplicates already exist).

### Drop / stats

```bash
db <coll> drop                # admin role required when auth is configured
db <coll> stats               # → {count, indexes, sizeBytes}
```

### Auth

When the operator configured `authSecret`, mutations require a JWT.

```bash
db auth register <email> <pass> [--roles=admin,editor]
db auth login    <email> <pass>                       # → {token, expiresAt}
db auth verify   [--token=<jwt>]                      # → {user, roles, expiresAt}
db auth logout   [--token=<jwt>] [--all]
db auth role assign <user-id> <role> [--token=<jwt>]  # admin only
db auth role remove <user-id> <role> [--token=<jwt>]
```

Token resolution: `--token=` flag wins, then `$AUTH_TOKEN`. Idiomatic flow:

```bash
export AUTH_TOKEN=$(db auth login user@x.com pass | jq -r '.token')
db users insert '{"x":1}'           # picks up $AUTH_TOKEN automatically
```

Auth-required ops (need a valid token when `authSecret` is set): `insert`, `update`, `remove`, `import`, `drop`, `index create`, `index drop`, `auth role assign`, `auth role remove`. Public ops (no token needed): `find`, `count`, `aggregate`, `stats`, `export`, `index list`, `auth verify`, `auth login`, `auth register`, `auth logout`. `drop` and `auth role assign|remove` additionally require the `admin` role.

## `vec`

### Creating

```bash
vec create <coll> --dim N [--quantize float32|int8|polar|binary] [--metric cosine|euclidean|dot|manhattan]
```

`--dim` is capped at 65536. Quantization is fixed at create time.

### Storing

```bash
vec store       <coll> <id> <vector-json> [--meta <json>]
vec store-batch <coll> <jsonl-path-or-->
```

Vector JSON is `[n, n, n, ...]` of length `dim`. Non-finite numbers (NaN/Infinity) are rejected.

For batch ingestion, JSONL records are `{"id":"...","vector":[...],"meta":{...}}` (meta optional). Bad lines are *skipped* (counted in `skipped`, with first 20 reasons in `errors[]`); a duplicate id *aborts* the batch with exit 5.

### Searching

```bash
vec search        <coll> <vector-json> [--k N=10] [--metric M] [--matryoshka 64,256,1024]
vec search-across <coll-csv> <vector-json> [--k N]
```

Both return arrays sorted by `score` descending. **Higher score = more similar regardless of metric** — the plugin normalizes via upstream `computeScore()`.

`--matryoshka 64,256,1024` runs progressive-dim filtering for faster pruning on large dims.

`search-across` returns hits with an extra `coll` field per result.

### Other ops

```bash
vec get    <coll> <id>                           # → {id, vector, metadata}
vec remove <coll> <id>                           # → {removed}
vec stats  <coll>                                # → {dim, count, quantize, metric, sizeBytes, binBytes, metaBytes [, ivf, corrupted]}
vec verify <coll>                                # → {coll, ok, encrypted, binFile [, reason]}  (v1.1.0+)
vec export <coll>                                # → {exported, records}
vec import <coll> <json-path-or-->               # array of {id, vector, metadata?}
vec drop   <coll>
```

`export` + `drop` + `create` + `import` is the canonical way to migrate between quantizations or fix a corrupt collection.

## Common pipelines

### Standard RAG

```bash
EMB=$(curl -s "$EMB_API" -d "{\"input\":\"$Q\"}" | jq '.data[0].embedding')
vec search docs "$EMB" --k 5 | jq -r '.[].id' \
  | xargs -I{} db chunks find "{\"_id\":\"{}\"}" \
  | jq '{title, body}'
```

### Authenticated write fan-out

```bash
export AUTH_TOKEN=$(db auth login alice s3cret | jq -r '.token')
for i in {1..10}; do
  db jobs insert "{\"n\":$i,\"status\":\"open\"}"
done
db jobs find '{"status":"open"}' | jq 'length'
```

### Tag-based hybrid search

```bash
# Vector recall stage
ids=$(vec search docs "$EMB" --k 50 | jq -r '.[].id' | tr '\n' ',')
# Metadata filter stage
db chunks find "{\"_id\":{\"\$in\":[$ids]},\"tag\":\"public\"}" | jq -r '.[].body'
```

## Failure recovery

- **`vec verify <coll>` (v1.1.0+)**: explicit corruption check. Returns `{ok: true}` for healthy collections, `{ok: false, reason: "decrypt failed..."}` for wrong-key / tampered / truncated. Always exit 0 — the truth is in the JSON. Use this proactively before `search` if you're unsure whether the encryption config is correct.

- **Exit 4 "missing token"**: log in with `db auth login` and export `$AUTH_TOKEN`.
- **Exit 4 "expired token"**: same — re-login.
- **Exit 4 "role required: admin"**: ask the operator (RBAC is configured at plugin init, not from the shell).
- **Exit 5 "unique constraint"**: the document violates an existing unique index; query first, modify the conflicting field, retry.
- **Exit 5 "dim mismatch"**: your embedding length doesn't match `vec stats <coll> | jq .dim`. Recompute with the right model.
- **Exit 5 "collection exists"**: use a different name or `vec drop <coll>` first.
- **Exit 3**: the collection or id doesn't exist. `db <coll> stats` / `vec stats <coll>` report 3 if missing — useful as an existence probe.

## What you cannot do

- **`db.<coll>.<method>(...)` parens form** — bash parse error before any command dispatch. Use the space-separated form `db <coll> <method>`.
- **`db <coll> aggregate '<filter>' '<accumulator>'`** (two JSON args instead of a pipeline array) — structurally ambiguous, no alias provided. Use `db <coll> aggregate '[{"$match": <filter>}, {"$group": <accumulator-spec>}]'`.
- **Change a vector collection's `dim` or `quantize`** in place — requires `drop` + `create` + reinsert. (`vec export` to capture data first.)
- **IVF + custom `--metric`** — upstream IVF always runs cosine internally; passing `--metric` to `vec search` triggers brute-force fallback.
- **Cross-shell concurrent writes** — each `Bash` instance gets its own state per `IFileSystem`. Two `Bash` instances over the *same* `IFileSystem` share state (via `WeakMap`-cached `PluginRegistry`).
- **Stream large blob outputs** — every command's stdout is a single buffered JSON document.
- **A field literally named after a Mongo operator (`gt`, `set`, `or`, …) at the top level of a filter** — the v0.8.x validator flags it as missing-`$`. Workaround: wrap the value in `{"$eq": ...}` so the operator name appears in a position the validator doesn't inspect, or rename the field.
