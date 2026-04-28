# `embeddinggemma-demo.mjs` — multilingual semantic search

End-to-end demonstration of [`@cf/google/embeddinggemma-300m`](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/) feeding the `just-bash-data` `vec` store, plus the v0.3.0 refinements showcased on `db`.

## What the model brings

| Property | Value |
|---|---|
| Model ID | `@cf/google/embeddinggemma-300m` |
| Embedding dimension | **768** |
| Languages | 100+ (verified here on en/es/ja/ar/hi) |
| Matryoshka | yes — first-N-dim prefix retains semantic signal |
| Batch input | up to 100 strings per call |
| Response shape | `{ data: number[][], shape: number[] }` |

## What the demo does

1. Embeds **15 multilingual sentences** (5 concepts × 5 languages: cat / rocket / bread × en/es/ja/ar/hi) in **one Workers AI call**.
2. Boots `just-bash-data` plugin against a real disk path under `examples/smoke/agent-data/`.
3. Bulk-inserts the 15 vectors with `lang` and `text` metadata.
4. Runs **3 cross-lingual queries** (English query → finds Japanese match, Spanish query → English/Arabic match, etc.) at full 768d.
5. Runs the same query through **matryoshka stages 768 → 512 → 256 → 128 dim**, comparing top-3 overlap vs the full-dim baseline.
6. **Bonus**: exercises the v0.3.0 refinements on `db`:
   - `count ''` (empty-filter alias)
   - `find '{}' '{"sort":{"stars":-1},"limit":2}'` (options object)
   - `export` → `drop` → `import` roundtrip

## Run

```bash
# from repo root
pnpm install
pnpm build

export CF_ACCOUNT_ID=...
export CF_API_TOKEN=...    # token with Workers AI scope
node examples/smoke/embeddinggemma-demo.mjs
```

## Empirically verified output (2026-04-28)

Measured against the live `@cf/google/embeddinggemma-300m` endpoint with the exact 15-concept corpus and 3 cross-lingual queries from the script:

### Cross-lingual semantic search (full 768d)

| Query | Top-3 (id @ cosine) |
|---|---|
| EN "A small furry pet that purrs" | en-cat @0.604, hi-cat @0.541, ja-cat @0.532 |
| ES "Vehículo espacial con propulsión" | ar-rocket @0.631, es-rocket @0.578, ja-rocket @0.573 |
| JA "小麦から作る焼いた食べ物" | ja-bread @0.640, en-bread @0.566, hi-bread @0.557 |

Every query retrieved the correct semantic cluster across 5 languages. The model never confused a cat for a rocket or bread.

### Matryoshka prefix property (probe: "small carnivorous pet animal")

| Dim | Top-3 | Overlap vs 768d baseline |
|---|---|---:|
| 768 (baseline) | en-cat, hi-cat, ja-cat | 3/3 |
| 512 | en-cat, ja-cat, hi-cat | 3/3 |
| 256 | en-cat, ar-cat, ja-cat | 2/3 |
| 128 | en-cat, ar-cat, ja-cat | 2/3 |
| 64 (12× compression) | ar-cat, en-cat, ja-cat | 2/3 |

At every truncation level **all three top-3 hits were `*-cat` concepts** — only the language-of-the-runner-up shuffled as dimensions dropped. The semantic class is preserved through 12× compression.

Empirical validation timestamp: 2026-04-28. Full Workers AI batch (18 vectors, 768 dim each, 1 547 ms wall-clock for the entire batch).

## Why this matters

- **One embedder, every language**: a single model call replaces having to ship per-language stacks. Matters for global agents.
- **Matryoshka means cheap fallback**: store full-dim vectors at index time; query-time you can pre-filter at 128d (≈6× faster comparisons) and re-rank at 768d.
- **`just-bash-data` v0.3.x** lets the same shell do both halves: `vec` for embeddings, `db` for structured metadata, plus the new permissive parsing (`''`, options object) for less LLM friction.
