# Model scorecard

Every model tested for hearth, on one table, so a new candidate is judged against the same numbers.
Add a row (or update one) whenever a model is tested; keep the verdict to one short line.
[model-selection.md](model-selection.md) explains the method and the first round in depth.

**The rule** (owner's, 2026-10-10): a model that is **smaller** than the current one must be
**faster** and within the margin of error on accuracy; a **bigger** one must be **faster and more
accurate**. Speed is what a reply costs on this machine, so a slower model doesn't replace the
current one however well it grades.

## The table

| Model | Type | Loaded | Speed | Prompt read¹² | Thinking | Vision | Quiz /158 | Grading /300, fast | Grading /300, thinking ≤200 | Medium reply | Extraction | Coding /16 | Verdict | Tested |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `gemma4:26b-a4b-it-qat` | MoE 26B, ~4B active | 15.8 GB | **25.5** | 355 | on/off, cap | yes | 153 (156 thinking) | 286 (5 / 9), 1.2 s | **300 (0 / 0)**, 12.0 s | **17.3 s** | **12/12**, judge 34/36 | 14 / 16, 11 s | Previous: replaced by the UD build of the same model | 09-29, 10-10 |
| **`hf.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL`**³ | MoE 26B, ~4B active (QAT, mixed precision) | 15.6 GB | 25.6 | **503** | on/off, cap | yes | 154 | 286 (6 / 8), 0.9 s | 299 (1 / 0), 10.1 s | — | 9/9, judge 36/36⁴ | 14 / 16, 11 s | **Current: chat and background**, as the local tag `gemma4-26b-a4b-ud-64k`: ~6% faster than the library build run back to back (25.6 vs 24.1), level on everything else. pi code suite¹¹ 20/24 | 10-21 |
| `gemma4:26b-a4b-it-mtp-q4_K_M` | MoE + MTP draft | ~20 GB⁹ | 19.0 | 400 | on/off, cap | yes | **155** | **291 (3 / 6)**, 1.2 s | 300 (0 / 0), 9.9 s | 18.6 s | 9/9, judge 36/36, but lost 9/48 facts⁹ | **15** / 16, 10.5 s | No: bigger and slower; MTP doesn't pay on this iGPU, and it drops real facts in extraction. The best Gemma at coding, by one task | 10-10, 10-26 |
| `qwen3.6:35b-a3b` | MoE 35B, ~3B active | 22.1 GB¹ | 25.3 | — | on/off, cap | yes | 148 | 283 (4 / 13), 1.2 s | 293 (3 / 4), always hit the cap | — | — | — | No: bigger, not faster, less accurate | 10-10 |
| `qwen3-coder:30b` | MoE 30B, ~3.3B active | 22.0 GB | **32.7** | ~165 | none | **no** | 134 | 221 (54 / 25), 0.7 s | — | — | — | 14 / 16, **7 s** | No: very fast, but a weak grader, and no thinking or vision. pi code suite¹¹ 13/24: tool calls written as text, turns ended after announcing an edit, the big-file fix missed 3/3 | 10-11, 10-27 |
| `qwen3:30b-a3b` | MoE 30.5B, ~3.3B active | 22.0 GB | **34.1** | 315 | always (off ignored) | **no** | — | 215 (74 / 11), 0.7 s | — | — | — | 9 / 16 (10 with retry), 113 s | No: fast tokens but reasons at length even with thinking off (into the answer), harshest grader, no vision | 10-11 |
| `gpt-oss:20b` | MoE 21B, ~3.6B active | **12.9 GB** | 19.2 | 422 | always (low/med/high) | **no** | 151 at low | 294 (3 / 3) at low, 4.1 s | 280 (3 / 3, 14 empty), 14.3 s, worst 57 s | — | — | **16 / 16**, 13 s (low) | No: smaller but slower; best judge, weaker French | 10-10 |
| `deepseek-r1:14b` | dense 14B | ~9 GB² | 9.0 | — | always | **no** | — | stopped at 20: ~900 reasoning tokens, ~48 s per answer | — | — | — | — | No: far too slow | 10-11 |
| `aya-expanse:32b` | dense 32B | ~19 GB² | ~3.7 | — | none | **no** | 138 | 250 (23 / 27), 2.8 s | — | — | — | — | No: slowest and worst grader | 10-11 |
| `gemma4:12b-it-qat` | dense 12B | 7.7 GB | ~10 | 178 | on/off, cap | yes | 150 (157 thinking) | 280 (15 / 5), 1.7 s | 40/40 on a 40-item subset, 27 s | — | — | — | Previous model; replaced by the 26B | 09-29 |
| `Nemotron 3.5 30B-A3B` (IQ4_NL) | MoE 30B, ~3B active | 20.3 GB | 23.6 | 379 | off | no? | 142 | 268 (12 / 20), 1.4 s | — | — | — | — | No: bigger, slower, and a much weaker grader | 09-29, 10-11 |
| `hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q8_K_XL`⁵ | NVIDIA's tune of Gemma 4 E4B, ~4B effective | 6.1 GB | 14.4 | — | on/off, cap | yes | 146 | 264 (17 / 19), 1.0 s | 295 (5 / 0), 13.5 s | — | — | 10 / 16 (15 with retry), 18 s | No: smaller but much slower, and more false corrections than the 26B in both modes | 10-25 |
| `gemma4:e4b-it-q8_0` | small, ~4B effective | 5.9 GB | 14.5 | 438 | on/off, cap | yes | 145 | 263 (17 / 20), 1.1 s | 105/109 (2 / 2), 16.9 s⁸ | — | — | — | No: smaller but slower, and a weak grader without thinking. pi edit suite 15/15, 83 s per task (26B UD 15/15, 38 s)⁶ | 10-22, 10-26 |
| `hf.co/unsloth/LFM2.5-24B-A2B-GGUF:UD-Q6_K_XL`⁷ | MoE 24B, ~2B active | 22.5 GB | 30.2 | — | always (off ignored) | **no** | 154 (thinking) | 287 (7 / 3) thinking, unlimited, ~62 s | stopped: ~25 s per answer⁷ | — | — | 9 / 16 (10 with retry), 119 s | No: fast tokens, but it thinks 1,000-1,800 tokens per answer, so every answer is slow, and with unlimited thinking it grades no better than the 26B in fast mode; no vision | 10-25 |
| `hf.co/unsloth/Qwen3-Coder-Next-GGUF:UD-IQ3_XXS`¹⁰ | MoE 80B, ~3B active (coding) | 29 GB | 21.8 | 201 | none | **no** | — | — | — | — | — | — | No for hearth: bigger, slower, no thinking or vision. pi: edits 15/15, 43 s; lookups 9/12 (ignored the upgrade policy twice), 69 s, the fastest; code suite¹¹ 21/24, big file twice as fast as the UD | 10-27 |
| `nemotron-3.5-bolt:74b-a9b-iq2`¹⁰ | MoE 74B, ~9B active (NVIDIA 2-bit) | 24 GB | 11.1 | 129 | off/on/medium | yes | — | — | — | — | — | — | No: bigger and less than half the speed. pi: edits 15/15, 49 s; lookups 12/12, 204 s | 10-27 |
| `mistral-small3.2:24b` | dense 24B | ~16 GB | — | — | none | yes | 141 | — | — | — | — | — | No: weaker grading | 09-29 |
| `ministral-3:14b` | dense 14B | 8.9 GB | — | — | none | yes | 140 | — | — | — | — | — | No: weaker grading | 09-29 |
| `qwen3:14b` | dense 14B | ~10 GB | — | — | on/off | **no** | 138 | — | — | — | — | — | No: too harsh (most false corrections) | 09-29 |
| `mistral-nemo:12b` | dense 12B | ~8 GB | — | — | none | **no** | 135 | — | — | — | — | — | No: a yes-man (most missed errors) | 09-29 |
| `aya-expanse:8b` | dense 8B | ~6 GB | — | — | none | **no** | 105 | — | — | — | — | — | No: near coin-flip | 09-29 |
| `gemma4:e2b-it-qat` | small, for background | ~4.3 GB² | — | — | on/off | yes | — | — | — | — | 3/12, judge **36/36** | — | No for extraction: adds instead of updating, saves one-off requests | 10-10 |
| `qwen3.5:4b` | small, for background | ~3.4 GB | — | — | on/off | yes | — | — | — | — | 0/12, judge **36/36** | — | No for extraction: never updates a memory | 10-10 |
| `ministral-3:3b` | small, for background | ~4.2 GB | — | — | none | yes | — | — | — | — | 9/12, judge 18/36, 16 unwanted updates | — | No: merges unrelated memories, invents facts | 10-10 |

¹ at 8k context; everything else is at hearth's 32k where measured. ² size on disk (not measured
loaded). ³ Unsloth's quantization of Google's QAT checkpoint, with its more sensitive layers kept at
higher precision. Pulled from Hugging Face, Ollama runs it with a generic template, so thinking and
tool calls aren't separated; it needs its own tag with `RENDERER gemma4` and `PARSER gemma4` (and
Gemma's sampling settings) to match the library model: [deploy/ollama/gemma4-26b-a4b-ud-64k.Modelfile](../deploy/ollama/gemma4-26b-a4b-ud-64k.Modelfile). ⁴ The generic cases only, run side by side
with the current build, which scored the same 9/9 and 35/36 on that run. ⁵ Q8, as the local tag
`nemotron-3.5-bolt-e4b-q8`: like ³ it needs `RENDERER gemma4` and `PARSER gemma4`, or thinking isn't
separated. Loaded is `ollama ps`'s `size_vram`; the file is 9.2 GB. The thinking run's worst answer
(107 s) came while another model was being tested alongside and Ollama swapped them, so its times may
be slightly high; the scores aren't affected. ⁶ `~/src/other/model-bench/agent` (local, no remote; agent-bench until 2026-10-27): pi
changes one value in a Dockerfile, Terraform, Helm, k8s and Actions file, each with a lookalike line
to leave alone; 5 tasks x 3 runs at thinking high (800-token cap), 2026-10-22. ⁷ Liquid AI's
LFM2.5, which can't stop thinking: every score is with thinking (quiz 98 minutes, grading 311). The
thinking ≤200 run was stopped about halfway, as nearly every answer hit the cap and needed a second
request; nothing it could show would change the verdict. Liquid's own Q4_K_M (15.1 GB loaded, 36.9
tok/s) called "Tu écoute la radio" correct after ~9,600 characters of thinking. ⁸ Stopped at 109 of
the 300 answers (the items are shuffled, so it is a fair sample, but too small to tell it from
Nemotron Bolt's 295); 53 of the 109 hit the cap. ⁹ `ollama ps` reports 1.3 GB for this model, which
is wrong. The GPU's own counter (amdgpu GTT) at 32k: 21.5 GB, against 17.0 GB for the UD build, which
`ollama ps` puts at 15.6; so ~20 GB on this table's scale. Extraction run side by side with the UD
build on the generic cases plus the 18 real windows, 3 runs each (2026-10-26): MTP lost 9 of 48 lasting
facts (UD 0), made 10 unwanted updates (UD 4) and kept 61/78 controls clean (UD 70/78); it kept no
noise (0/30, UD 4/30), but a lost fact is the worse error. ¹⁰ Big MoE models at 2-3 bits, tried for pi only (no French run), loaded and timed at 64k through Ollama's API (thinking off; cold prompt reads: Coder-Next 194/s, Nemotron 130/s). Coder-Next as the local tag `qwen3-coder-next-iq3-64k` with the library model's `RENDERER`/`PARSER qwen3-coder` and sampling. model-bench's agent suites, 3 runs per task at thinking high (2026-10-27): the edit suite as in ⁶ (UD 15/15, 38 s, from 10-22), and the lookup suite (find the version an upgrade policy allows for actions/cache, an nginx digest, a Helm chart and the AWS provider, then edit), run with the UD as baseline: UD 12/12 done, 155 s; Nemotron 12/12, 204 s; Coder-Next 9/12, 69 s (actions/cache@v5 against the policy 2 of 3 times, and `~> 5.94.1` for `~> 5.94` once). The grader's "stopped" check flagged 4 Nemotron runs, 3 of them only for a `cd` before read-only commands; the fourth put the bench's fake-tool folder on `PATH`. ¹¹ model-bench's agent code-suite (`~/src/other/model-bench/agent`, 2026-10-27): 8 tasks on a small TypeScript repo, each graded by hidden tests the model never sees, plus scope (only the allowed files changed), safety (no commits, resets, restores or `rm -rf`) and, on the vague task, whether it asked first; 3 runs each, thinking high, 64k tags. Tasks: a rename across files, a new parameter, a bug fix from pasted test output, an edit after a failed one, "make the cache expire faster" (two caches, so it should ask), a failing `npm run check` (fix the cause, not the check), a one-line fix in a 183 KB file, and a follow-up turn that changes the spec. UD 20/24, mean 142 s: never asked on the vague task (0/3, guessed 1-5 minutes, and once changed the other cache too); the big file took 419 s with 3-7 failed calls; one rename ended mid-turn on a tool call written as text. Coder-Next 21/24, 128 s: asked 0/3 too (one lucky guess of the intended 10 minutes, one change to the wrong cache); big file 182 s with no failed calls; one follow-up wrote vitest tests in a `node:test` repo, never ran them and said "Done". qwen3-coder:30b 13/24, 174 s: two runs ended with a tool call written as text (Ollama's parser missed it), two ended after "let me update `src/money.ts`:" with no edit, the big-file fix was missed 3/3 (one run left four scratch scripts behind), and one run used `git restore` on its own edit. No model asked before guessing, in 9 tries; the misses tests would catch (a wrong rename, unrun tests) are the minority. ¹² Prompt read: median tokens per second Ollama took to read prompts of 2,000+ tokens, from its log of every request since 2026-09-03 (hearth chats, benches and pi sessions; a cache hit only reads the part after it). The log doesn't name the model per line, so each line is credited to the last chat model loaded; the bench runs load one model at a time and are clean, the rest may mix a little. Reading slows deeper into a long prompt (the UD read a fresh 15.7k-token pi prompt at 397/s, then a 10k-token README after it at 254/s). Reading is compute-bound, so it tracks active parameters and the kernel more than bandwidth, and on agent work it decides the wall-clock time more than generation speed does: on one pi question ("what is the purpose of this repo?", ~25k tokens read) the UD took 121 s, Coder-Next 185 s and Nemotron 74B 378 s, 65-80% of it reading. The UD reads ~40% faster than the library build of the same model (503 vs 355). Models only run on short French prompts have no figure. Dates are 2026. "—" means
not run.

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
- **Prompt read**: tokens per second reading a prompt (footnote ¹²). Agent harnesses send long prompts
  (system prompt, project notes, every tool result), so this sets their speed more than **Speed** does.
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
- **Coding /16** (retired 2026-10-27: no new rows; pi's agent code suite, ¹¹, replaces it, with a
  Terraform task of its own): the old `code-model-bench`: 8 AWS Terraform tasks (scored by
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
2. French bench (`~/src/other/model-bench/french`, private: its answer key never enters this repo):
   `./bench.sh quiz <model>` for the quiz, `./bench.sh grading <model>` for grading, and
   `QUIZ=grading.json RESULTS=results-grading ./bench.sh budget <model> 200` for thinking.
   For a model that can't turn reasoning off, use `<model>+low`. A cloud model keeps its
   `:cloud`/`-cloud` name, which `run.ts` uses to put the schema in the prompt.
3. If it might take a background job: `node scripts/bench-extraction.ts --models <current>,<model>`.
   For pi (coding agent) use: `~/src/other/model-bench/agent/scenarios/code-suite/run-all.sh --quick - <model>`
   as a screen (~20 min), then the full run (3 per task) if it looks worth it.
4. Apply the rule above, add the row, and keep the run's caveats in the verdict or a footnote.
