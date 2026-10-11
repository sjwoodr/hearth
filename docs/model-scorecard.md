# Model scorecard

Every model tested for hearth, on one table, so a new candidate is judged against the same numbers.
Add a row (or update one) whenever a model is tested; keep the verdict to one short line.
[model-selection.md](model-selection.md) explains the method and the first round in depth.

**The rule** (owner's, 2026-10-10): a model that is **smaller** than the current one must be
**faster** and within the margin of error on accuracy; a **bigger** one must be **faster and more
accurate**. Speed is what a reply costs on this machine, so a slower model doesn't replace the
current one however well it grades.

## The table

| Model | Type | Loaded | Speed | Thinking | Quiz /158 | Grading /300, fast | Grading /300, thinking ≤200 | Medium reply | Extraction | Verdict | Tested |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **`gemma4:26b-a4b-it-qat`** | MoE 26B, ~4B active | 15.8 GB | **25.5** | on/off, cap | 153 (156 thinking) | 286 (5 / 9), 1.2 s | **300 (0 / 0)**, 12.0 s | **17.3 s** | **12/12**, judge 34/36 | **Current: chat and background** | 09-29, 10-10 |
| `gemma4:26b-a4b-it-mtp-q4_K_M` | MoE + MTP draft | ~17.5 GB | 19.0 | on/off, cap | **155** | **291 (3 / 6)**, 1.2 s | 300 (0 / 0), 9.9 s | 18.6 s | — | No: bigger and slower; MTP doesn't pay on this iGPU | 10-10 |
| `qwen3.6:35b-a3b` | MoE 35B, ~3B active | 22.1 GB¹ | 25.3 | on/off, cap | 148 | 283 (4 / 13), 1.2 s | 293 (3 / 4), always hit the cap | — | — | No: bigger, not faster, less accurate | 10-10 |
| `gpt-oss:20b` | MoE 21B, ~3.6B active | **12.9 GB** | 19.2 | always (low/med/high) | 151 at low | 294 (3 / 3) at low, 4.1 s | 280 (3 / 3, 14 empty), 14.3 s, worst 57 s | — | — | No: smaller but slower; best judge, weaker French | 10-10 |
| `deepseek-r1:14b` | dense 14B | ~9 GB² | 9.0 | always | — | stopped at 20: ~900 reasoning tokens, ~48 s per answer | — | — | — | No: far too slow | 10-11 |
| `aya-expanse:32b` | dense 32B | ~19 GB² | ~3.7 | none | 138 | 250 (23 / 27), 2.8 s | — | — | — | No: slowest and worst grader | 10-11 |
| `gemma4:12b-it-qat` | dense 12B | 7.7 GB | ~10 | on/off, cap | 150 (157 thinking) | 280 (15 / 5), 1.7 s | 40/40 on a 40-item subset, 27 s | — | — | Previous model; replaced by the 26B | 09-29 |
| `Nemotron 3.5 30B-A3B` (IQ4_NL) | MoE 30B, ~3B active | 20.3 GB | 23.6 | off | 142 | 268 (12 / 20), 1.4 s | — | — | — | No: bigger, slower, and a much weaker grader | 09-29, 10-11 |
| `mistral-small3.2:24b` | dense 24B | ~16 GB | — | — | 141 | — | — | — | — | No: weaker grading | 09-29 |
| `ministral-3:14b` | dense 14B | 8.9 GB | — | — | 140 | — | — | — | — | No: weaker grading | 09-29 |
| `qwen3:14b` | dense 14B | ~10 GB | — | — | 138 | — | — | — | — | No: too harsh (most false corrections) | 09-29 |
| `mistral-nemo:12b` | dense 12B | ~8 GB | — | — | 135 | — | — | — | — | No: a yes-man (most missed errors) | 09-29 |
| `aya-expanse:8b` | dense 8B | ~6 GB | — | — | 105 | — | — | — | — | No: near coin-flip | 09-29 |
| `gemma4:e2b-it-qat` | small, for background | ~4.3 GB² | — | — | — | — | — | — | 3/12, judge **36/36** | No for extraction: adds instead of updating, saves one-off requests | 10-10 |
| `qwen3.5:4b` | small, for background | ~3.4 GB | — | — | — | — | — | — | 0/12, judge **36/36** | No for extraction: never updates a memory | 10-10 |
| `ministral-3:3b` | small, for background | ~4.2 GB | — | — | — | — | — | — | 9/12, judge 18/36, 16 unwanted updates | No: merges unrelated memories, invents facts | 10-10 |

¹ at 8k context; everything else is at hearth's 32k where measured. ² size on disk (not measured
loaded). Dates are 2026. "—" means not run.

## The columns

- **Loaded**: what `ollama ps` reports with the model in memory (`size_vram`). The machine's budget is
  6-20 GB for the model ([CLAUDE.md](../CLAUDE.md)).
- **Speed**: generation tokens per second on one ~300-token French paragraph, model already loaded,
  temperature 0. Memory bandwidth sets it, so it tracks *active* parameters, not total size.
- **Thinking**: whether the model can reason before answering, and whether it can be switched off.
  "cap" means hearth's budget forcing works with it (`HEARTH_THINKING_TOKEN_BUDGET`).
- **Quiz /158**: stage 1 of the French bench (conjugation, noun gender, drills, relative pronouns,
  grading), fast mode unless noted.
- **Grading /300**: 150 right and 150 wrong learner answers. In brackets, **false corrections** (a
  right answer marked wrong: the error that matters) / missed errors; then the median time per answer.
- **Grading, thinking ≤200**: the same 300 with reasoning capped at 200 tokens (hearth's Medium).
- **Medium reply**: median time for a whole chat reply with Medium thinking, through hearth's own
  thinking code (8 chat messages x 3 runs). The time you actually wait.
- **Extraction**: the background-model bench, `scripts/bench-extraction.ts`: corrections and
  extensions that landed on the right memory, out of 12, and the yes/no duplicate judge, out of 36.

## Adding a model

1. `ollama pull` it, then measure **Loaded** and **Speed** at 32k context with the GPU otherwise idle.
2. French bench (`~/src/other/french-model-bench`, private: its answer key never enters this repo):
   `node run.ts <model>` for the quiz, `QUIZ=grading.json RESULTS=results-grading node run.ts <model>`
   for grading, and `node budget.ts <model> 200` with `QUIZ`/`RESULTS` set the same way for thinking.
   For a model that can't turn reasoning off, use `<model>+low`.
3. If it might take a background job: `node scripts/bench-extraction.ts --models <current>,<model>`.
4. Apply the rule above, add the row, and keep the run's caveats in the verdict or a footnote.
