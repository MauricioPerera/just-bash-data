# Command Spec — `vec`

Vector similarity store backed by `js-vector-store`. Persists under `JustBashAdapter` rooted at `PluginOptions.rootDir` (default `/data`).

## Invocation

```
vec <subcommand> [args...] [flags...]
```

Vectors are passed as JSON arrays of finite numbers. `-` reads from `ctx.stdin`.

## Global flags

| flag | meaning |
|------|---------|
| `--root=<path>` | overrides `PluginOptions.rootDir` for this invocation only; new collections under the override go to a separate registry slot |
| `--json` | force machine-readable stdout (default for exitCode=0) |

## Subcommands

### `vec create <coll> --dim N [--quantize float32|int8|polar|binary] [--metric cosine|euclidean|dot|manhattan] [--ivf-clusters N --ivf-probe N]`
- Creates a new collection. Default: `--quantize float32 --metric cosine`. IVF index optional.
- stdout: `{ "coll": "...", "dim": N, "quantize": "...", "metric": "...", "ivf": bool }`
- exit: 0 | 2 | 5 (already exists)

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

### `vec search <coll> <vector-json> [--k N=10] [--probe N] [--metric <override>] [--matryoshka <prefix-csv>]`
- `--matryoshka 64,256,1024` runs progressive-dim filtering.
- stdout: JSON array `[{ "id": "...", "score": N, "meta": {...} }, ...]` sorted by `score` **descending — higher = more similar**, regardless of metric. The adapter relies on `js-vector-store#computeScore()` to normalize so that cosine/dot/euclidean/manhattan all expose `score` with this convention. If a future js-vector-store release breaks this invariant, STOP and report.
- exit: 0 | 2 | 3

### `vec search-across <coll-csv> <vector-json> [--k N=10]`
- Searches multiple collections, normalizes scores, returns merged ranking with a `coll` field per hit.
- exit: 0 | 2 | 3

### `vec get <coll> <id>`
- stdout: `{ "id": "...", "vector": [...], "meta": {...} }`
- exit: 0 | 3

### `vec remove <coll> <id>`
- stdout: `{ "removed": "<id>" }`
- exit: 0 | 3

### `vec stats <coll>`
- stdout: `{ "dim": N, "count": N, "quantize": "...", "metric": "...", "sizeBytes": N, "binBytes": N, "metaBytes": N }`
- `binBytes` is the raw vector blob; `metaBytes` is the manifest JSON; `sizeBytes` is their sum.
- For the same `dim` and `count`, expect `binBytes` to scale ≈ float32 (1×) > int8 (≈¼) > polar (≈3/32) > binary (≈1/32).
- exit: 0 | 3

### `vec import <coll> <bin-path> <meta-path>`
- Imports `bin` + `meta.json` produced by `export`.
- stdout: `{ "imported": N }`
- exit: 0 | 2 | 5

### `vec export <coll> <bin-path> <meta-path>`
- Writes vectors and metadata to virtual-FS paths.
- stdout: `{ "exported": N }`
- exit: 0 | 3

### `vec drop <coll>`
- stdout: `{ "dropped": "<coll>" }`
- exit: 0 | 3

## Stderr conventions

- exit 2: `usage: vec <subcommand> [...]\n<hint>` or `invalid vector: expected number[] of length <dim>`
- exit 3: `not found: <coll>` or `not found: <coll>/<id>`
- exit 5: `validation: dim mismatch (got N, expected M)` / `validation: collection exists: <coll>` / `validation: cannot quantize: <reason>`

## Performance notes (informational, not enforced by tests)

- `vec store` for float32 with no IVF is O(1) write, O(N) on first search after writes.
- `vec search` with IVF + `--probe P` scans `P` clusters out of total clusters; `--probe` defaults to `clusters / 4`.
- Quantization is one-shot at insert time; changing `--quantize` requires `drop` + `create` + reinsert.

## Examples

```bash
# Create + bulk index + search
vec create docs --dim 1536 --quantize int8 --ivf-clusters 64
cat embeddings.jsonl | vec store-batch docs -
EMB=$(curl -s api.../embeddings -d "{\"input\":\"$Q\"}" | jq '.data[0].embedding')
vec search docs "$EMB" --k 5 | jq '.[] | {id, score}'

# Cross-collection RAG
vec search-across "docs,faq,tickets" "$EMB" --k 3
```
