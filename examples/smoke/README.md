# `examples/smoke`

End-to-end smoke tests for the `just-bash-data` plugin. Treats the package as a downstream consumer would: `import { createDataPlugin } from "just-bash-data"` against the built bundle.

## Run

From the **repo root**:

```bash
pnpm install
pnpm build
pnpm --filter just-bash-data-smoke smoke:full
```

This wires up `examples/smoke` as a pnpm workspace package and resolves `just-bash-data` to the local build via `workspace:*`.

## Three flavors

| Script | What it covers |
|---|---|
| `pnpm smoke` (smoke.mjs) | ESM happy path: register / login / encrypted insert / vec store + search / logout invalidation. **17 assertions.** |
| `pnpm smoke:cjs` (smoke.cjs) | CJS happy path: db insert + find with `$gte`, vec stats. **7 assertions.** |
| `pnpm smoke:full` (smoke-full.mjs) | Full E2E: every subcommand, every Mongo operator, every quantization, every documented exit code, encryption round-trip across registry instances, cross-instance persistence. **181 assertions.** |

All scripts exit non-zero on any failed assertion and print a list of failures.

## What this is NOT

These are smoke tests for documentation-by-example, not the canonical test suite. The unit tests (`pnpm test` from the repo root) are the source of truth for correctness.
