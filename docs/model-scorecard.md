# Model scorecard

Every model tested for hearth, on one table, so a new candidate is judged against the same numbers.
Add a row (or update one) whenever a model is tested; keep the verdict to one short line.
[model-selection.md](model-selection.md) explains the method and the first round in depth.

**The rule** (owner's, 2026-10-10): a model that is **smaller** than the current one must be
**faster** and within the margin of error on accuracy; a **bigger** one must be **faster and more
accurate**. Speed is what a reply costs on this machine, so a slower model doesn't replace the
current one however well it grades.

## The table

| Model | Type | Loaded | Speed | Thinking | Vision | Quiz /158 | Grading /300, fast | Grading /300, thinking ≤200 | Medium reply | Extraction | Coding /16 | Verdict | Tested |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **`gemma4:26b-a4b-it-qat`** | MoE 26B, ~4B active | 15.8 GB | **25.5** | on/off, cap | yes | 153 (156 thinking) | 286 (5 / 9), 1.2 s | **300 (0 / 0)**, 12.0 s | **17.3 s** | **12/12**, judge 34/36 | 14 / 16, 11 s | **Current: chat and background** | 09-29, 10-10 |
| `gemma4:26b-a4b-it-mtp-q4_K_M` | MoE + MTP draft | ~17.5 GB | 19.0 | on/off, cap | yes | **155** | **291 (3 / 6)**, 1.2 s | 300 (0 / 0), 9.9 s | 18.6 s | — | — | No: bigger and slower; MTP doesn't pay on this iGPU | 10-10 |
| `qwen3.6:35b-a3b` | MoE 35B, ~3B active | 22.1 GB¹ | 25.3 | on/off, cap | yes | 148 | 283 (4 / 13), 1.2 s | 293 (3 / 4), always hit the cap | — | — | — | No: bigger, not faster, less accurate | 10-10 |
| `qwen3-coder:30b` | MoE 30B, ~3.3B active | 22.0 GB | **32.7** | none | **no** | 134 | 221 (54 / 25), 0.7 s | — | — | — | 14 / 16, **7 s** | No: very fast, but a weak grader, and no thinking or vision | 10-11 |
| `qwen3:30b-a3b` | MoE 30.5B, ~3.3B active | 22.0 GB | **34.1** | always (off ignored) | **no** | — | 215 (74 / 11), 0.7 s | — | — | — | 9 / 16 (10 with retry), 113 s | No: fast tokens but reasons at length even with thinking off (into the answer), harshest grader, no vision | 10-11 |
| `gpt-oss:20b` | MoE 21B, ~3.6B active | **12.9 GB** | 19.2 | always (low/med/high) | **no** | 151 at low | 294 (3 / 3) at low, 4.1 s | 280 (3 / 3, 14 empty), 14.3 s, worst 57 s | — | — | **16 / 16**, 13 s (low) | No: smaller but slower; best judge, weaker French | 10-10 |
| `deepseek-r1:14b` | dense 14B | ~9 GB² | 9.0 | always | **no** | — | stopped at 20: ~900 reasoning tokens, ~48 s per answer | — | — | — | — | No: far too slow | 10-11 |
| `aya-expanse:32b` | dense 32B | ~19 GB² | ~3.7 | none | **no** | 138 | 250 (23 / 27), 2.8 s | — | — | — | — | No: slowest and worst grader | 10-11 |
| `gemma4:12b-it-qat` | dense 12B | 7.7 GB | ~10 | on/off, cap | yes | 150 (157 thinking) | 280 (15 / 5), 1.7 s | 40/40 on a 40-item subset, 27 s | — | — | — | Previous model; replaced by the 26B | 09-29 |
| `Nemotron 3.5 30B-A3B` (IQ4_NL) | MoE 30B, ~3B active | 20.3 GB | 23.6 | off | no? | 142 | 268 (12 / 20), 1.4 s | — | — | — | — | No: bigger, slower, and a much weaker grader | 09-29, 10-11 |
| `mistral-small3.2:24b` | dense 24B | ~16 GB | — | none | yes | 141 | — | — | — | — | — | No: weaker grading | 09-29 |
| `ministral-3:14b` | dense 14B | 8.9 GB | — | none | yes | 140 | — | — | — | — | — | No: weaker grading | 09-29 |
| `qwen3:14b` | dense 14B | ~10 GB | — | on/off | **no** | 138 | — | — | — | — | — | No: too harsh (most false corrections) | 09-29 |
| `mistral-nemo:12b` | dense 12B | ~8 GB | — | none | **no** | 135 | — | — | — | — | — | No: a yes-man (most missed errors) | 09-29 |
| `aya-expanse:8b` | dense 8B | ~6 GB | — | none | **no** | 105 | — | — | — | — | — | No: near coin-flip | 09-29 |
| `gemma4:e2b-it-qat` | small, for background | ~4.3 GB² | — | on/off | yes | — | — | — | — | 3/12, judge **36/36** | — | No for extraction: adds instead of updating, saves one-off requests | 10-10 |
| `qwen3.5:4b` | small, for background | ~3.4 GB | — | on/off | yes | — | — | — | — | 0/12, judge **36/36** | — | No for extraction: never updates a memory | 10-10 |
| `ministral-3:3b` | small, for background | ~4.2 GB | — | none | yes | — | — | — | — | 9/12, judge 18/36, 16 unwanted updates | — | No: merges unrelated memories, invents facts | 10-10 |

¹ at 8k context; everything else is at hearth's 32k where measured. ² size on disk (not measured
loaded). Dates are 2026. "—" means not run.

## Cloud models (reference only)

Ollama's cloud models, run through the local Ollama on the free plan's credits: none could run on
this machine, so they are never candidates for hearth. They show how far a bigger model moves the
grading score. Grading only (the quiz holds Aubemer's authored drills, which stay on the machine);
fast mode, gpt-oss at low. Times are Ollama's servers plus the network, not this machine.

| Model | Grading /300, fast | Tokens in / out, 300 items | Cost | Note | Tested |
|---|---|---|---|---|---|
| `gpt-oss:120b-cloud` | **297 (3 / 0)**, 0.4 s | 54k / 16k | ~2¢ | the only fast setup that caught every *tu* form missing its *-s* | 10-13 |
| `gemma4:31b-cloud` (dense 31B) | 289 (2 / 9), 0.3 s | 38k / 2.8k | ~0.5¢ | same *tu* blind spot as the 26B (all 9 misses); barely better than the 26B | 10-13 |
| `nemotron-3-ultra:cloud` | 285 (3 / 12), 0.8 s, worst 100 s | 37k / 1.8k | ~1¢ | rejected textbook *où* and *que*; queued, never refused (no 429s). Super skipped | 10-13 |

The cloud ignores `format`, so these models got the JSON schema in the system prompt as well (one
line the local runs don't have). The whole session (three runs plus checks) used ~2% of a month's
free credits.

## The columns

- **Loaded**: what `ollama ps` reports with the model in memory (`size_vram`). The machine's budget is
  6-20 GB for the model ([CLAUDE.md](../CLAUDE.md)).
- **Speed**: generation tokens per second on one ~300-token French paragraph, model already loaded,
  temperature 0. Memory bandwidth sets it, so it tracks *active* parameters, not total size.
- **Thinking**: whether the model can reason before answering, and whether it can be switched off.
  "cap" means hearth's budget forcing works with it (`HEARTH_THINKING_TOKEN_BUDGET`). A model without
  thinking can't do Think: Auto or the Medium/High/Max efforts.
- **Vision**: whether it reads images (Ollama's `vision` capability). hearth needs it for photos in chat
  and their background description, so **no** rules a model out as the chat model. From `ollama show`,
  or the model's Ollama library page for models no longer pulled; "no?" is unconfirmed.
- **Quiz /158**: stage 1 of the French bench (conjugation, noun gender, drills, relative pronouns,
  grading), fast mode unless noted.
- **Grading /300**: 150 right and 150 wrong learner answers. In brackets, **false corrections** (a
  right answer marked wrong: the error that matters) / missed errors; then the median time per answer.
- **Grading, thinking ≤200**: the same 300 with reasoning capped at 200 tokens (hearth's Medium).
- **Medium reply**: median time for a whole chat reply with Medium thinking, through hearth's own
  thinking code (8 chat messages x 3 runs). The time you actually wait.
- **Coding /16**: `~/src/other/code-model-bench` (local, no remote): 8 AWS Terraform tasks (scored by
  `terraform validate` plus required patterns) and 8 Node/React TypeScript tasks (`tsc --strict` plus
  hidden tests), half writing and half fixing. Shown as passed first try / of 16, then median seconds
  per task. Every model so far passed all 16 after one retry with the error, so the first-try count
  and the time are what separate them; the set is too easy to rank models finely (2026-10-11).
- **Extraction**: the background-model bench, `scripts/bench-extraction.ts`: corrections and
  extensions that landed on the right memory, out of 12, and the yes/no duplicate judge, out of 36.

## Watch list

What has a real chance on this machine, so new releases are worth a test only when they match it:

- **Mixture of experts with ~4B or fewer active parameters.** Memory bandwidth (~90 GB/s shared DDR5)
  sets speed here, so dense models of 12B and up run at ~7-10 tok/s whatever their quality.
- **A soft cap of ~25 GB loaded at 32k** (owner, 2026-10-11): 21-25 GB is still worth a test, since it
  fits fully on the GPU; above that it needs a strong reason. Plus **vision and thinking** (hearth needs both).
  The size rule below still applies: a bigger model than Gemma has to be faster and more accurate.
- **Strong multilingual training**, French above all.
- **Cheap context is a bonus**: sliding-window or hybrid attention keeps the KV cache small. Gemma 4
  grows ~0.5 GB from 16k to 32k; Qwen3-30B-A3B (full attention) ~2 GB (20 → 22 GB). Measure at 32k.

Families to watch: **Gemma** (Gemma 4 came out 2026-04-02, roughly a yearly cadence, so a Gemma 5 MoE
around spring 2027 would fit the pattern) and **Qwen** (Qwen 3.6 35B-A3B was the closest challenger:
MoE with vision, but 22 GB and weaker French; a smaller vision MoE would be worth testing). Coding-only
models (qwen3-coder) and decision models (Kev, Clef) are out for hearth but can go in the coding column.
Generic "best local LLM" lists rank by capacity or quality, not bandwidth, so filter them through
the rules above before testing anything.

## Adding a model

1. `ollama pull` it, then measure **Loaded** and **Speed** at 32k context with the GPU otherwise idle.
2. French bench (`~/src/other/french-model-bench`, private: its answer key never enters this repo):
   `node run.ts <model>` for the quiz, `QUIZ=grading.json RESULTS=results-grading node run.ts <model>`
   for grading, and `node budget.ts <model> 200` with `QUIZ`/`RESULTS` set the same way for thinking.
   For a model that can't turn reasoning off, use `<model>+low`. A cloud model keeps its
   `:cloud`/`-cloud` name, which `run.ts` uses to put the schema in the prompt.
3. If it might take a background job: `node scripts/bench-extraction.ts --models <current>,<model>`.
4. Apply the rule above, add the row, and keep the run's caveats in the verdict or a footnote.
