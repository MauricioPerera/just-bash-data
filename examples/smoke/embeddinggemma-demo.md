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

## Why this matters

- **One embedder, every language**: a single model call replaces having to ship per-language stacks. Matters for global agents.
- **Matryoshka means cheap fallback**: store full-dim vectors at index time; query-time you can pre-filter at 128d (≈6× faster comparisons) and re-rank at 768d.
- **`just-bash-data` v0.3.0** lets the same shell do both halves: `vec` for embeddings, `db` for structured metadata, plus the new permissive parsing (`''`, options object) for less LLM friction.
