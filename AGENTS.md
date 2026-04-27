# Agent reference: `db` and `vec` commands

This file is written for an LLM agent operating *inside* a `just-bash` shell that has the `@local/just-bash-data` plugin loaded. It is not a tutorial — it is the minimal set of facts you need to use the commands accurately.

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

**Counting items per group** uses `$count`. The MongoDB idiom `{"$sum": 1}` is also accepted (rewritten to `{"$count": 1}` automatically). Both forms produce the same result. `$sum` with a string operand still computes the sum of that field, e.g. `{"$sum": "$amount"}`.

`$lookup` syntax:

```json
{"$lookup":{"from":"users","localField":"userId","foreignField":"_id","as":"user","single":true}}
```

`single:true` returns a one-to-one object; omit it (or `false`) for a one-to-many array.

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

Auth-required ops: `insert`, `update`, `remove`, `drop`, `index create`, `index drop`, `auth role assign`, `auth role remove`. Everything else (find, count, aggregate, login, register, verify, logout) is public even when auth is on.

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
vec stats  <coll>                                # → {dim, count, quantize, metric}
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

- **Exit 4 "missing token"**: log in with `db auth login` and export `$AUTH_TOKEN`.
- **Exit 4 "expired token"**: same — re-login.
- **Exit 4 "role required: admin"**: ask the operator (RBAC is configured at plugin init, not from the shell).
- **Exit 5 "unique constraint"**: the document violates an existing unique index; query first, modify the conflicting field, retry.
- **Exit 5 "dim mismatch"**: your embedding length doesn't match `vec stats <coll> | jq .dim`. Recompute with the right model.
- **Exit 5 "collection exists"**: use a different name or `vec drop <coll>` first.
- **Exit 3**: the collection or id doesn't exist. `db <coll> stats` / `vec stats <coll>` report 3 if missing — useful as an existence probe.

## What you cannot do (yet)

- IVF tuning via flags (the upstream class exists but isn't wired in).
- Change a vector collection's `dim` or `quantize` without `drop` + `create` + reinsert.
- Cross-shell concurrent writes — each `Bash` instance gets its own state per `IFileSystem`.
- Stream large blob outputs — every command's stdout is a single buffered JSON document.
