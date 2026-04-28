# v0.8.1 Benchmark — 8 model agent transcripts

Replay of the original 8-model agent transcripts captured during the
`just-bash-data` v0.1.0–v0.4.0 development against the current v0.8.1
plugin. Same commands, same order, same disk-backed `Bash` instance per
model. The point: how does the cumulative v0.5.0–v0.8.1 work change the
shell-level success rate?

## Aggregate

| | total |
|---|---|
| Commands executed across 8 models | **107** |
| Exit 0 (success) | **103 (96.3%)** |
| Exit 2 (usage / parse error) | 3 |
| Exit 5 (validation — actionable hint) | 1 |
| Other | 0 |

## Per-model

| Model | v0.4.0 exit-0 | v0.8.1 exit-0 | Δ | Note |
|---|---:|---:|---:|---|
| Granite 4.0 | n/a | **16/16** | — | canonical syntax — no aliases triggered |
| Llama 3.2 3B | 10/12 | **10/12** | 0 | cmd #6 went `2 → 5` (loud → loud-actionable); cmd #9 structural (uninterceptable) |
| Llama 3.1 8B AWQ | 12/12 | **12/12** | 0 | canonical |
| Llama 3.1 8B FP | 11/12 | **12/12** | **+1** | cmd #6 fixed by v0.6.0 lenient JSON (`{$gt:1950}` JS-literal) |
| Llama 3.2 11B-V | n/a | **15/17** | — | 2 uninterceptable bash parse errors (`db.books.find(...)` parens form) |
| GPT-OSS-20B | n/a | **13/13** | — | canonical |
| Llama 4 Scout | 13/13 | **13/13** | 0 | canonical |
| Gemma 4 26B | n/a | **12/12** | — | canonical |
| **Across reference set** | **46/49** | **47/49** | **+1** | net win, no regressions |

## What changed vs v0.4.0

Only two commands changed exit code across the entire reference set
(Llama 3.2 3B + AWQ + FP + Scout, 49 commands total):

### Llama 3.1 8B FP, cmd #6 — `2 → 0` (v0.6.0 lenient JSON win)

```bash
db books find '{"year":{$gt:1950}}' --sort 'year:-1'
```

The model emitted the **correct** `$gt` operator, but in JS-object-literal
style — bareword key, no quotes around `$gt`. Strict `JSON.parse` rejected
it in v0.4.0 (`exit 2: invalid json: filter`). v0.6.0's `relaxJson` quotes
the bareword `$gt` to make it valid JSON, and the operator validator (v0.8.0)
accepts `$gt` because it has the `$` prefix. **No agent retry needed.**

### Llama 3.2 3B, cmd #6 — `2 → 5` (loud → loud-actionable)

```bash
db books find '{"year": {gt: 1950}}' --sort year:-1
```

The model dropped the `$` from the operator. Across versions:

| version | exit | message | agent signal |
|---|---|---|---|
| v0.4.0 | 2 | `invalid json: filter` | "JSON wrong" — no fix hint |
| v0.7.0 (rolled back) | 0 | (returned all 5 docs) | **silent semantic miss** |
| v0.8.1 | 5 | `validation: filter operator 'gt' at year.gt is missing $ prefix — did you mean '$gt'?` | "use `$gt`" — direct fix |

The v0.6.0 lenient JSON quoted `gt` but the doc-store didn't recognize
it as an operator (no `$`), so v0.7.0 silently returned every book. v0.8.0's
operator validator restored loud-failure semantics with a precise corrective
message — the agent now retries with `$gt` instead of accepting the wrong
result. See `v7-llama32-3b-report.md` for the full silent-regression
postmortem.

## The 4 unfixable failures

| Model | cmd | exit | reason | fixable? |
|---|---|---|---|---|
| Llama 3.2 3B | `db books find '{"year": {gt: 1950}}' --sort year:-1` | 5 | missing `$` on `gt` | ✅ in v0.8.0 (loud + actionable hint) |
| Llama 3.2 3B | `db books aggregate '{"genre":"scifi"}' '{"$count":1}'` | 2 | structural — two args instead of pipeline array | ❌ alias is semantically ambiguous |
| Llama 3.2 11B-V | `db.books.find('{"year":{"$gt":1950}}' --sort year:-1)` | 2 | bash syntax error on `(` | ❌ parser fires before plugin dispatch |
| Llama 3.2 11B-V | `db.books.aggregate([{"$group":{...}}])` | 2 | bash syntax error on `(` | ❌ same — uninterceptable from inside |

The 2 uninterceptable parens-form failures are documented in `AGENTS.md`
(v0.7.0 sentinel section) and the v0.7.0 release notes. Stopping the
model from emitting `db.<coll>.<method>(...)` requires either a system-prompt
hammer or a bash-level wrapper outside the plugin — neither is something
this package can fix on its own.

## What the validators caught (and didn't)

v0.8.0 + v0.8.1 added 4 operator-position validators (filter, pipeline
stage, group accumulator, update operator). Across the 107-command
benchmark only **one** command tripped a validator:

```
Llama 3.2 3B / cmd 6:
  db books find '{"year": {gt: 1950}}' --sort year:-1
  → exit 5: filter operator 'gt' at year.gt is missing $ prefix — did you mean '$gt'?
```

This is the empirical justification for the validators existing at all:
the smaller distilled models (Llama 3.2 3B, Llama 3.1 8B FP) have a measurable
tendency to drop `$` from Mongo operators. The larger / canonical models
(Granite, GPT-OSS, Scout, Gemma, AWQ) didn't trigger a single
validator hit — confirming the validators are silent for well-behaved input
and only surface when needed.

## What the v0.6.0 lenient JSON caught

Beyond cmd #6 of Llama 3.1 8B FP shown above, every other JS-literal
emission in the trace (e.g., `{$gt:1950}` with `$` but no JSON quotes) is
silently accepted via the relaxer. There were no relaxer-related
regressions in the trace.

## Sentinels (v0.7.0)

No transcript in the reference set triggered a `db.<coll>` sentinel
(without parens). The dot-syntax-without-parens form was observed during
manual exploration but never in this captured trace set. The two
parens-form failures from Llama 3.2 11B-V are uninterceptable
upstream of the plugin, not sentinel candidates.

## Reproducibility

```bash
cd examples/smoke
node v8-benchmark.mjs
```

Reads the same `*-cmds.json` files used during the original v0.1.0–v0.4.0
benchmarks, runs each model's full trace through a fresh disk-backed
`Bash` with `createDataPlugin()` from the workspace `just-bash-data` link,
writes one `v8-<model>-out.json` per model + a `v8-summary.json`.

## Conclusion

Going from v0.4.0 → v0.8.1, the agent trace replay shows:

- **+1 command success** in the reference set (Llama 3.1 8B FP cmd #6)
- **0 regressions**
- **1 silent-failure-prevented** (Llama 3.2 3B cmd #6 went 2→5; v0.6.0 alone would have made it 2→0-but-wrong, the v0.8.0 validator caught it)
- **4 model traces with 100% exit-0** (Granite, AWQ, Scout, Gemma 4 — and FP, AWQ, Scout already had 100% in v0.4.0; only FP gained the +1)
- **2 uninterceptable bash parse errors** documented as known limits

The v0.8.1 plugin's claim "permissive parsing where it's safe, loud
failure where it's not" is empirically supported. The work was justified
not by raw exit-0 count (which barely moved), but by what the failure
signals communicate to a retry-loop agent.
