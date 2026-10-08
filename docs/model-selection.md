# Model selection: how hearth's model was chosen, and what the measurements changed

*September 2026. How hearth's model and its Think setting were picked by measurement, on the machine
hearth runs on, and which design decisions came out of that testing.*

## Why

When Copilot's web chat added strict daily limits and dropped both its personality and chat history,
I wanted to see whether I could rebuild what I liked about it locally: no limits, a personality I
control, full history, and memory of what we've talked about. My main use turned out to be
**practising French** (I'm also writing [Aubemer](https://aubemer.com), a French-learning RPG), which set
a much higher bar for accuracy than casual chat.

## The hardware

This is a mini PC, not a workstation with a big GPU:

| Part | What it is |
|---|---|
| CPU | AMD Ryzen 9 7940HS (Zen 4, 8 cores / 16 threads) |
| GPU | Integrated Radeon 780M, no dedicated GPU |
| Memory | 64 GB DDR5 (60 usable), shared with the GPU: a 2 GB carve-out plus ~30 GB it can map on demand |
| Software | Ubuntu, Ollama with the iGPU enabled, flash attention, 8-bit KV cache |

The single most useful fact about this machine turned out to be: **memory bandwidth decides
everything.** A model has to read its active weights for every token it writes, so speed tracks how
many parameters are active, not how many the model has in total:

| Model type | Example | Writing speed here |
|---|---|---|
| Dense 27B | Qwen 3.8 27B | ~7.6 tokens/s |
| Dense 12B | Gemma 4 12B | ~10 tokens/s |
| Mixture-of-experts, ~3-4B active | Nemotron 30B-A3B, Gemma 4 26B-A4B | 23-26 tokens/s |

Mixture-of-experts models, which activate only a small slice of their parameters per token, are a big
win on bandwidth-limited hardware like this.

I also set a memory budget: **6-20 GB for the model**, leaving 30-40 GB free for a browser, IDEs,
containers and VMs. Anything that made the machine start swapping was out, however clever it was.

## How the model was chosen

### 1. Quick impressions (and why they weren't enough)

The first rounds were informal: a PR-review experiment with small models, then trying a few chat
models on real questions. These were useful for ruling things out, but one conversation proved how
unreliable impressions are. Asked to quiz me on French relative pronouns (*qui* vs *que*), one model
graded my answers backwards: it marked right answers wrong and wrong ones right, then argued me out
of a correct rule before backing down.

A tutor that is *confidently wrong* is worse than no tutor. So the question became measurable: which
model is most often right, and especially, which one never marks a correct answer wrong?

### 2. A benchmark with a real answer key

The key design rule: **no model gets to write the answer key.** The quiz was generated from
independent, checked sources, most of them from [**Aubemer**](https://aubemer.com), whose French content
is hand-authored and checked against reference data:

| Source | Used for | Why it can be trusted |
|---|---|---|
| Aubemer's hand-checked conjugation table, also verified against **Morphalou 3.1** (a reference lexicon of French word forms from the ATILF/CNRS) | verb forms | two independent sources agree |
| Aubemer's hand-written noun genders | masculine / feminine | measured error-free; Morphalou's own gender data turned out to be unreliable, so it wasn't used for this |
| Aubemer's authored grammar drills | fill-the-gap, agreement | hand-written; a model disagreeing is flagged for review rather than automatically scored wrong |
| A small set of relative-pronoun items (qui / que / dont / où / ce qui / ce que) | the pronouns I was struggling with | textbook cases, spot-checked |

158 questions in five sections: conjugation, gender, drills, relative pronouns, and **grading a
learner's answer** (half right, half wrong). Every model got the identical quiz (fixed random seed),
at temperature 0, one model loaded at a time, overnight. The benchmark itself isn't in this repo,
because its quiz is generated from Aubemer's unpublished content.

The grading section tracked two kinds of error separately, because they do very different damage:

- **False corrections**: marking a *right* answer wrong. This is the dangerous one; it teaches you
  to distrust French you actually know.
- **Missed errors**: accepting a wrong answer. Annoying, but less harmful.

### 3. Results

| Setup | Score (of 158) | False corrections (of 20) | Missed errors (of 20) | Typical time / answer | Memory |
|---|---|---|---|---|---|
| Gemma 4 12B, thinking on | 157 | 0 | 0 | 23 s | 7.7 GB |
| Gemma 4 26B-A4B, thinking on | 156 | 0 | 0 | 11 s | 15 GB |
| **Gemma 4 26B-A4B** | **153** | **0** | 3 | **1.2 s** | 15 GB |
| Gemma 4 12B | 150 | 4 | 3 | 1.7 s | 7.7 GB |
| Nemotron 3.5 30B-A3B | 142 | 3 | 4 | 1.5 s | 20 GB |
| Mistral Small 3.2 24B | 141 | 6 | 5 | 2.4 s | ~16 GB |
| Ministral 3 14B | 140 | 7 | 4 | 1.4 s | 8.9 GB |
| Qwen 3 14B | 138 | 9 | 6 | 1.6 s | ~10 GB |
| Mistral Nemo 12B | 135 | 0 | 14 | 1.1 s | ~8 GB |
| Aya Expanse 8B | 105 | 8 | 13 | 0.9 s | ~6 GB |

The two thinking runs each lost one question to a timeout in the benchmark runner (Node's `fetch`
gives up after 300 s), not to a wrong answer.

What stood out:

- **Knowledge was rarely the problem; judgement was.** Almost every model scored 93-100% on
  conjugation and gender. They separated on *grading* answers.
- **Two opposite ways to be a bad grader.** Qwen 3 14B marked nearly half of the correct answers
  wrong. Mistral Nemo waved through 14 of 20 wrong answers: a yes-man.
- **Being made by a French company didn't help.** All three Mistral models graded worse than both
  Gemmas.
- **The multilingual specialist didn't hold up at small size.** Aya 8B was close to coin-flip on
  gender and grading.
- **A bigger mixture-of-experts model beat thinking on the speed trade-off.** Gemma 4 26B-A4B without
  thinking came within 4 points of the best thinking run at about a twentieth of the wait, and made no
  false corrections in that 20-answer sample. It became hearth's model. (That "zero" didn't survive a
  bigger test; see section 6.)

Before the run, I asked another AI assistant to predict the ranking. It picked Qwen 3 14B to win
(it came 8th) and Aya to exceed expectations (it came last). Its *questions* were good ones, though:
"how much thinking is enough?" and "read the false-correction rate first" both shaped the analysis.

### 4. How much thinking is enough?

Thinking (letting the model reason before answering) was nearly perfect, but slow, and occasionally
ran away: one answer thought for over five minutes. So I tested capping it: let the model reason, stop
it at N tokens, and make it answer with its reasoning so far. On the grading questions, with Gemma 4 12B:

| Thinking budget | Grading correct | Typical wait | Worst wait |
|---|---|---|---|
| none | 33 / 40 | 1.7 s | 2 s |
| 50 tokens | 36 / 40 | 9 s | 10 s |
| 100 tokens | 39 / 40 | 15 s | 18 s |
| **200 tokens** | **40 / 40** | 27 s | **30 s** |
| unlimited | 40 / 40 | 29 s | over 5 min |

A 200-token cap kept all of unlimited thinking's accuracy and removed the runaway cases. Most of the
benefit arrives early; the rest is deliberation. (Worst waits here and below leave out each run's
first answer, which also paid for loading the model.)

### 5. Turning that into a feature: Think: Auto

The data said: answer fast almost always, but think when *correctness of French* is at stake. So hearth
has a three-way setting. On **Auto**, plain rules decide per message: asking to check or correct
French, answering a quiz it just gave, or asking why / for the exceptions in a grammar question turns
thinking on; everything else stays fast. The reply says why ("thought first: checking your French").

It uses rules rather than asking the model to decide, for a reason that only showed up in measurement
(see "Prompt caching" below). Checked against my real chat history, it picked out exactly the French
grammar questions and nothing else.

### 6. Checking the small sample

A zero out of 20 can't rule out a model that wrongly corrects one right answer in seven. So I ran a
grading-only test with **150 correct and 150 wrong learner answers**, each from a different exercise,
built from the same trusted sources (conjugations and noun genders mostly, relative pronouns kept to a
small share). The wrong answers were realistic learner mistakes: another person's verb form, the wrong
tense, the opposite gender. Nouns whose gender is genuinely ambiguous were excluded: people and jobs
that now take either gender (*la maire*, *une élève*), and pairs like *le tour* / *la tour*.

| Setup (fast mode) | False corrections | Missed errors |
|---|---|---|
| Gemma 4 26B-A4B | **5 of 150 (3.3%)**, plausible range 1.1-7.6% | 9 of 150 (6%) |
| Gemma 4 12B | 15 of 150 (10%) | 5 of 150 (3.3%) |

- **The small sample's "zero" was luck.** Gemma 26B marks roughly 1 in 30 correct answers wrong in
  fast mode. Still far better than the 12B's 1 in 10, so the model choice holds; the claim didn't.
- **A systematic blind spot:** 8 of its 9 missed errors were the same mistake, the *-s* missing from a
  *tu* form (*tu écoute*, *tu colle*). They sound identical to the correct forms, and it's one of the
  most common mistakes learners actually make.
- **Genders and relative pronouns: no errors at all.** Every mistake was a conjugation.

This is exactly the case Think: Auto exists for, since grading is when it turns thinking on. So the
same 300 questions went to Gemma 26B with the 200-token thinking cap:

| Setup | Correct | False corrections | Missed errors | Typical wait | Worst wait |
|---|---|---|---|---|---|
| Gemma 4 26B-A4B, fast | 286 / 300 | 5 of 150 | 9 of 150 | 1.2 s | 1.3 s |
| **Gemma 4 26B-A4B, thinking capped at 200 tokens** | **300 / 300** | **0 of 150** | **0 of 150** | 12 s | 14 s |

- **Perfect on all 300.** Zero of 150 isn't proof of zero, but it puts the true false-correction rate
  below about 2.4% with 95% confidence, against 1.1-7.6% in fast mode.
- **The *tu* blind spot is gone:** it caught all 9 missing *-s* answers that fast mode let 8 of through.
- **The cap held:** the worst answer took 14 seconds, and fewer than half even reached the cap.

So Auto's design is backed by the data: answer fast by default, and think briefly exactly when
correctness of French is at stake.

## Other things the measurements changed

- **Prompt caching mattered more than context size.** Ollama reuses its cached conversation up to the
  first thing that changed. hearth originally put recalled memories at the *top* of the prompt, where
  they changed every message, so every reply reread the whole chat: about 22 s on a long chat. Moving
  them next to the newest message brought that to about 1 s. The same finding ruled out a "should I
  think?" model call, which would have evicted the cache.
- **A 16k context window turned out to be nearly free.** Gemma 4 uses sliding-window attention, so 16k
  cost 0.02 GB more memory than 8k. At 8k, long chats no longer fit and trimming changed the start of
  the prompt every turn (~7 s per reply); at 16k, follow-ups start in about a second. Later the model
  was loaded at 32k, to share one copy with an agent harness using the same model at 32k (Ollama
  reloads a model asked for at a different size), while hearth still keeps its prompts to 16k:
  0.5 GB more memory, the same speed.
- **Thresholds were measured, not guessed.** Memory recall uses embedding similarity: related pairs
  scored 0.44-0.61 and unrelated ones 0.19-0.30, so the cutoff went in the gap (0.38). The first
  guess, 0.45, would have missed real matches.
- **Some ideas didn't survive their measurement.** Detecting duplicate memories by similarity alone
  looked easy, but "learning French" vs "learning Spanish" scored as similar as true rewordings. So
  similarity only picks candidates, and the model makes the call. It got 9 of 10 test pairs right,
  and its one miss kept a duplicate rather than losing a fact.

## How it was tested and verified

- **A test suite that runs in seconds**, with fakes for the model so every edge case is controllable:
  failures mid-stream, preempted background jobs, another user trying to read your chats.
- **Deliberately breaking the code to check the tests catch it.** For each important guarantee (users
  can't see each other's data, a retry replaces rather than duplicates, background work yields to
  chat), the code was sabotaged on purpose and the suite had to fail. More than once, a test turned out
  to be passing for the wrong reason and was rewritten.
- **Real-model runs in a headless browser**, not just unit tests. This caught a bug no unit test
  would have: finished replies vanished from the screen because of a React state-update ordering
  mistake.
- **Measuring on the real machine before deciding.** Speeds, memory, cache behaviour and thresholds
  all came from this hardware, not from spec sheets.

## Lessons that apply beyond this project

1. **Decide the answer key before the models see the test.** Otherwise you're measuring agreement with
   another model, not correctness.
2. **Measure the error that hurts, not the average.** A model's total score hid the fact that one of
   them would have "corrected" half my right answers.
3. **Every local model invents specifics on niche topics.** All of them made up commands and IDs for an
   obscure game-server question, just convincingly to different degrees. Check anything you'll act on.
4. **On bandwidth-limited hardware, active parameters are what cost you.** Mixture-of-experts models
   punch far above their speed class.
5. **Thinking helps judgement more than knowledge.** It fixed grading mistakes, but couldn't supply
   exceptions to a grammar rule that the model didn't know.
6. **Small samples lie in both directions.** "0 false corrections out of 20" read as proof and was
   luck: at 150 the same model showed 5. Size the test for the error rate you actually care about.
7. **Be suspicious of neat thresholds.** "Similarity above 0.9 means duplicate" and "a 0.45 recall
   cutoff" both sounded reasonable, and both were wrong once measured.

## Appendix: the 158-question run in detail

### Score by section

| Setup | Conj. | Gender | Drills | qui/que… | Grading |
|---|---|---|---|---|---|
| Gemma 4 12B + thinking | 98% | 100% | 100% | 100% | 100% |
| Gemma 4 26B-A4B + thinking | 100% | 100% | 93% | 100% | 100% |
| Gemma 4 26B-A4B | 98% | 100% | 97% | 100% | 93% |
| Gemma 4 12B | 100% | 100% | 100% | 94% | 83% |
| Nemotron 3.5 30B-A3B | 93% | 100% | 80% | 100% | 83% |
| Mistral Small 3.2 24B | 95% | 100% | 93% | 89% | 73% |
| Ministral 3 14B | 93% | 100% | 90% | 94% | 73% |
| Qwen 3 14B | 98% | 100% | 90% | 94% | 63% |
| Mistral Nemo 12B | 100% | 100% | 93% | 61% | 65% |
| Aya Expanse 8B | 85% | 63% | 77% | 56% | 48% |

Sections: conjugation (40), noun gender (30), drills (30), relative pronouns (18), grading (40).
Scoring ignores capitals, quote marks, apostrophe style and end punctuation; accents count. Two of
Gemma 26B's misses were correct answers given as a full phrase instead of the missing word.

### Time per answer

| Setup | Median | 90th percentile | Worst |
|---|---|---|---|
| Aya 8B | 0.9 s | 1.2 s | 1.7 s |
| Mistral Nemo 12B | 1.1 s | 1.2 s | 1.9 s |
| **Gemma 26B-A4B** | **1.2 s** | 1.3 s | 1.6 s |
| Ministral 3 14B | 1.4 s | 1.6 s | 2.1 s |
| Nemotron 30B-A3B | 1.5 s | 1.7 s | 2.2 s |
| Qwen 3 14B | 1.6 s | 2.1 s | 2.6 s |
| Gemma 12B | 1.7 s | 2.0 s | 2.2 s |
| Mistral Small 24B | 2.4 s | 2.7 s | 3.4 s |
| Gemma 26B + thinking | 11.0 s | 22.5 s | 300+ s |
| Gemma 12B + thinking | 23.0 s | 37.8 s | 300+ s |

Percentiles and worst leave out each run's first answer, which also loaded the model (4-24 s
depending on size).
