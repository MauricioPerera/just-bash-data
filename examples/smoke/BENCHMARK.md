# Workers AI agent benchmark on `just-bash-data`

Comparison of 8 Cloudflare Workers AI models (5 instruction-tuned + 2 reasoning + 1 MoE) acting as autonomous agents that drive the `db` command. The orchestrator (a fixed JS script) is a dumb pipe: it does no interpretation, error correction, or syntax fix-up. The model alone decides every command emitted.

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
| `@cf/openai/gpt-oss-20b` | $0.20 | $0.30 | 128 000 | **reasoning model** (`message.reasoning_content`) |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | $0.27 | $0.85 | 131 000 | MoE 17B/16-expert, multimodal |
| `@cf/google/gemma-4-26b-a4b-it` | $0.10 | $0.30 | **256 000** | **reasoning model** (`message.reasoning`) |

Pricing source: Cloudflare Workers AI model pages, fetched 2026-04-27.

**API shape note**: Three different response formats observed across the eight models:
- Flat `result.response` (string): Llama 3.x family, Llama 4 Scout
- OpenAI `choices[0].message.content`: Granite, Gemma 4, GPT-OSS-20B
- Reasoning models add a separate field: Gemma 4 → `message.reasoning`; GPT-OSS-20B → `message.reasoning_content`. Both count as completion tokens (output cost). See "Reasoning economics" section.

## Results overview

| | Granite 4.0 | Llama 3.2 3B | Llama 3.1 8B AWQ | Llama 3.1 8B FP | Llama 3.2 11B-V | **GPT-OSS-20B** | **Llama 4 Scout** | **Gemma 4 26B** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Turns to DONE | 3 | 5 (false DONE) | 4 | 4 | 5 (incomplete) | **2** | 4 | 4 |
| Commands emitted | 16 | 19 | 17 | 19 | 17 | 13 | 14 | **12** |
| Commands OK (exit 0) | 13 (81%) | 10 (53%) | 12 (71%) | 15 (79%) | 12 (71%) | 12 (92%) | 12 (86%) | **12 (100%)** |
| Steps completed | 7/7 ✅ | 5/7 ⚠️ | 7/7 ✅ | 7/7 ✅ | 6/7 ⚠️ | **7/7 ✅** | 7/7 ✅ | **7/7 ✅** |
| Σ input tokens | 3 215 | 3 532 | 2 728 | 2 190 | 2 001 | 988 | **1 606** | 2 652 |
| Σ output tokens | **347** | 446 | 356 | 375 | 391 | 1 395 | 347 | 4 821 |
| Wall-clock time (model) | 17.5 s | **5.6 s** | 11.9 s | 12.8 s | 10.5 s | 8.2 s | 6.4 s | 50.5 s |

## Token economics — actual cost of one task run

Calculation: `(Σ_in × $in/M + Σ_out × $out/M) / 10⁶`.

| Model | Input cost | Output cost | **Total per run** |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | $0.0000547 | $0.0000525 | **$0.000107** |
| Llama 3.2 3B | $0.0001801 | $0.0001516 | $0.000332 |
| Llama 3.2 11B-V | $0.0000980 | $0.0002659 | $0.000364 |
| Llama 3.1 8B AWQ | $0.0003274 | $0.0000961 | $0.000423 |
| GPT-OSS-20B | $0.0001976 | $0.0004185 | $0.000616 |
| Llama 4 Scout 17B-16E | $0.0004336 | $0.0002950 | $0.000729 |
| Llama 3.1 8B FP | $0.0006132 | $0.0003113 | $0.000924 |
| **Gemma 4 26B-a4b** | $0.0002652 | $0.0014463 | **$0.001712** |

**Granite is 8.6× cheaper than Llama 3.1 8B FP, 6.8× cheaper than Llama 4 Scout, 5.8× cheaper than GPT-OSS-20B, and 16× cheaper than Gemma 4** for the same task — even with cheaper per-token rates from some competitors, Granite wins because it converged in 3 turns and didn't burn output tokens on reasoning or extra retries.

### Cost per successful command (utility per dollar)

| Model | Cost | OK cmds | **$ per OK cmd** |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | $0.000107 | 13 | **$0.0000082** |
| Llama 3.2 11B-V | $0.000364 | 12 | $0.0000303 |
| Llama 3.2 3B | $0.000332 | 10 | $0.0000332 |
| Llama 3.1 8B AWQ | $0.000423 | 12 | $0.0000353 |
| GPT-OSS-20B | $0.000616 | 12 | $0.0000513 |
| Llama 4 Scout 17B-16E | $0.000729 | 12 | $0.0000608 |
| Llama 3.1 8B FP | $0.000924 | 15 | $0.0000616 |
| Gemma 4 26B-a4b | $0.001712 | 12 | $0.0001427 |

### Cost per task completion (only models that actually finish 7/7)

| Model | $ per completion | Cmd success rate | Turns |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | **$0.000107** | 81% | 3 |
| Llama 3.1 8B AWQ | $0.000423 | 71% | 4 |
| **GPT-OSS-20B** | $0.000616 | 92% | **2** |
| Llama 4 Scout 17B-16E | $0.000729 | 86% | 4 |
| Llama 3.1 8B FP | $0.000924 | 79% | 4 |
| **Gemma 4 26B-a4b** | $0.001712 | **100%** | 4 |
| Llama 3.2 3B | ∞ (5/7) | 53% | 5 |
| Llama 3.2 11B-V | ∞ (6/7) | 71% | 5 |

Gemma 4 has perfect command precision (100%) but its task-completion price is **16× higher than Granite**. GPT-OSS-20B emerges as the **fewest-turns winner** (2 turns) at moderate cost, useful when orchestration latency matters more than per-token cost. Llama 4 Scout sits in the middle with no clear distinguishing advantage over GPT-OSS-20B, which is cheaper and faster.

### Extrapolation at scale

| Model | × 1 000 tasks | × 10 000 tasks | × 100 000 tasks |
|---|---:|---:|---:|
| **Granite 4.0-h-micro** | **$0.107** | $1.07 | $10.7 |
| Llama 3.2 3B | $0.332 | $3.32 | $33.2 |
| Llama 3.2 11B-V | $0.364 | $3.64 | $36.4 |
| Llama 3.1 8B AWQ | $0.423 | $4.23 | $42.3 |
| GPT-OSS-20B | $0.616 | $6.16 | $61.6 |
| Llama 4 Scout 17B-16E | $0.729 | $7.29 | $72.9 |
| Llama 3.1 8B FP | $0.924 | $9.24 | $92.4 |
| Gemma 4 26B-a4b | $1.712 | $17.12 | **$171** |

At 100K runs/day, choosing Granite over Gemma 4 saves ≈**$160/day → ~$58 000/year**. Choosing Granite over Llama 4 Scout saves ~$22 600/year. On this task alone.

## Reasoning economics (Gemma 4 + GPT-OSS-20B)

Two of the eight models are **reasoning models** that emit internal thinking before final output. The thinking text counts as completion tokens and is billed at the output rate. Different field names:

- Gemma 4 → `choices[0].message.reasoning` (string)
- GPT-OSS-20B → `choices[0].message.reasoning_content` (string)

### Gemma 4 26B-a4b — reasoning vs answer ratio

| Turn | Reasoning chars | Output content chars | Completion tokens | Reasoning % of output |
|---|---:|---:|---:|---:|
| 1 (5 inserts) | 1 145 | 535 | 566 | ~50% |
| 2 (1 cmd) | 409 | 39 | 142 | ~73% |
| 3 (1 cmd) | 811 | 53 | 308 | ~88% |
| 4 (5 cmds, batch) | **11 262** | 313 | **3 805** | **~93%** |

Turn 4 emitted only 313 chars of commands but burned 11 262 chars of thinking (≈2 800 tokens). The deeper Gemma plans, the more disproportionate reasoning becomes.

### GPT-OSS-20B — reasoning vs answer ratio

| Turn | Reasoning chars | Output content chars | Completion tokens | Reasoning % of output |
|---|---:|---:|---:|---:|
| 1 (12 cmds + DONE) | 897 | 1 285 | 494 | ~45% |
| 2 (1 cmd fix) | 3 042 | 80 | 901 | **~85%** |

GPT-OSS-20B is **more efficient** than Gemma 4 in turn 1 (reasoning was only 45% of output, while Gemma 4 turn 4 was 93%). But for "small correction" turns it spends disproportionately on reasoning — turn 2 burnt 3 042 chars planning a 1-line fix.

### Net cost impact

- Gemma 4: 4 821 output tokens × $0.30/M = $0.001446 (84% of total cost is output)
- GPT-OSS-20B: 1 395 output tokens × $0.30/M = $0.000419 (68% of total cost is output)

Reasoning models pay off **only when**:
1. The task is complex enough that thinking prevents costly mistakes, AND
2. The cost of an incorrect command exceeds the cost of the reasoning tokens.

Neither condition holds for cheap, idempotent `db` driving — commands are quick to retry locally.

## Context window — the silent dealbreaker

Peak input tokens per model during the test:

| Model | Peak input | Context window | Headroom at peak |
|---|---:|---:|---|
| **Gemma 4 26B-a4b** | 948 | **256 000** | 270× the peak |
| Granite 4.0-h-micro | 1 757 | 131 000 | 75× the peak |
| Llama 4 Scout 17B-16E | 695 | 131 000 | 188× the peak |
| Llama 3.2 11B-V | 856 | 128 000 | 150× the peak |
| GPT-OSS-20B | 759 | 128 000 | 169× the peak |
| Llama 3.2 3B | 997 | 80 000 | 80× the peak |
| **Llama 3.1 8B AWQ** | 888 | **8 192** | **9× — saturates after ~10 turns** |
| **Llama 3.1 8B FP** | 880 | **7 968** | **9× — saturates after ~10 turns** |

The Llama 3.1 8B family has a **hard cliff at ≈8K tokens**. In a real long-running agent session the history would saturate the window in 5-7 turns of typical complexity. The other 6 models (Granite, both Llama 3.2 variants, Llama 4 Scout, GPT-OSS-20B, Gemma 4) have 75-270× more headroom.

This invalidates Llama 3.1 8B for sustained agentic operation despite their high task completion rate in the benchmark. Gemma 4 has the most context room (256K) but also the highest per-task cost — its headroom advantage matters only for very long sessions.

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

### GPT-OSS-20B — fewest turns, mid-priced reasoning

- **Converged in 2 turns** — record of the benchmark.
- Big-bang strategy in turn 1: emitted **all 12 commands plus DONE in a single shot**, with `$gt` JSON-quoted correctly from the start (Granite emitted JS-style `{$gt: 1950}` in its first attempt).
- Conceded the `$count:1` correction in **one feedback round** — faster than Granite (2 rounds) and unlike Llama 3.2 11B-V (verbatim copy still failed).
- Reasoning emitted via `choices[0].message.reasoning_content` (different from Gemma 4's `message.reasoning`).
- Nice latency profile: 8.2 s total wall time vs 17.5 s for Granite.

Sweet spot when round-trips matter more than per-token cost — e.g., interactive agents where each turn adds noticeable lag.

### Llama 4 Scout 17B-16E — MoE without a clear win

- **MoE architecture** (16 experts, 17B active) — efficient compute on the provider side but no observable user-facing advantage in this benchmark.
- Multimodal capable (text + image) — not exercised here.
- 131K context window, same as Granite.
- **Premature DONE after step 1** (matching Llama 3.2 3B's pattern, suggesting a Meta-family planning quirk).
- **Unique error**: in turn 3, copied JSON-escape backslashes verbatim from the user feedback (`\\"$group\\"` instead of `"$group"`), producing `invalid json: pipeline`. No other model in the benchmark made this mistake — it indicates a less disciplined token-vs-character distinction.
- Recovered in turn 4 when the feedback was a literal copy-character-for-character instruction.
- Cost ($0.000729) and precision (86%) place it between GPT-OSS-20B and Llama 3.1 8B FP, with no axis it dominates.

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
| Granite | no | 2 rounds of feedback to fix |
| Llama 3.2 3B | no | 3+ rounds |
| Llama 3.1 8B AWQ | no | 1 round (with example) |
| Llama 3.1 8B FP | yes (turn 2) | regressed in turn 3 |
| Llama 3.2 11B-V | no, then no, then verbatim copy still failed | unbreakable |
| GPT-OSS-20B | no | **1 round — fixed cleanly** |
| Llama 4 Scout 17B-16E | no | 1 round (but emitted with backslash-escapes that broke JSON; needed a 2nd verbatim-copy round) |
| **Gemma 4 26B-a4b** | **yes** | **no regression — held the pattern across all turns** |

This was the **single error that not one model avoided cleanly**. **Fixed in v0.2.0**: `aggregateHandler` now rewrites `{"$sum": <number>}` to `{"$count": 1}` automatically. The MongoDB idiom every model defaulted to is now native syntax. `$sum` with a string operand (`{"$sum": "$amount"}`) still computes the field sum unchanged.

Effect on the benchmark: Llama 3.2 11B-V should reach 7/7 with this alias (its only blocker was `$sum:1`). The other 5 completing models would shave 1 turn (no longer needing the correction round).

## Frontier ranking — cost × reliability × context × latency

Weighting all four dimensions: total $ per task, completion rate, context-window headroom, and turns to DONE.

| Rank | Model | Why |
|---|---|---|
| 🥇 | **Granite 4.0-h-micro** | Cheapest by 3-16×; 7/7 completion; 131K context. **The only model that wins on cost while still completing.** |
| 🥈 | **GPT-OSS-20B** | **Fewest turns (2)**; 92% precision; 128K context. Reasoning model done right — efficient turn 1, modest reasoning overhead. Best when round-trip latency matters. |
| 🥉 | Gemma 4 26B-a4b | **Perfect 100% command precision**; 256K context; 16× more expensive than Granite due to reasoning tokens. Right pick when retries are costly. |
| 4 | Llama 3.1 8B AWQ | 4× cheaper than FP, similar completion; constrained to 8K context. |
| 5 | Llama 4 Scout 17B-16E | MoE 17B/16e + multimodal; 86% precision but no axis it leads against GPT-OSS-20B at higher cost. |
| 6 | Llama 3.1 8B FP | High precision (79%) but most expensive non-reasoning option and 8K context. |
| ❌ | Llama 3.2 11B-V | Does not complete; impervious to copy-instruction feedback. |
| ❌ | Llama 3.2 3B | Regressive, does not complete, 53% command precision. |

## Operational recommendations

1. **Default for production agents driving `db` → Granite 4.0-h-micro.** Cheapest by 5-16×, completes the task, 131K context window.
2. **If round-trip latency matters more than cost → GPT-OSS-20B.** 2 turns vs Granite's 3, with cleaner first-pass syntax. ~6× more expensive than Granite but still mid-tier overall.
3. **If retries are costly (paid API calls, irreversible operations) → Gemma 4 26B-a4b.** 100% command precision means zero retries; pay 16× more per task but lose nothing to redo work. Best when a single bad command costs more than the entire reasoning budget.
4. **If Granite is unavailable → Llama 3.1 8B AWQ.** 4× cheaper than the FP variant for similar completion rate; accept the 8K context cap by keeping sessions short.
5. **Avoid Llama 3.1 8B FP in production.** 2.2× more expensive than AWQ for marginal precision gain, and same 8K context cap.
6. **Llama 4 Scout offers no clear advantage for non-multimodal tasks** — GPT-OSS-20B is faster, cheaper, and more reliable. Pick Scout only if you need image input + agent loop in one model.
7. **Avoid the Llama 3.2 family entirely for this kind of structured tool-use.** Both 3B and 11B-V regress mid-loop to MongoDB shell syntax and resist `$count:1` correction.
8. **Patch the plugin** to accept `$sum: 1` as `$count: 1`. This single change would have moved Llama 3.2 11B-V from 6/7 to 7/7 and shaved ≈1 turn off most other models — only Gemma 4 was already immune.

### Decision flow

```
Is the agent driving cheap, idempotent operations (this case)?
├── yes, cost-sensitive          → Granite 4.0-h-micro  (lowest $)
├── yes, latency-sensitive       → GPT-OSS-20B          (2 turns)
└── no, retries are expensive    → Gemma 4 26B-a4b      (zero errors)

Need vision input?
├── yes → Llama 3.2 11B-V or Llama 4 Scout (latter is more reliable)
└── no  → use the table above

Is the session very long (>50 turns)?
├── yes, max headroom            → Gemma 4 (256K)
├── yes, balance                 → Granite or Llama 4 Scout (131K)
└── no, short bursts             → any except Llama 3.1 8B family
```

## Reproducing this benchmark

The full set of commands emitted by each model is captured under `examples/smoke/`:

```
turn1-cmds.json … turn3-cmds.json                (Granite)
llama-turn1-cmds.json … turn5-cmds.json          (Llama 3.2 3B)
llama8b-turn1-cmds.json … turn4-cmds.json        (Llama 3.1 8B AWQ)
llama8b-fp-turn1-cmds.json … turn4-cmds.json     (Llama 3.1 8B FP)
llama11bv-turn1-cmds.json … turn5-cmds.json      (Llama 3.2 11B-V)
gptoss-turn1-cmds.json … turn2-cmds.json         (GPT-OSS-20B)
llama4scout-turn1-cmds.json … turn4-cmds.json    (Llama 4 Scout)
gemma4-turn1-cmds.json … turn4-cmds.json         (Gemma 4 26B-a4b)
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
