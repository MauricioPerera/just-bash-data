# Command Spec — `vec`

Vector similarity store backed by `js-vector-store`. Persists under `JustBashAdapter` rooted at `PluginOptions.rootDir` (default `/data`).

## Invocation

```
vec <subcommand> [args...] [flags...]
```

Vectors are passed as JSON arrays of finite numbers. `-` reads from `ctx.stdin`.

## Global flags

stdout on `exitCode=0` is always a single JSON document. There are no global vec flags — every flag is per-subcommand.

## Subcommands

### `vec create <coll> --dim N [--quantize float32|int8|polar|binary] [--metric cosine|euclidean|dot|manhattan] [--ivf [--ivf-clusters N=100] [--ivf-probes N=10]]`
- Creates a new collection. Default: `--quantize float32 --metric cosine`.
- Optional IVF index: pass `--ivf` (or any `--ivf-*` flag implicitly enables it). `--ivf-probes` must not exceed `--ivf-clusters`.
- stdout: `{coll, dim, quantize, metric}` plus `ivf: {numClusters, numProbes}` when configured.
- After creating with `--ivf`, insert vectors and run `vec ivf build <coll>` to compute clusters before searching.
- exit: 0 | 2 (bad flags) | 5 (already exists)

### `vec store <coll> <id> <vector-json> [--meta <json>]`
- `<vector-json>` may be `-` to read from stdin. `--meta` defaults to `{}`.
- Vector length MUST equal `dim`; mismatch → exit 5.
- stdout: `{ "id": "<id>" }`
- exit: 0 | 2 | 3 | 5

### `vec store-batch <coll> <jsonl-path-or-->`
- Reads JSONL records `{ "id": "...", "vector": [...], "meta"?: {...} }` from a virtual-FS path or stdin (`-`).
- A record is **skipped** (counted in `skipped`, processing continues) when:
  - JSON parse error on that line
  - missing `id` or `vector` field
  - `vector` length ≠ `dim`
  - `vector` contains non-finite numbers
- A record is **rejected** (whole batch aborts, exit 5) when:
  - `id` collides with an existing entry in the collection
- stdout: `{ "stored": N, "skipped": M, "errors": [{"line": L, "reason": "..."}, ...] }` — `errors` truncated to first 20 entries.
- exit: 0 (even with skipped > 0) | 2 (bad path / collection arg) | 3 (collection missing) | 5 (id collision aborted batch)

### `vec search <coll> <vector-json> [--k N=10] [--metric <override>] [--matryoshka <prefix-csv>] [--no-ivf]`
- `--matryoshka 64,256,1024` runs progressive-dim filtering.
- `--no-ivf` forces brute-force scan even when an IVF index has been built. Default routing: when `entry.ivfIndex.hasIndex(coll)` is true and `--metric` is NOT overridden, search runs through IVF; otherwise brute-force.
- `--metric` and IVF are mutually exclusive — upstream IVF always uses cosine internally, so passing `--metric` falls back to brute-force.
- stdout: JSON array `[{ "id": "...", "score": N, "metadata": {...} }, ...]` sorted by `score` **descending — higher = more similar**, regardless of metric. The adapter relies on `js-vector-store#computeScore()` to normalize so that cosine/dot/euclidean/manhattan all expose `score` with this convention. If a future js-vector-store release breaks this invariant, STOP and report.
- exit: 0 | 2 | 3

### `vec search-across <coll-csv> <vector-json> [--k N=10]`
- Searches multiple collections, normalizes scores, returns merged ranking with a `coll` field per hit.
- exit: 0 | 2 | 3

### `vec get <coll> <id>`
- stdout: `{ "id": "...", "vector": [...], "metadata": {...} }`
- exit: 0 | 3

### `vec remove <coll> <id>`
- stdout: `{ "removed": "<id>" }`
- exit: 0 | 3

### `vec stats <coll>`
- stdout: `{ "dim": N, "count": N, "quantize": "...", "metric": "...", "sizeBytes": N, "binBytes": N, "metaBytes": N [, "ivf": {...} ] [, "corrupted": true ] }`
- `binBytes` is the raw vector blob; `metaBytes` is the manifest JSON; `sizeBytes` is their sum.
- For the same `dim` and `count`, expect `binBytes` to scale ≈ float32 (1×) > int8 (≈¼) > polar (≈3/32) > binary (≈1/32).
- `ivf: { built, numClusters, numProbes }` appears only when the collection was created with IVF flags (v0.5.0+).
- `corrupted: true` appears when encryption is on AND the bin file failed to decrypt during preload — distinguishes "wrong key / tampered file" from "legit empty collection" (v1.0.1+).
- exit: 0 | 3

### `vec export <coll>`
- Returns all vectors and metadata as a JSON array.
- stdout: `{ "exported": N, "records": [{ "id", "vector", "metadata" }, ...] }`
- exit: 0 | 3

### `vec import <coll> <jsonl-path-or-->`
- Imports an array of records previously produced by `export`. `<jsonl-path-or-->` is either a virtual-FS path or `-` to read the JSON array from stdin.
- Each record is validated: `id: string`, `vector: number[]` of length `dim`, all finite. v1.0.1+ rejects malformed records with `validation: import record at index N: <reason>` (exit 5) instead of letting upstream throw an opaque error.
- stdout: `{ "imported": N }`
- exit: 0 | 2 (bad path / cannot read) | 3 (collection missing) | 5 (invalid record / malformed JSON)

### `vec drop <coll>`
- Removes the collection's data and config.
- stdout: `{ "dropped": "<coll>" }`
- exit: 0 | 3

### `vec ivf build <coll> [--sample-dims N]`
- Trains the IVF k-means centroids over the collection's vectors. One-time op; persists `<coll>.ivf.json`.
- `--sample-dims` defaults to `min(128, dim)`.
- stdout: `{ "coll": "<coll>", ...buildResult }` (upstream return shape)
- exit: 0 | 2 (collection has no IVF config) | 3 (collection missing) | 5 (collection empty)

### `vec ivf stats <coll>`
- stdout: `{ "coll": "<coll>", "numClusters": N, "numProbes": N, "numVectors": N, ... }`
- exit: 0 | 2 (no IVF config) | 3 (index not built yet)

### `vec ivf drop <coll>`
- Removes the IVF index. The collection itself survives.
- stdout: `{ "dropped": "<coll>" }`
- exit: 0 | 2 (no IVF config) | 3 (index not built)

## Stderr conventions

- exit 2: `usage: vec <subcommand> [...]\n<hint>` or `invalid vector: expected number[] of length <dim>`
- exit 3: `not found: <coll>` or `not found: <coll>/<id>`
- exit 5: `validation: dim mismatch (got N, expected M)` / `validation: collection exists: <coll>` / `validation: cannot quantize: <reason>`

## Permissive-parsing layers

The same v1.0.0 stable contract applies as for `db` (see `cmd-db.md` § Permissive-parsing layers): collection name validation (v1.0.1+) and dot-syntax sentinels (v0.7.0+) cover `vec` too. Lenient JSON / operator validation are not relevant to `vec` because vec arguments are vectors (number arrays) and per-flag values, not Mongo-style filter trees.

## Performance notes (informational, not enforced by tests)

- `vec store` for float32 with no IVF is O(1) write, O(N) on first search after writes.
- `vec search` with IVF scans `numProbes` clusters out of `numClusters` (set at create time, not search time).
- Quantization is one-shot at insert time; changing `--quantize` requires `drop` + `create` + reinsert.

## Examples

```bash
# Create + bulk index + search
vec create docs --dim 1536 --quantize int8 --ivf-clusters 64
cat embeddings.jsonl | vec store-batch docs -
vec ivf build docs                                  # one-time k-means
EMB=$(curl -s api.../embeddings -d "{\"input\":\"$Q\"}" | jq '.data[0].embedding')
vec search docs "$EMB" --k 5 | jq '.[] | {id, score}'

# Cross-collection RAG
vec search-across "docs,faq,tickets" "$EMB" --k 3

# Backup + restore (canonical migration path between quantizations)
vec export docs > docs.json
vec drop docs
vec create docs --dim 1536 --quantize float32   # change quantize
jq -c '.records' docs.json | vec import docs -
```
