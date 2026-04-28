# Llama 3.2 3B — v0.4.0 → v0.7.0 retest

Replay of the same 12-command transcript captured during the original 8-model
benchmark, this time against `just-bash-data@0.7.0`.

| | v0.4.0 | v0.7.0 |
|---|---|---|
| Commands with exit 0 | 10 / 12 | 11 / 12 |
| Functionally correct results | 10 / 12 | **10 / 12** *(unchanged)* |
| Errors fixed | — | 1 (parse-only) |
| Regressions | — | 0 |
| **Silent-failure regression** | — | **1** |

## Per-command diff

| # | command | v4 | v7 | note |
|---|---|---|---|---|
| 1–6 | inserts + count + update | 0 | 0 | unchanged |
| **7** | `db books find '{"year": {gt: 1950}}' --sort year:-1` | **2** `invalid json: filter` | **0** *(returns 5 books)* | **silent regression — see below** |
| 8 | `update '{"title":"Foundation"}' '{"year":1942}'` | 0 | 0 | unchanged |
| **9** | `db books aggregate '{"genre":"scifi"}' '{"$count":1}'` | **2** `pipeline must be an array` | **2** *same* | unchanged — structural, not parsing |
| 10–12 | remove + count + sorted find | 0 | 0 | unchanged |

## Cmd #7 — the silent semantic failure

The model emitted `{"year": {gt: 1950}}` — bareword key `gt` **without** the `$` prefix.

**v0.4.0 behavior**: strict `JSON.parse` rejected the bareword key → exit 2,
`invalid json: filter`. The agent saw a clear error and could correct.

**v0.7.0 behavior** *(after v0.6.0 lenient JSON landed)*:

1. `relaxJson` quotes the bareword: `{"year": {gt: 1950}}` → `{"year": {"gt": 1950}}`
2. `JSON.parse` now succeeds: `{ year: { gt: 1950 } }`
3. The doc-store filter engine sees `{gt: 1950}` as a literal sub-object value,
   not an operator (no `$` prefix). With no recognized operators inside, it
   appears to fall through to a permissive match — returning **all 5 books**
   instead of the 4 published after 1950.
4. Exit 0, no warning on stderr.

This is **strictly worse** than the v0.4.0 behavior for the agent: it gets a
plausible-looking response with the wrong data, no signal to retry. The
relaxer succeeded at making the JSON valid but the *semantic* error
(missing `$`) is now invisible.

Verified empirically:

```
$ db t find '{"y": {gt: 1950}}'
[{"y":1965,...}, {"y":1937,...}]   ← matches BOTH (wrong)

$ db t find '{"y": {$gt: 1950}}'
[{"y":1965,...}]                   ← matches only y>1950 (correct)
```

## Cmd #9 — structural mismatch, unchanged

The model passed the `$match` filter and the `$group` accumulator as **two
separate positional args** instead of a pipeline array:

```
db books aggregate '{"genre":"scifi"}' '{"$count":1}'
```

The canonical form is:

```
db books aggregate '[{"$match":{"genre":"scifi"}}, {"$group":{"_id":null,"n":{"$count":1}}}]'
```

This is a structural error, not a parse-relaxation case. v0.7.0 does not
address it. Adding a "two-arg → pipeline" alias is risky because the
semantics of the second arg are ambiguous (is it the `$group` accumulators?
the `_id` projection?). Recommend leaving this as a documented usage error.

## What this means for the v0.7.0 plateau claim

**The v0.7.0 release notes overstated the user-facing improvement.** The
"fix" for cmd #7 is technically a parse-success but functionally a silent
miss. From the agent's point of view, v0.7.0 **did not improve** Llama 3.2 3B's
correctness on this trace — it only changed the *failure mode* from loud to
silent.

Net for Llama 3.2 3B:
- **Correctness**: 10/12 → 10/12 (no change)
- **Loud-vs-silent failure**: cmd #7 became silent (worse for agent retry loops)
- **Pure cmd #7 wins** would only materialize if the model emits `$gt` (with
  `$`) in JS-literal style — which Llama 3.1 8B FP and Llama 3.2 3B *do*
  sometimes emit (per the v0.6.0 release notes), but not in this particular
  transcript.

## Recommended follow-up (not yet implemented)

A v0.8.0 candidate: **operator-aware validation** in the `db` filter parsing
path. When a filter value-object contains bareword keys matching known Mongo
operator names without a `$` prefix, reject with exit 5 +
`validation: filter operator missing $ prefix: did you mean $gt?`.

This restores the v0.4.0 "loud failure" property while keeping the v0.6.0
parse relaxation for the cases where it's actually correct (`{$gt: 1950}` →
`{"$gt": 1950}`).

Operators to detect (filter context only):
`eq, ne, gt, gte, lt, lte, in, nin, exists, regex, contains, size, and, or, not`.

Risk to manage: legitimate user fields named `gt` / `lt` etc. — mitigation
is to only flag value-objects (not top-level keys, not deep-nested data
sub-trees) and document the rule. Likely safe given the LLM-tooling target
audience.
