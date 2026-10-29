# CLAUDE.md

hearth is a private, local chat companion with long-term memory: React + Vite front end, a Hono
backend that Node runs as TypeScript directly, one SQLite file, and Ollama for every model call.
Its main real use is **practising French**, so correctness of French is the bar, not pleasantness.

`README.md` is the full reference for behaviour (memory, context, Think, search, admin CLI, network).
This file is the working knowledge behind it: why things are the way they are, what was measured,
and what not to undo. Read the README section before changing a feature.

## Commands

```
pnpm dev:fullstack     # backend (node --watch) + Vite; http://localhost:5180, /api proxied to :8787
docker compose up      # gateway + hearth (api) + worker in containers (bind mount, host networking; README "In Docker")
docker compose -f compose.services.yml up --build -d   # the production images as services, on :8090 (README)
pnpm test              # vitest, server/**/*.test.ts, seconds; fakes stand in for Ollama
pnpm check-types       # tsc --noEmit
pnpm migrate           # apply pending migrations and exit (hearth also migrates on start unless HEARTH_AUTO_MIGRATE=0)
pnpm gateway           # the model gateway on :11435 (needs HEARTH_GATEWAY_TOKEN); optional for one process
pnpm worker            # memory extraction + summaries in their own process (with HEARTH_ROLE=api + the gateway)
node scripts/bench-slots.ts   # Ollama slot benchmark (1-4 simulated users; results in data/bench/)
node scripts/bench-extraction.ts --models a,b   # background-model bench: extraction, duplicate judge, summaries (data/bench/extraction/)
bin/hearth             # admin console (fzf menus); `bin/hearth help` for subcommands
```

Node 22.18+ runs `server/*.ts` with no build step, so the code must stay **erasable TypeScript**
(`erasableSyntaxOnly`): no enums, namespaces or constructor parameter properties, and imports carry
the `.ts` extension.

## The machine (it shapes every decision)

Mini PC: Ryzen 9 7940HS, **integrated Radeon 780M, no discrete GPU**, 64 GB DDR5 shared with the GPU.

- **Memory bandwidth decides speed.** A model reads its *active* weights per token, so: dense 27B
  ~7.6 tok/s, dense 12B ~10, mixture-of-experts with 3-4B active (Gemma 4 26B-A4B, Nemotron 30B-A3B)
  23-26. Prefer MoE models here.
- **Memory budget: a soft cap of 30 GB for the model** (owner, 2026-10-29; it was 20, then 25). The rest
  stays free for browser, IDEs, containers, VMs. Anything that makes the machine swap is out. The GPU
  may use up to **50 GiB** (`ttm.pages_limit=13107200 ttm.page_pool_size=13107200` on the kernel
  command line, 2026-10-29; the default is half the RAM, ~30 GiB): that's for testing bigger models,
  well above what one should take day to day.
- **Ollama is a systemd service** with drop-ins in `/etc/systemd/system/ollama.service.d/`:
  `OLLAMA_IGPU_ENABLE=1` (without it Ollama ignores the iGPU), `OLLAMA_FLASH_ATTENTION=1`,
  `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_NUM_PARALLEL=2` (in `tuning.conf`).
  **Two slots** (since 2026-10-04; it was one): two requests at once, and hearth's
  `HEARTH_OLLAMA_SLOTS=2` must match. Chosen from `scripts/bench-slots.ts`, written up in
  [docs/ollama-slots.md](docs/ollama-slots.md) (2026-10-04, Ollama
  0.33.3, 16k context, 1-8 simulated users each sending 3 messages in a ~1.3k-token chat; one run
  per cell, so expect noise). The GPU's total is fixed at **~33-36 tok/s** (memory bandwidth);
  slots only split it: one reply ~23 tok/s, two at once ~17 each, four ~11, eight ~5.5. More
  users than slots queue ~12 s per reply ahead (1 slot, 4 users: 40 s median wait); enough slots
  and the first word comes in 1.4-4 s. Each slot costs ~0.33 GB (`ollama ps`: 1 → 15.0 GB,
  2 → 15.3, 4 → 16.4, 8 → 17.7). Two covers the real use: the owner's reply plus background work,
  or two people at once; a third person is rare and waits.
  **Ollama kept every conversation cached at every setting**, even 4 users through 1 slot (later
  messages read their prompt in 1.4 s vs ~4.6 s for a reread). Mechanism unverified. The
  one-slot-era reasoning below ("a classifier call would evict the chat") may be weaker than it
  was; re-measure before relying on that either way. Note Ollama's `prompt_eval_count` is the whole
  prompt even on a cache hit; use `prompt_eval_duration` as the signal.
- First message after the model has been unloaded takes ~16 s to load it.

## Models in use

| Role | Model | Notes |
|---|---|---|
| Chat (`HEARTH_MODEL`) | `gemma4-26b-a4b-ud-64k` | Gemma 4 26B-A4B, Unsloth's UD-Q4_K_XL build of the QAT checkpoint; thinking off, ~0.9 s/answer, ~26 tok/s, 15.6 GB loaded |
| Thinking (`HEARTH_MODEL_THINKING`) | same model, `think: true` | same model = one copy in memory; a different one loads a second |
| Background (titles, summaries, extraction, duplicate checks) | `HEARTH_MODEL` via `ollamaJson` | never thinks; `format` JSON schema (extraction) or plain text, temperature 0.2 |
| Embeddings (`HEARTH_EMBED_MODEL`) | `embeddinggemma:300m-qat-q8_0` | memory recall and near-duplicate candidates |

The chat model is a **local tag**, made with `ollama create gemma4-26b-a4b-ud-64k -f
deploy/ollama/gemma4-26b-a4b-ud-64k.Modelfile` after pulling
`hf.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL`: pulled as is, Ollama gives it a generic
template, so thinking and tool calls aren't separated. It replaced `gemma4:26b-a4b-it-qat` (the same
model, Ollama's library build) after the 2026-10-21 bench: ~6% faster run back to back, level on
everything else ([docs/model-scorecard.md](docs/model-scorecard.md)). The benches below were run on
the library build.

Defaults live in `server/config.ts`; `.env` overrides them; the real environment overrides both.
`.env.example` mirrors the defaults and is read by nothing.

## How the model was chosen: the French bench

The bench lives in `~/src/other/model-bench/french` (model-bench: local git, **no remote**; it
holds every model bench, see its README). Its answer key is
generated from Aubemer's private content at run time and is never committed, and must never be
copied into this public repo.

**Rule one: no model writes the answer key.** Sources, strongest first: Aubemer's hand-signed
conjugation golden file (also checked against Morphalou 3.1), Aubemer's noun genders (Morphalou's
gender data was measured unreliable and is not used), Aubemer's authored drills (a model disagreeing
is flagged for review, not auto-failed), and bench-written relative-pronoun items (spot-check them).

```
cd ~/src/other/model-bench/french
./bench.sh gen                       # quiz.json (158 items) + grading.json (150 right + 150 wrong), from Aubemer
./bench.sh quiz [model ...]          # "+think" suffix enables thinking; results/<label>.json
./bench.sh budget <model> 50 100 200 # budget-capped thinking on the grading section
./bench.sh grading <model>           # the 300 grading answers, into results-grading/
```
`bench.sh` skips with a note when Aubemer isn't next to model-bench (`AUBEMER=` overrides).

Fixed seed, temperature 0, one model loaded at a time, run overnight. Grading scores two errors
separately, and **false corrections are the one that matters**: marking a right answer wrong teaches
the learner to distrust French they know. Missed errors (accepting a wrong answer) are less harmful.

### Stage 1: 158 questions, 10 setups (2026-09-29/30)

| Setup | Score | False corr. /20 | Missed /20 | Median | Loaded |
|---|---|---|---|---|---|
| Gemma 4 12B + thinking | 157 | 0 | 0 | 22.9 s | 7.7 GB |
| Gemma 4 26B-A4B + thinking | 156 | 0 | 0 | 11.0 s | 15 GB |
| **Gemma 4 26B-A4B** | **153** | **0** | 3 | **1.2 s** | 15 GB |
| Gemma 4 12B (previous hearth model) | 150 | 4 | 3 | 1.7 s | 7.7 GB |
| Nemotron 3.5 30B-A3B | 142 | 3 | 4 | 1.5 s | 20 GB |
| Mistral Small 3.2 24B | 141 | 6 | 5 | 2.4 s | ~16 GB |
| Ministral 3 14B | 140 | 7 | 4 | 1.4 s | 8.9 GB |
| Qwen 3 14B | 138 | **9** | 6 | 1.6 s | ~10 GB |
| Mistral Nemo 12B | 135 | 0 | **14** | 1.1 s | ~8 GB |
| Aya Expanse 8B | 105 | 8 | 13 | 0.9 s | ~6 GB |

- Knowledge was rarely the problem (93-100% on conjugation and gender); **grading** separated them.
- Qwen is too harsh, Nemo is a yes-man, the Mistral family graded worse than both Gemmas, Aya 8B is
  near coin-flip. Deferred and not worth it: Aya Expanse 32B (dense, ~6 tok/s), DeepSeek-R1 distill.
- The two thinking runs each lost one item to a **bench bug**: Node's `fetch` gives up at 300 s and
  one unlimited-thinking answer ran longer.

### Thinking budget (Gemma 12B, 40 grading items)

| Budget | Correct | Median | Worst |
|---|---|---|---|
| none | 33/40 | 1.7 s | 2.2 s |
| 50 | 36/40 | 9.2 s | 9.7 s |
| 100 | 39/40 | 15.4 s | 17.5 s |
| **200** | **40/40** | 27.2 s | **29.9 s** |
| unlimited | 40/40 | 29.2 s | 300+ s |

200 tokens keeps all of unlimited thinking's accuracy and removes the runaways. Hence
`HEARTH_THINKING_TOKEN_BUDGET=200`, which is the **Medium** Think effort. High (`_HIGH`, 400) and
Max (`_MAX`, 800) were added 2026-10-05 for harder, non-French questions and are **unmeasured**:
nothing shows they grade French better, and each doubles the worst-case wait. Run `budget.ts` at 400
and 800 on something harder than the grading set before claiming they help.

### Stage 1b: 300 grading answers (150 right, 150 wrong)

| Setup | Correct | False corr. /150 | Missed /150 | Median | Worst (excl. 1st) |
|---|---|---|---|---|---|
| Gemma 4 12B, fast | 280 | 15 (10%) | 5 | 1.7 s | 2.0 s |
| Gemma 4 26B-A4B, fast | 286 | 5 (3.3%, 95% CI 1.1-7.6%) | 9 | 1.2 s | 1.3 s |
| **Gemma 4 26B-A4B, thinking ≤200** | **300** | **0 (under ~2.4%)** | **0** | 12 s | 14 s |

The first answer of each run also pays for loading the model (9-26 s), and the published write-ups'
"worst 26 s" for thinking is that first answer. 143 of the 300 thinking answers hit the 200 cap.

- **The stage-1 "zero false corrections" for the fast 26B was luck.** It is about 1 in 30. The model
  choice stands; the claim does not. (Older comments and README text may still say "no false
  corrections"; that refers to the 20-item sample.)
- Blind spot in fast mode: 8 of its 9 missed errors were a *tu* form missing its *-s* (*tu écoute*).
  Thinking caught all of them. All fast-mode errors were conjugations; genders and pronouns were clean.
- Ambiguous-gender nouns (*la maire*, *une élève*, *le/la tour*) are excluded from the wrong answers.

**Every model tested is on one table: [docs/model-scorecard.md](docs/model-scorecard.md)** (size, speed,
thinking, each bench, extraction, verdict, and the owner's rule for replacing the current model). Add a
row whenever a model is tested. The public write-up is [docs/model-selection.md](docs/model-selection.md) (method, all results, and
the design decisions they led to). Keep it in step when results change. Private, outside the repo:
`~/french-model-report.md` (stage-1 working report, including every miss and answer-key checks; it
quotes Aubemer drill items, so it must not be copied here), `~/linkedin-article.md`,
`~/linkedin-post.txt`, charts `~/hearth-grading-chart.png` and `~/hearth-think-auto.png`.

**Worst-case times:** each bench run's first answer also loads the model (4-26 s). Worst times in
this file and `docs/` leave it out; the older private write-ups and the chart include it (their
"worst 26 s" for thinking is really that load).

## Design decisions that came from measurement (don't undo them)

- **Think: Auto uses keyword rules, never a model call** (`server/think-router.ts`). With one Ollama
  slot, a classifier request would evict the cached conversation and the next reply would reread the
  whole chat. Auto thinks when asked to check/correct/grade French, when answering or disputing a quiz
  hearth just gave, when asked for a French quiz, or for why/exceptions/differences in a French grammar
  question. `aboutFrench` gates each rule so "is it correct that Willie Mays…" stays fast. Checked
  against labelled messages in `think-router.test.ts` and real history. Keyword rules miss rephrasings;
  the On/Off setting is the override, and every fast reply gets a "Re-answer with thinking"
  button (its tooltip calls out a reply that corrected itself, `SELF_CORRECTION`). It was only on
  self-corrections at first; a fast searched answer that put Week 6's date on Week 5 and left out
  the opponent showed fast replies need the one-click retry too (the same question thinking at
  Medium got both right).
- **Budget forcing** (`ollamaThinkingChat`): count reasoning chunks (~1 token each), abort at the
  budget, then call the fast path with the reasoning handed back as a user-role "private notes" message.
  Reasoning is never shown or stored. `thinkingReserve(budget)` (`chat.ts`) holds back `2 × budget + 64`
  tokens of context, for the reply's own effort level (`shared/think-effort.ts`; the budget rides
  in `ChatOptions.thinkingBudget`), so Max can trim more history in a long chat than Medium.
  Reasoning that ends under the budget with no text and no tool call gets the same "answer now" turn
  (it surfaced as "The model returned an empty reply" with Think on). With tools offered, that turn
  adds "or call a tool if you need one": without it, a cut before searching made the model answer
  from memory and invent specifics (searched 1/9 runs; 6/9 with it).
  Keep `tokens++` on its own line (a comment explains why).
- **Keep the prompt start stable for Ollama's cache.** Order: personality, always-remembered memories,
  running summary (all in the system prompt), then history. Recalled facts change every message, so
  they are prepended to the **newest user message in the prompt only**, never stored. Putting them in
  the system prompt made every reply reread a ~7k-token chat (~22 s vs ~1 s).
  **The reply after a searched one rereads most of the chat** (expected, not a bug). Search results
  are in the prompt for one turn only, so the next prompt is shorter mid-history and the cache stops
  matching there. Gemma 4's sliding-window attention (`n_swa = 1024`) means llama.cpp can only resume
  from saved context checkpoints, and the nearest one is often near the start: measured 2026-10-17
  (live, ~6k-token chat, Medium) as ~5.3k tokens reread on both the thinking and the answer call,
  54.8 s vs the usual 24-29 s. One reply, then back to normal. To find where a prompt diverged:
  `journalctl -u ollama` shows `checking checkpoint with [a, b] against N` (N = the first token that
  differs) and `restored context checkpoint (... pos_max = M)` (resumed at M; `prompt eval time`
  is the reread). A large M-to-N gap is this effect; a small N means the system prompt changed.
- **Context: 64k loaded (`HEARTH_NUM_CTX`), 16k used (`HEARTH_CONTEXT_BUDGET`).** The budget is
  what trimming and the summarizer use (fold past half, keep the newest quarter verbatim): at 8k
  long chats no longer fit and trimming changed the prompt start every turn (~7 s per reply), and a
  32k budget lets an unsummarized chat reach ~17k tokens, a 60 s cold reread. The window is 64k only
  to match the agent harnesses' 64k tag of the same model (32k until 2026-10-13): Ollama reloads on
  a `num_ctx` mismatch, so the two evicted each other (5-15 s plus a cold reread). Measured 2026-10-07 with 2 slots: 15.79 GB at 32k
  vs 15.26 at 16k, same tokens/s, and 0.0 s load switching between the tags at the same size. If
  the harnesses' context changes, change `HEARTH_NUM_CTX` with it.
- **Recall threshold 0.38, top 6.** Measured with embeddinggemma: related 0.44-0.61, unrelated
  0.19-0.30. The first guess (0.45) missed real matches.
- **Near-duplicate memories: embeddings pick candidates (≥0.85), the model decides** with a yes/no
  schema. Similarity alone can't separate rewordings (0.86-0.94) from different facts on one topic
  ("learning French" vs "learning Spanish" 0.886). Any failure keeps the memory.
- **Corrections update the memory behind them** (`instructions` in `extract.ts`). A vague memory
  ("drinks Dunkin' coffee ... in a Tervis") led to a wrong reply; the user corrected it, and the old
  wording ("if a new detail changes or extends a memory, update it") updated it in 0 of 10 runs: the
  model added the correction as a second memory instead, so the vague one stayed. "Check for the
  same subject; if one exists, do not add, update it" plus "rewrite the memory behind a correction"
  updated it 5/5 (probe) and 3/3 (end to end), with 0 updates in 15 control runs on ordinary chats
  (2026-10-10, live history, fast mode). Updates run longer, so `MAX_MEMORY_CHARS` went 300 → 400:
  4 of 5 rewrites were 300-343 characters and would have been silently dropped; asking for "under
  300" made the model drop details (the tea) or overshoot anyway. The duplicate add of the same
  correction still survives about 2 runs in 3 (the yes/no judge errs to keep); harmless, as both agree.
- **Every new memory must be something the user said about themselves** (`statedByUser` in
  `extract.ts`): a yes/no check per addition, before the duplicate check. A lone lookup ("who is the
  Jaguars' quarterback?") became "interested in the Jaguars" in 3 of 20 extractions of that real chat
  (live history, 2026-10-11); a rule in the main prompt left it at 1 in 5. With the check: 0 of 20, the
  generic suite unchanged (real facts and "I'm a Bears fan" kept, corrections still update), and the
  duplicate add of a correction stopped appearing. Trade-off: interests implied only by questions are
  dropped too (a Diablo comparison chat no longer adds "interested in Diablo 4"). Updates aren't checked;
  any failure keeps the memory.
- **Every memory must last beyond the day** (`isLasting` in `extract.ts`): a yes/no on the memory text
  alone (short and cheap), for additions (before `statedByUser`) and updates (a fleeting rewrite leaves
  the old memory). Live memories included "is currently watching UCF vs. BYU, tied 24-24", "going to a
  game tonight" (with the seat numbers), "notes it is still dark at 6:30 am", and a score hearth got wrong
  ("BYU won 28-24") that a later, unchecked update padded with play-by-play. Measured 2026-10-25 on 18
  real extraction windows rebuilt from the live history (`data/bench/extraction-lasting.json`, private),
  live UD model: noise kept 21/45 before, **6/100** after (the rest: "lives in Florida, where it is still
  dark at 6:30", and one about where free tickets come from); lasting facts lost unchanged and none by the
  check (20 runs with `dropped` counts: the misses were facts the extractor never proposed); the generic
  suite unchanged (updates 30/30, judge 120/120). On all 79 live memories x3 the check flagged exactly the
  six bad ones every time, plus one good one (about a phone's battery) once in 219. Two wording lessons:
  "if part of it is lasting, answer true" let mixed memories through ("a hockey fan **attending a game
  tonight**", 10/10), and a stricter "mixed means false" dropped good ones; what fixed it was the
  extraction prompt line "leave out what only matters on the day" (mixed memories stopped being written).
  Without "stories from their past" the check dropped "his wife met a famous ballplayer" 3/3. The bench's
  `expect.keep`/`expect.avoid` regexes score this; keep both rates, and treat a lost fact as the worse error.
- **Extraction never creates `profile` memories and never deletes.** The model turned "keep this reply
  short" into a standing preference, so only the user promotes a fact to profile.
- **Chat goes first** (`server/busy.ts`). Every model call goes through the scheduler, which hands
  out Ollama's slots (`HEARTH_OLLAMA_SLOTS`, which **must equal `OLLAMA_NUM_PARALLEL`**: more and
  Ollama queues out of sight, so a reply can wait behind background work). A reply takes a free slot,
  else preempts a background call, else waits (`onQueued` → the `queued` event), with turns between
  users. Background jobs use `model.background(...)`, only start when no reply is waiting, and fail
  with `PreemptedError` when preempted; they write nothing and retry later (extraction skips its
  15-minute failure backoff for preemption). One waiting over 10 minutes runs next, unpreempted.
  Add new background model work the same way, never by calling `ollamaJson` directly. Reply text is
  queued to the client, not awaited, so a slow or stalled client can't hold a slot.
- **Images are never stored** (owner's call): the model sees an image on its own turn, then a
  background job (`describeWaitingImages` in `images.ts`) writes a transcription + description to
  `messages.image_note`, and that stands in for it from then on. Undescribed images live only in
  `PendingImages` (server memory). Don't add a BLOB or file store, and don't keep images in history:
  ~260 tokens each, every turn. The describe request continues the just-answered prompt so it hits
  Ollama's cache; keep it that way.
- **Web search is asked for by the model and approved by the user, per search** (owner's call:
  the card, not a checkbox). The tool is offered on every reply, but a tool call only stores a
  `PendingSearch` (a `pending_searches` row, so it survives restarts) and sends a `search` event;
  `POST /conversations/:id/search` with `approve: true` is the only path to the search engine. Keep
  it that way for any future tool that reaches outside the machine. Results are seen on one turn only; the DB keeps links (`messages.sources`), never
  result text. Without today's date and a firm "call the tool instead of saying you can't check",
  Gemma 4 called it for 1 of 10 questions that needed it (9/10 with, 0 false calls in 10; a
  20-message probe, so small). The last line ("this season", "latest", "next" mean the current
  year) was added after a 2026-10-06 probe (fast mode, 4 runs per question): "what's the latest
  iPhone model?" searched 1/4 without it, 4/4 with; the Bears' and Formula 1 schedules already
  searched 8/8 (7 naming 2026, none a stale year), and named 2026 in 8/8 with it. **Recommendations
  search first** (2026-10-17, owner's call): from memory, 31% of 130 recommended names (bands, albums,
  games) didn't exist and every niche-music reply had one; the paragraph "call web_search before
  answering, even if you think you know some" took searching from 0/50 to 47/50 (fast and Medium).
  A softer "unless you are certain" did nothing (2/50), so don't add that escape back without a
  probe. Cost: 4 of 25 controls searched needlessly, all famous lists (Beatles albums, Puccini).
  Known leftover: queries sometimes gain "2026" ("underrated shoegaze bands 2026") from the
  current-year line. Probe script and results were ad hoc (scratchpad), not committed; **cap the
  rate of any bulk SearXNG checking** (~50 quick queries got the home IP rate-limited by Brave,
  Google and DuckDuckGo, which took hearth's search down too). Leaving `tools` out of a request didn't force a full prompt reread
  (measured ~1.4 s vs 7.6 s cold), so background calls without tools still hit the cache.
- **Free prose from background jobs is plain text, not a JSON schema** (summaries, titles, image
  descriptions: `json(messages, null)`). Under Ollama's `format` grammar, a `"` the model meant to open
  a quotation closes the string, so text was silently cut mid-sentence ("…how the band's" before
  `"engine"`); it clipped a chat summary and two memories. Extraction keeps its schema, with a
  `pattern` (no raw `"`, must end in punctuation) that Ollama enforces. Use the same for new schemas.
- **The model can be switched by an admin, for everyone** (`server/active-model.ts`,
  `model-routes.ts`; owner's call, 2026-10-11, "just for fun"). One model fits in memory, so the switch
  is server-wide, stored in `settings` (api and worker share the DB; 2 s read cache), and every model
  call resolves the name per call (`ModelName` in `ollama.ts`). Capabilities come from Ollama's
  `/api/show`: no `vision` → images refused, no `thinking` → fast, no `tools` → no web search.
  **Memory extraction pauses** on a non-default model (the small-model bench showed weaker models
  merge and invent memories), and `startModelReverter` (in whichever process extracts memories)
  returns to `HEARTH_MODEL` once Ollama has unloaded the other model **and** it's been unused 5 min;
  both conditions, because right after a switch the new model isn't loaded yet. gpt-oss can't turn
  reasoning off, so "fast" sends it `think: "low"` (`fastThink`). Other users learn of a switch from
  `X-Hearth-Model` on their next request; no push channel (an occasional poll is a TODO). Admin is
  `users.role`, granted only by `bin/hearth users role`.
- **Private chats write nothing** (`server/private-chat.ts`, the `/private/:chatId` routes in
  `chat.ts`; owner's call, 2026-10-28). The browser holds the transcript and sends it whole each
  turn; the routes build the prompt with the same `assemble()` as stored chats and stream through the
  same `streamReply`, with a `ReplyTarget` whose `save` does nothing. So: no extraction, summary,
  title, image description or search index, and nothing in backups. Search stays on (owner: it is
  still an explicit choice per search); its waiting request is in memory (`PrivateSearches`, 1 h),
  never `pending_searches`. Recall still reads memories. Replies end with their connection
  (`endsWithConnection`): nothing can catch up on them. Keys are per user (`private:<user>:<id>`).
  `private-chat.test.ts` diffs every table before and after; keep that test for anything new on
  this path, and never add a log line with message text.
- **Questions and length are capped in the system prompt, and length again per message** (2026-10-28). Replies ending with a question
  climbed from 27% (before 2026-10-10) to 44-48% after the warmer personality ("enjoys talking with
  this person", "be interested in them") and **80%** in the first full week on the UD build, with
  replies ~9x the length of the message they answered (live weekly numbers: `bin/hearth chats stats`,
  run in the cluster). Probe on the live UD model, 9 short chat openers and follow-ups x5 plus 3
  French-practice cases x5, fast mode with the search tool offered: the old prompt ended 69% of chat
  replies with a question, the new lines ("Don't end replies with a question by habit…", "Match their
  length…") 11%, median 71 → 64 words; one case where a question is natural (getting back into ham
  radio) still asked 4/5, and every French quiz still posed its question (often as "Translate…"). The
  long replies deep in real discussions weren't reproduced, so the length line is unmeasured there:
  watch `chats stats`. If chats start to feel like dead ends, soften "often the best ending is simply
  your last thought" before removing the line. Probe script was ad hoc (scratchpad), not committed.
  **The length line alone didn't shorten real chats, so a reminder rides on the newest message**
  (`REPLY_LENGTH` in `chat.ts`, with recall: prompt only, never stored). The owner's real 34-turn chat
  (a job vent, replayed locally at 9 turns x3, plus 6 explain/how-to/quiz requests x3) still got
  ~1,250-character, 3-4 paragraph replies to one-line messages under the new system prompt; a firmer
  system-prompt line ("one paragraph, under about 80 words") barely moved it (~1,000). A blunt
  reminder ("reply at about the length of this message") cut casual turns to ~300 but also cut
  explanations 60-75% (a passé composé vs imparfait explanation ~1,800 → ~500), so it was rejected.
  The shipped wording, with "if it asks you to explain, teach, compare or give steps, answer fully",
  kept explanations, how-tos and comparisons at the old length and took casual turns to ~560-870
  (1-2 paragraphs), question endings 2 of 15. Known quirk: "what can i do" reads as asking for steps
  and came out longer (~2,200). If explanations start coming back short, the exemption list is the knob.
- **Retitling asks "does it still fit?" first, then writes a title** (`server/retitle.ts`, 2026-10-28,
  owner's request: a first title from an unrelated opener stuck for good). Probe on the live UD model
  (ad hoc, scratchpad): 5 synthetic chats that stayed on topic, 5 that drifted (a cron question that
  became a job vent, "hi" that became a garden bed), and the 9 dev-copy chats with 4+ messages, x3-5.
  Three single-call wordings failed: the last 12 messages plus the summary renamed a 192-message
  French-music chat after its last dozen messages about cars ("weigh the summary as much" didn't help);
  the user's side of the whole chat with "KEEP or a new title" reworded a fitting title ("Chicago Bears
  Schedule" → "...Performance") 3/3; adding "never reword a title that fits" kept 3 of 5 drifted chats.
  The yes/no check then a title: 25/25 kept, 25/25 retitled (5 runs), and 4 of the 9 dev chats renamed,
  each of which really had wandered ("Memory Test Regarding Chris" → "AI Capabilities and Memories").
  Only the user's messages go in: replies are long and repeat the topic. Existing chats start at
  `title_checked_through_message_id = 0` (migration 011), so each is checked once after the deploy.
  **That first live pass renamed 16 of ~40 chats, and 9 got worse**: chats with two real subjects
  became "A and B" grab-bags ("Guide to Belgian Ales" → "Beer, Cocktails, and AI Development"; the
  old titles are in the 2026-10-28 03:15 backup). Fix (same day): the check asks whether the title names
  *one of the chat's main subjects* and says no only for a passing start (a greeting, a one-off
  question); the title names one subject, no "and"; and `sameSubject` keeps the old title when the new
  one shares a real word with it (the check still said no for "Belgian Ales" and the model still wrote
  "French Music and Cars"). Re-probed x5 with 4 two-subject chats modelled on the bad renames and 4
  opener-only ones modelled on the good ones: on-topic 25/25 kept, two-subject 20/20 kept, opener-only
  20/20 renamed, full drifts 22/25 (a cron question that became a job vent stayed "Cron Job Setup"
  3/5: the safe way to be wrong). Next real signal: the renames after the next live pass.
- **System prompt** (`prompts/system.md`) is re-read on every message. It tells the model to write
  symbols as plain characters, but Gemma still emitted LaTeX (`$\rightarrow$`) in 3 of 115 replies, so
  `shared/plain-symbols.ts` converts known symbol commands on save and on render. It only touches short
  spans made entirely of known commands, outside code, so dollar amounts and real math survive. The same pass drops
  gpt-oss's own citation marks (`【5†source】`, from its trained browsing tool): sources show as chips.

## Code map

| Path | What |
|---|---|
| `server/index.ts` | wiring: config, scheduler, Ollama functions, sweeper, static files |
| `server/app.ts` | Hono app, CSRF, login + throttle, session auth for `/api` |
| `server/chat.ts` | chat routes (stored and `/private`), `buildPrompt` + `assemble`, `ReplyTarget` (where a reply is saved, or not), NDJSON stream (`start`/`searching`/`queued`/`loading`/`thinking`/`delta`/`done`/`stopped`/`search`/`error`/`title`), search approval route, `POST /stop` |
| `server/active-replies.ts` | replies being written, per chat (in memory): a reply outlives its connection, so Stop, the 409 busy check and `replying` (catch-up after a dropped stream) go through it |
| `server/ollama.ts` | `ollamaChat`, `ollamaThinkingChat`, `ollamaJson`, `ollamaEmbed`, `ollamaModelLoaded` (its `/api/ps`, for the loading notice); each takes an `Endpoint` (Ollama's URL, or the gateway's URL + token) and turns gateway queue lines into `onQueued`, its 409 into `PreemptedError` |
| `server/think-router.ts` | Think: Auto rules and `SELF_CORRECTION` |
| `server/active-model.ts`, `model-routes.ts` | the admin's model switch: `createModelChoice` (settings row, per-call resolve), `revertIfIdle`/`startModelReverter`; `GET /models`, `PUT`/`DELETE /model`, `requireAdmin` |
| `server/memories.ts`, `extract.ts` | recall and background extraction (+ lasting, stated and near-duplicate checks) |
| `server/retitle.ts` | a new title for a quiet chat that moved on from its first one (yes/no fit check, then a title); runs beside extraction |
| `server/summarize.ts`, `titles.ts`, `context.ts` | running summary (`createSummarizer` after each reply; `createSummarySweep` for the worker; `contextUse` for the title bar's % meter, `client/src/ContextMeter.tsx`; `summary_folds` + `listFolds` for the line each fold leaves in the chat), model titles, history fitting (char estimate, ~3.5/token) |
| `server/metrics.ts` | Prometheus registry and every metric; `job()`, `recordModelStats()`, scheduler hooks, `zeroCounters()` (api, worker), `watchOllama()` (whoever talks to Ollama); served at `/metrics` |
| `server/health.ts`, `shutdown.ts`, `logging.ts` | `/healthz` + `/readyz` (models reported, never failing readiness); graceful SIGTERM; `HEARTH_LOG_FORMAT=json` |
| `server/worker.ts`, `models.ts` | the worker entry point; shared model wiring (`connectModels`), `backgroundJobs(role)`, the gateway-required check |
| `server/busy.ts` | chat-first model scheduler: `ModelScheduler`, slots, `lease()`, `chat()`, `background()` |
| `server/gateway.ts`, `gateway-main.ts` | the model gateway: Ollama-compatible proxy owning the slots (token, priority headers, queue lines, `preempted`); forwards only chat, generate, embed and read-only lookups (`PASS_THROUGH`), never model management |
| `server/images.ts` | image checks, `PendingImages`, describe requests, `withImageText` for text-only readers |
| `server/web-search.ts` | `web_search` tool, search instructions, SearXNG client, `PendingSearches` |
| `server/private-chat.ts` | private chats: history parsing and limits from the browser, `PrivateSearches` (in memory) |
| `shared/plain-symbols.ts` | LaTeX symbol markup → plain characters, gpt-oss citation marks dropped; imported by server and client |
| `shared/think-effort.ts` | Think effort levels (Medium/High/Max), labels, `higherEffort` for "Think harder"; budgets from `config.thinkingBudgets` |
| `shared/time-gap.ts` | a break between two messages in words (3 h or more): the model's pause note (`server/pause.ts`) and the chat's "4 days later" divider |
| `shared/pending-text.ts` | what the chat shows before a reply's first word (search, queue, thinking, loading, still working); tested in `server/pending-text.test.ts` |
| `server/migrations/NNN_name.sql` | applied in order, tracked in `PRAGMA user_version`; add a new file, never edit an old one. `db.ts`: `migrate`, `checkSchema`; `migrate.ts`: the `pnpm migrate` entry point |
| `.github/workflows/ci.yml` | tests + types on every PR and on main (branches only via PRs, so one run per push); images built on PRs, pushed to GHCR from main (`sha-<short>`, `main`); then `deploy` commits the tag to the GitOps repo (environment `gitops`, main only: deploy key + repo name as secrets). `chart.yml`: the Helm chart (lint, kubeconform, helm unittest) when it changes |
| `Dockerfile.prod`, `compose.services.yml`, `deploy/` | production images (server, web), the multi-service stack, nginx configs for web and the ingress stand-in |
| `deploy/charts/hearth/` | the Helm chart: gateway (hostNetwork), api, worker, web, migrate hook, backup CronJob, optional Prometheus Operator monitors (`metrics.enabled`) and Grafana dashboard (`metrics.dashboard.enabled`, `files/hearth-dashboard.json`), alert rules (`metrics.rules.enabled`); `tests/` (helm-unittest), `ci/test-values.yaml`; never creates the data volume |
| `deploy/k8s/` | the chart's deployment as plain manifests for single-node k3s (numbered files, migrate Job run by hand first, Secret by `kubectl`); for learning and the article series. Image tags are pinned per file: bump them with the chart's when they matter |
| `bruno/` | Bruno API test collection (Bruno 4, OpenCollection YAML): health, auth + CSRF, conversations, memories, one real reply, cleanup; environments `local` and `cluster` (password is a Bruno secret); see `bruno/README.md` |
| `server/cli/` | `bin/hearth` admin console; the **only** place cross-user queries live (including `chats stats`, weekly reply metrics) |
| `server/testing.ts` | `setupApp()`: in-memory DB + scripted fake model for route tests |
| `client/public/` | app icons: `icon.svg` (source: fireplace arch + flame) → `apple-touch-icon.png` (iOS, opaque 180), `icon-192/512.png`, `icon-maskable-512.png`; `favicon.svg` (simplified for 16-32 px) → `favicon.ico`; `manifest.webmanifest` (standalone app). PNGs are rendered from the SVGs with headless Chrome |
| `client/src/ConversationView.tsx` | chat UI, Think toggle and effort (per-browser `localStorage` `hearth.think`, `hearth.effort`), "Show raw" toggle on replies with a code block, "Re-answer with thinking" (fast replies), "Think harder" (thinking ones) |
| `client/src/Markdown.tsx` | message Markdown (user messages keep line breaks via `remark-breaks`), code blocks with language + Copy (clipboard API, `execCommand` fallback off HTTPS); `rehype-highlight` is lazy-loaded on the first code fence (54 KB gzip, would be +45% on the main bundle) |

## Invariants

- **Every web query is scoped to the logged-in user** (`user_id` on conversations, messages and
  memories, including recall). Tests deliberately try to read across users; keep that coverage for
  anything new. Unscoped queries belong in `server/cli/` only.
- **Public repo.** The real domain, hostnames, Cloudflare token and `.env` stay local. `data/` (the
  database) is gitignored.
- **Ollama stays on 127.0.0.1:11434**; the backend listens on 127.0.0.1 behind a reverse proxy.
  `resolveClientIp` (`server/client-ip.ts`) believes `X-Forwarded-For` only from
  `HEARTH_TRUSTED_PROXIES` (loopback by default) and takes the rightmost untrusted hop, so a
  client can't fake its address; behind an ingress, add the pod network, or every client shares
  one login-throttle bucket.

## Testing practice

- Unit/route tests use fakes (`server/testing.ts`, a fake Ollama HTTP server in `thinking.test.ts`),
  so every edge case is scriptable: mid-stream failure, preemption, cross-user reads.
- **Mutation-check important guarantees**: sabotage the code on purpose and confirm the suite fails.
  More than one test here was found passing for the wrong reason that way. **Do it in a `git
  worktree`, never in the working tree**: the owner's dev server runs `node --watch` on it, and a
  restart wipes in-memory state (waiting searches, undescribed images) mid-use.
- **Real-model checks in a headless browser**, not just unit tests. They caught finished replies
  vanishing from the screen (a React state-update ordering bug). There is no committed front-end test
  harness yet; the browser checks so far were ad hoc playwright-core scripts.
- Measure on this machine before deciding speeds, memory, cache behaviour or thresholds, and size a
  test for the error rate you care about (0 of 20 cannot rule out 1 in 7; 0 of 150 rules out ~1 in 50).

## Open threads

- Stage 2 of the model evaluation, not started: a blind side-by-side on explanations, idioms, tu/vous
  register, translation, correcting a paragraph with planted mistakes, and a clean control paragraph
  to catch invented "mistakes". Bench runs are temperature 0; hearth chats at Ollama's default, so
  real chats vary more.
- **Deployment is planned on the owner's home k3s cluster**, as a learning project; the plan lives in
  a private repo outside this one, because it holds real hostnames. The deployment items in `TODO.md`
  follow it. **Phase 1 (this repo) is done**, including the slot-count benchmark (2 slots kept): waiting searches in
  SQLite, migrations as a step (`pnpm migrate`, `HEARTH_AUTO_MIGRATE=0`), the slot-aware scheduler
  (`busy.ts`), the gateway (`gateway.ts`) and hearth as its client (`HEARTH_GATEWAY_URL`), the worker
  (`pnpm worker` with `HEARTH_ROLE=api`; titles and image descriptions stay in the api), trusted
  proxies, health endpoints, graceful shutdown, JSON logs, `/metrics`, production images
  (`Dockerfile.prod`), the multi-service stack (`compose.services.yml`) and CI pushing to GHCR.
  **Phase 5: hearth now runs in the cluster** (from this chart, deployed by Argo CD from the private
  repo), and that instance is the live one with the real data since 2026-10-04. **The local
  database is a development copy** (`.env` points `HEARTH_DB_PATH` at `data/dev.db`), so
  `pnpm dev:fullstack`, the dev compose stack and `bin/hearth` on the host all work on the dev
  copy; admin tasks for the real instance run in the cluster
  (`kubectl -n hearth exec -it deploy/hearth-api -- bin/hearth ...`). A new version reaches the
  cluster when CI's `deploy` job (after a merge to main) commits the new image tag to the private
  repo's values; Argo CD rolls it out. A push to main is the deploy (no PRs since 2026-10-10).
  Every step keeps today's single-process setup working by default. The cluster phases happen in
  the private repo; don't start cluster work in this repo without being asked.
- Backups: the chart's nightly CronJob writes consistent copies next to the cluster's database, and
  the host's encrypted restic job snapshots that live database (`hearth db backup`, SQLite's online
  backup) before each run, because a live SQLite file can't be copied safely. Phone layout check and 2FA before any internet exposure:
  see `TODO.md`.
- Bench models no longer needed may still be pulled in Ollama; the scorecard's verdicts say which
  ones failed. Remove them if disk matters.
- **Grading French from a photo is unmeasured.** In the first real run (2026-10-01, typed homework
  image, Think: Auto thought first) the reply called "Tu écoute" correct, while the background
  transcription kept the mistake verbatim. A 3-run probe was mixed (image + thinking caught it 3/3,
  image + transcription + thinking 1/3, text only 3/3), far too small to decide anything. Worth a bench
  section (printed and handwritten photos, right and wrong) before trusting photo grading; if images
  grade worse than text, transcribe first and grade the transcript.
- **A memory can carry a claim hearth made.** `statedByUser` judges a memory as a whole, so in "was
  rooting for UCF, but BYU won 28-24" the rooting passed and hearth's wrong score rode along. `isLasting`
  removes this case (a game's result is a one-day fact) but not the class: a lasting memory with a detail
  only hearth said would still pass. It didn't reproduce in the 5 baseline runs of each real window, so it is rare;
  a fix would be a narrower check ("is every detail something the user said?"), measured first.
- Every local model invents specifics on niche topics (commands, IDs). hearth's system prompt asks it
  to say when it is unsure; don't trust it for anything you'll act on without checking.
