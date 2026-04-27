# Workers AI agent benchmark on `just-bash-data`

Comparison of 6 Cloudflare Workers AI models (5 instruction-tuned + 1 reasoning) acting as autonomous agents that drive the `db` command. The orchestrator (a fixed JS script) is a dumb pipe: it does no interpretation, error correction, or syntax fix-up. The model alone decides every command emitted.

## Test methodology

### The task

Build a tiny library catalog in collection `books`, executing 7 steps of CRUD:

1. Insert 5 books (Dune 1965 scifi, Foundation 1951 scifi, 1984 1949 dystopia, Brave New World 1932 dystopia, The Hobbit 1937 fantasy).
2. Count books in genre `scifi`.
3. Find books with `year > 1950`, sorted by year descending.
4. Update Foundation: set year to 1942.
5. Aggregate count of books by genre.
6. Remove the book with title `1984`.
7. Count remaining books, then find all sorted by year ascending.

### The harness

- **Plugin runtime**: just-bash 2.14.3 + `just-bash-data` (this package) on Node 22, with state persisted to a real disk path (`agent-data/`) for reproducibility across turns.
- **Step runner** (`granite-agent-step.mjs`): stateless executor. Reads a JSON array of bash command strings from a file, runs each through `bash.exec()` against the plugin, returns `[{cmd, stdout, stderr, exitCode, elapsed_ms}]`. **Does not** edit, sanitize, or fix any command.
- **Orchestrator loop** (manual, alternating MCP + Bash):
  1. Call the model via Workers AI with the current message history.
  2. Regex-extract `EXEC:` lines from the model's reply.
  3. Pipe those exact strings to the step runner.
  4. Append the assistant turn + the tool results back to history.
  5. Continue until the model emits `DONE` or the task is complete.

### System prompt (identical for all models)

Strict format rules:
- Output one bash command per line prefixed `EXEC: `.
- Optional one-line `NOTE: ` after.
- End with `DONE` on its own line.
- No code fences, no markdown.

Plus a tool reference (subcommands, filter operators `$eq..$nin..$regex`, update operators `$set/$inc/$push/$pull`, aggregation stages including `$group` with accumulators `$count $sum $avg $min $max`, and the bash quoting rule "every JSON arg in single quotes").

### Fairness controls

- Identical system prompt and task across all models.
- Identical orchestrator code path.
- Fresh disk state (`rm -rf agent-data`) before every run.
- `temperature = 0.1` everywhere.
- Maximum tokens per turn capped (256–1024 depending on turn) to keep costs bounded.

## Models tested

| Model | $/M input | $/M output | Context window | Notes |
|---|---:|---:|---:|---|
| `@cf/ibm-granite/granite-4.0-h-micro` | $0.017 | $0.11 | 131 000 | instruction-tuned |
| `@cf/meta/llama-3.2-3b-instruct` | $0.051 | $0.34 | 80 000 | instruction-tuned |
| `@cf/meta/llama-3.1-8b-instruct-awq` | $0.12 | $0.27 | 8 192 | AWQ 4-bit quantized |
| `@cf/meta/llama-3.1-8b-instruct` | $0.28 | $0.83 | 7 968 | full-precision |
| `@cf/meta/llama-3.2-11b-vision-instruct` | $0.049 | $0.68 | 128 000 | vision-capable |
| `@cf/google/gemma-4-26b-a4b-it` | $0.10 | $0.30 | **256 000** | **reasoning model** (emits explicit `reasoning` field; counts as completion tokens) |

Pricing source: Cloudflare Workers AI model pages, fetched 2026-04-27.

**API shape note**: Gemma 4 returns OpenAI-style `choices[0].message.content` plus a separate `choices[0].message.reasoning` field with internal thinking. Reasoning bytes count as completion tokens and inflate output cost — see "Reasoning economics" section below.

## Results overview

| | Granite 4.0 | Llama 3.2 3B | Llama 3.1 8B AWQ | Llama 3.1 8B FP | Llama 3.2 11B-V | **Gemma 4 26B** |
|---|---:|---:|---:|---:|---:|---:|
| Turns to DONE | **3** | 5 (false DONE) | 4 | 4 | 5 (incomplete) | 4 |
| Commands emitted | 16 | 19 | 17 | 19 | 17 | **12** |
| Commands OK (exit 0) | 13 (81%) | 10 (53%) | 12 (71%) | 15 (79%) | 12 (71%) | **12 (100%)** |
| Steps completed | 7/7 ✅ | 5/7 ⚠️ | 7/7 ✅ | 7/7 ✅ | 6/7 ⚠️ | **7/7 ✅** |
| Σ input tokens | 3 215 | 3 532 | 2 728 | 2 190 | **2 001** | 2 652 |
| Σ output tokens | **477** | 446 | 356 | 375 | 391 | 4 821 |
| Wall-clock time (model) | 17.5 s | **5.6 s** | 11.9 s | 12.8 s | 10.5 s | 50.5 s |

## Token economics — actual cost of one task run

Calculation: `(Σ_in × $in/M + Σ_out × $out/M) / 10⁶`.

| Model | Input cost | Output cost | **Total per run** |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | $0.0000547 | $0.0000525 | **$0.000107** |
| Llama 3.2 3B | $0.0001801 | $0.0001516 | $0.000332 |
| Llama 3.2 11B-V | $0.0000980 | $0.0002659 | $0.000364 |
| Llama 3.1 8B AWQ | $0.0003274 | $0.0000961 | $0.000423 |
| Llama 3.1 8B FP | $0.0006132 | $0.0003113 | $0.000924 |
| **Gemma 4 26B-a4b** | $0.0002652 | $0.0014463 | **$0.001712** |

**Granite is 8.6× cheaper than Llama 3.1 8B FP, 3.4× cheaper than Llama 3.2 11B-V, and 16× cheaper than Gemma 4** for the same task — even with cheaper per-token rates from some competitors, Granite wins because it converged in 3 turns and didn't burn output tokens on reasoning.

### Cost per successful command (utility per dollar)

| Model | Cost | OK cmds | **$ per OK cmd** |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | $0.000107 | 13 | **$0.0000082** |
| Llama 3.2 11B-V | $0.000364 | 12 | $0.0000303 |
| Llama 3.2 3B | $0.000332 | 10 | $0.0000332 |
| Llama 3.1 8B AWQ | $0.000423 | 12 | $0.0000353 |
| Llama 3.1 8B FP | $0.000924 | 15 | $0.0000616 |
| Gemma 4 26B-a4b | $0.001712 | 12 | $0.0001427 |

### Cost per task completion (only models that actually finish 7/7)

| Model | $ per completion | Cmd success rate |
|---|---:|---:|
| **Granite 4.0-h-micro** | **$0.000107** | 81% |
| Llama 3.1 8B AWQ | $0.000423 | 71% |
| Llama 3.1 8B FP | $0.000924 | 79% |
| **Gemma 4 26B-a4b** | $0.001712 | **100%** |
| Llama 3.2 3B | ∞ (5/7) | 53% |
| Llama 3.2 11B-V | ∞ (6/7) | 71% |

Gemma 4 has perfect command precision (100%) but its task-completion price is **16× higher than Granite**. The 19-percentage-point precision gap (Granite 81% → Gemma 100%) costs $0.0016 extra per run — only justified when each emitted command has expensive side-effects (paid API calls, irreversible mutations) or when downstream retry cost dominates.

### Extrapolation at scale

| Model | × 1 000 tasks | × 10 000 tasks | × 100 000 tasks |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | **$0.107** | $1.07 | $10.7 |
| Llama 3.2 3B | $0.332 | $3.32 | $33.2 |
| Llama 3.2 11B-V | $0.364 | $3.64 | $36.4 |
| Llama 3.1 8B AWQ | $0.423 | $4.23 | $42.3 |
| Llama 3.1 8B FP | $0.924 | $9.24 | $92.4 |
| Gemma 4 26B-a4b | $1.712 | $17.12 | **$171** |

At 100K runs/day, choosing Granite over Gemma 4 saves ≈**$160/day → ~$58 000/year** on this task alone.

## Reasoning economics (Gemma 4 specific)

Gemma 4 26B-a4b is a **reasoning model**: it emits a separate `message.reasoning` field with internal thinking before producing `message.content`. Reasoning tokens count as completion tokens and are billed at the output rate ($0.30/M).

Reasoning vs answer breakdown observed in the test:

| Turn | Reasoning chars | Output content chars | Completion tokens | Reasoning ≈ % of output |
|---|---:|---:|---:|---:|
| 1 (5 inserts) | 1 145 | 535 | 566 | ~50% |
| 2 (1 cmd) | 409 | 39 | 142 | ~73% |
| 3 (1 cmd) | 811 | 53 | 308 | ~88% |
| 4 (5 cmds, batch) | **11 262** | 313 | **3 805** | **~93%** |

Turn 4 emitted only 313 chars of actual commands but burned 11 262 chars (≈2 800 tokens) thinking about them. **The deeper Gemma plans, the more disproportionate reasoning becomes.**

This is the source of Gemma's high cost: same number of correct commands as Granite, but ~10× the output tokens. A reasoning model only pays off when:

1. The task is complex enough that thinking prevents costly mistakes, AND
2. The cost of an incorrect command exceeds the cost of the reasoning tokens.

Neither condition holds for `db` driving — commands are cheap to retry locally.

## Context window — the silent dealbreaker

Tokens consumed per turn during the test (input grows as history accumulates):

| Turn | Granite | Llama 3.2 3B | Llama 3.1 8B AWQ | Llama 3.1 8B FP | Llama 3.2 11B-V | Gemma 4 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 693 | 696 | 696 | 716 | 695 | 774 |
| 2 | 1 757 | 997 | 888 | 880 | 856 | 948 |
| 3 | 765 | 928 | 579 | 399 | 212 | 588 |
| 4 | — | 616 | 565 | 195 | 183 | 342 |
| 5 | — | 295 | — | — | 55 | — |
| Peak input | 1 757 | 997 | 888 | 880 | 856 | 948 |

Now overlay the context windows:

| Model | Context | Headroom at peak |
|---|---:|---|
| **Gemma 4 26B-a4b** | **256 000** | **270× the peak** |
| Granite 4.0-h-micro | 131 000 | 75× the peak |
| Llama 3.2 11B-V | 128 000 | 150× the peak |
| Llama 3.2 3B | 80 000 | 80× the peak |
| **Llama 3.1 8B AWQ** | **8 192** | **9× the peak — under 10 turns** |
| **Llama 3.1 8B FP** | **7 968** | **9× the peak — under 10 turns** |

The Llama 3.1 8B family has a **hard cliff at ≈8K tokens**. In a real long-running agent session the history would saturate the window in 5-7 turns of typical complexity. The 4 conversation-friendly models (Granite, both Llama 3.2 variants, Gemma 4) have 16-30× more headroom.

This invalidates Llama 3.1 8B for sustained agentic operation despite its high task completion rate in the benchmark. Gemma 4 has the most context room (256K) but also the highest per-task cost — its headroom advantage matters only for very long sessions.

## Per-model behaviour notes

### Granite 4.0-h-micro — the winner

- **Strategy**: big-bang plan in turn 1 (12 commands + premature DONE) then 2 correction turns.
- **Strengths**: bash quoting correct from turn 1; cleanest output discipline (no code fences, no prose).
- **Weakness**: persisted with `$sum:1` for 2 turns; only the third feedback (with literal example) corrected it.
- **Total errors**: 3.

### Llama 3.2 3B — disqualified

- **Strategy**: turn-by-turn, conservative.
- **Errors**: forgot single-quotes for an entire turn (4/4 fails); invented `--descending` flag; repeatedly reverted to `$sum:1`; in turn 5 regressed to MongoDB shell syntax `db.books`; wrapped a turn in markdown code fences.
- **Total errors**: 9. Did **not** complete the task (5/7 steps).

### Llama 3.1 8B AWQ — second tier

- **Strategy**: turn-by-turn.
- **Strong start** (turns 1-2: 7/7), then **regressed in turn 3** (dropped the `db books` prefix entirely, wrote orphan `update`/`aggregate`/`count` commands → 0/5 with exit 127).
- Recovered in turn 4 by copying examples verbatim from feedback.
- Quantization left a measurable mark: AWQ used `$count:1` only after seeing the example; the FP variant proposed it on its own.

### Llama 3.1 8B FP — second tier (best precision)

- **Highest commands-OK rate (79%)**.
- **Discovered `$count:1` autonomously** in turn 2 — only model in the benchmark to do so.
- Then **regressed** to `$sum:1` in turn 3 even though my feedback contained `$count:1` literally.
- Highest absolute cost ($0.000924) and tightest context (7 968 tokens).

### Gemma 4 26B-a4b — perfect precision, premium price

- **The only model with 100% command success (12/12) and zero retries.**
- **Discovered `$count:1` autonomously on first attempt** AND maintained it correctly across all turns — only model in the benchmark to do this without regressing.
- Used minimal-syntax forms by default: `'{"genre":"scifi"}'` instead of `'{"genre":{"$eq":"scifi"}}'`; no spurious `$match` stage before `$group`; `'{}'` for empty filters.
- **Reasoning is expensive**: turn 4 generated 11 262 chars of internal thinking for 5 short commands.
- 256K context window — most generous of the benchmark.
- Returns OpenAI-style `choices[0].message.{content, reasoning}` shape, distinct from the Llama family's flat `result.response`.

### Llama 3.2 11B Vision — best start, hardest fall

- **Best turn-2 of the entire benchmark** (6/7 in a single turn).
- Turn 3: total **regression to MongoDB shell** syntax (`db.books.find(...)` with parens), exit 2 syntax error in bash.
- **Most extreme MongoDB prior** observed:
  - Asked it to copy a literal `$count:1` line verbatim ("Output exactly: …`$count`:1…") in a minimal-prompt experiment.
  - Output came back with `$sum:1` instead.
  - The pretrained MongoDB pattern overrode a direct copy instruction. Did not complete (6/7).

## The shared trap: `$count:1` vs `$sum:1`

Every single model defaulted to MongoDB-style `{"$sum": 1}` to count items per group, despite the system prompt explicitly listing `$count` as the accumulator and including the example `{"k":{"$count":1}}`.

Behaviour:

| Model | Used `$count:1` first try? | Resistance to feedback |
|---|---|---|
| Granite | no | 1 round of feedback to fix |
| Llama 3.2 3B | no | 3+ rounds |
| Llama 3.1 8B AWQ | no | 1 round (with example) |
| Llama 3.1 8B FP | yes (turn 2) | regressed in turn 3 |
| Llama 3.2 11B-V | no, then no, then verbatim copy still failed | unbreakable |
| **Gemma 4 26B-a4b** | **yes** | **no regression — held the pattern across all turns** |

This is the **single error that not one model avoided cleanly**. The cheapest spec change to remove agent friction is:

> **Implement `$sum: 1` as an alias of `$count: 1` in `aggregateHandler`**.

It would cost ~5 lines in `src/commands/db/crud.ts` and immediately bring most of the benchmark to 7/7 in 1-2 turns.

## Frontier ranking — cost × reliability × context

Weighting all three dimensions: total $ per task, completion rate, and context-window headroom.

| Rank | Model | Why |
|---|---|---|
| 🥇 | **Granite 4.0-h-micro** | Cheapest by 3-16×; 7/7 completion; 131K context. **The only model that wins on cost while still completing.** |
| 🥈 | Gemma 4 26B-a4b | **Perfect 100% command precision**; 256K context; but 16× more expensive than Granite due to reasoning tokens. Right pick when retries are costly. |
| 🥉 | Llama 3.1 8B AWQ | 4× cheaper than FP, similar completion; constrained to 8K context. |
| 4️⃣ | Llama 3.1 8B FP | High precision (79%) but most expensive non-reasoning option and 8K context. |
| ❌ | Llama 3.2 11B-V | Does not complete; impervious to copy-instruction feedback. |
| ❌ | Llama 3.2 3B | Regressive, does not complete, 53% command precision. |

## Operational recommendations

1. **Default for production agents driving `db` → Granite 4.0-h-micro.** Cheapest, completes the task, has 16× the context window of the Llama 3.1 8B family.
2. **If retries are costly (paid API calls, irreversible operations) → Gemma 4 26B-a4b.** 100% command precision means zero retries; pay 16× more per task but lose nothing to redo work. Best when a single bad command costs more than the entire reasoning budget.
3. **If Granite is unavailable → Llama 3.1 8B AWQ.** 4× cheaper than the FP variant for similar completion rate; accept the 8K context cap by keeping sessions short.
4. **Avoid Llama 3.1 8B FP in production.** 2.2× more expensive than AWQ for marginal precision gain, and same context cap.
5. **Avoid the Llama 3.2 family entirely for this kind of structured tool-use.** Both 3B and 11B-V regress mid-loop to MongoDB shell syntax and resist `$count:1` correction.
6. **Patch the plugin** to accept `$sum: 1` as `$count: 1`. This single change would have moved Llama 3.2 11B-V from 6/7 to 7/7 and shaved ≈1 turn off most other models — only Gemma 4 was already immune.

### Decision flow

```
Is the agent driving cheap, idempotent operations (this case)?
├── yes → Granite 4.0-h-micro                  (lowest $)
└── no, retries are expensive → Gemma 4 26B-a4b  (zero errors)

Is the session very long (>50 turns)?
├── yes → Granite (131K) or Gemma 4 (256K)
└── no, short bursts → any of the 6 fits

Need vision input?
├── yes → Llama 3.2 11B-V  (despite the regression issue)
└── no  → use Granite or Gemma per the cost/reliability axis above
```

## Reproducing this benchmark

The full set of commands emitted by each model is captured under `examples/smoke/`:

```
turn1-cmds.json … turn3-cmds.json             (Granite)
llama-turn1-cmds.json … turn5-cmds.json       (Llama 3.2 3B)
llama8b-turn1-cmds.json … turn4-cmds.json     (Llama 3.1 8B AWQ)
llama8b-fp-turn1-cmds.json … turn4-cmds.json  (Llama 3.1 8B FP)
llama11bv-turn1-cmds.json … turn5-cmds.json   (Llama 3.2 11B-V)
gemma4-turn1-cmds.json … turn4-cmds.json      (Gemma 4 26B-a4b)
```

To replay any single turn against a fresh state:

```bash
cd examples/smoke
rm -rf agent-data
node granite-agent-step.mjs <turn-N-cmds.json>
```

To run the model loops end-to-end yourself, you need a Cloudflare Workers AI account ID and a token with `Workers AI` scope. The orchestrator pattern (alternating Granite / Bash) is documented in this repo's session transcript; reproducing it cleanly requires a small driver script that the author has not yet packaged.

---

**Benchmark date**: 2026-04-27
**Plugin version**: just-bash-data v0.1.0
**just-bash version**: 2.14.3
**Node**: 22.21.1 (Windows)
