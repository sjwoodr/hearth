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
- **Memory budget: 6-20 GB for the model.** The rest stays free for browser, IDEs, containers, VMs.
  Anything that makes the machine swap is out.
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
| Chat (`HEARTH_MODEL`) | `gemma4:26b-a4b-it-qat` | thinking off, ~1.2 s/answer, ~26 tok/s, 15 GB loaded |
| Thinking (`HEARTH_MODEL_THINKING`) | same model, `think: true` | same model = one copy in memory; a different one loads a second |
| Background (titles, summaries, extraction, duplicate checks) | `HEARTH_MODEL` via `ollamaJson` | never thinks; `format` JSON schema (extraction) or plain text, temperature 0.2 |
| Embeddings (`HEARTH_EMBED_MODEL`) | `embeddinggemma:300m-qat-q8_0` | memory recall and near-duplicate candidates |

Defaults live in `server/config.ts`; `.env` overrides them; the real environment overrides both.
`.env.example` mirrors the defaults and is read by nothing.

## How the model was chosen: the French bench

The bench lives in `~/src/other/french-model-bench` (local git, **no remote**). Its answer key is
generated from Aubemer's private content at run time and is never committed, and must never be
copied into this public repo.

**Rule one: no model writes the answer key.** Sources, strongest first: Aubemer's hand-signed
conjugation golden file (also checked against Morphalou 3.1), Aubemer's noun genders (Morphalou's
gender data was measured unreliable and is not used), Aubemer's authored drills (a model disagreeing
is flagged for review, not auto-failed), and bench-written relative-pronoun items (spot-check them).

```
cd ~/src/other/french-model-bench
~/src/other/aubemer/web/node_modules/.bin/vite-node gen.ts           # quiz.json (158 items)
~/src/other/aubemer/web/node_modules/.bin/vite-node gen-grading.ts   # grading.json (150 right + 150 wrong)
node run.ts [model ...]                  # "+think" suffix enables thinking; results/<label>.json
node budget.ts <model> 50 100 200        # budget-capped thinking on the grading section
QUIZ=grading.json RESULTS=results-grading node run.ts <model>     # keep other quizzes' results apart
```

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

The public write-up is [docs/model-selection.md](docs/model-selection.md) (method, all results, and
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
  the On/Off setting is the override, and a fast reply that corrects itself (`SELF_CORRECTION`) gets a
  "Re-answer with thinking" button.
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
- **`num_ctx` 16384.** Gemma 4's sliding-window attention makes 16k cost ~0.02 GB over 8k; at 8k long
  chats no longer fit, trimming changed the prompt start every turn (~7 s per reply). The summarizer
  scales with it: fold past half the window, keep the newest quarter verbatim.
- **Recall threshold 0.38, top 6.** Measured with embeddinggemma: related 0.44-0.61, unrelated
  0.19-0.30. The first guess (0.45) missed real matches.
- **Near-duplicate memories: embeddings pick candidates (≥0.85), the model decides** with a yes/no
  schema. Similarity alone can't separate rewordings (0.86-0.94) from different facts on one topic
  ("learning French" vs "learning Spanish" 0.886). Any failure keeps the memory.
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
  20-message probe, so small). Leaving `tools` out of a request didn't force a full prompt reread
  (measured ~1.4 s vs 7.6 s cold), so background calls without tools still hit the cache.
- **Free prose from background jobs is plain text, not a JSON schema** (summaries, titles, image
  descriptions: `json(messages, null)`). Under Ollama's `format` grammar, a `"` the model meant to open
  a quotation closes the string, so text was silently cut mid-sentence ("…how the band's" before
  `"engine"`); it clipped a chat summary and two memories. Extraction keeps its schema, with a
  `pattern` (no raw `"`, must end in punctuation) that Ollama enforces. Use the same for new schemas.
- **System prompt** (`prompts/system.md`) is re-read on every message. It tells the model to write
  symbols as plain characters, but Gemma still emitted LaTeX (`$\rightarrow$`) in 3 of 115 replies, so
  `shared/plain-symbols.ts` converts known symbol commands on save and on render. It only touches short
  spans made entirely of known commands, outside code, so dollar amounts and real math survive.

## Code map

| Path | What |
|---|---|
| `server/index.ts` | wiring: config, scheduler, Ollama functions, sweeper, static files |
| `server/app.ts` | Hono app, CSRF, login + throttle, session auth for `/api` |
| `server/chat.ts` | chat routes, `buildPrompt`, NDJSON stream (`start`/`searching`/`queued`/`loading`/`thinking`/`delta`/`done`/`search`/`error`/`title`), search approval route |
| `server/ollama.ts` | `ollamaChat`, `ollamaThinkingChat`, `ollamaJson`, `ollamaEmbed`, `ollamaModelLoaded` (its `/api/ps`, for the loading notice); each takes an `Endpoint` (Ollama's URL, or the gateway's URL + token) and turns gateway queue lines into `onQueued`, its 409 into `PreemptedError` |
| `server/think-router.ts` | Think: Auto rules and `SELF_CORRECTION` |
| `server/memories.ts`, `extract.ts` | recall and background extraction (+ near-duplicate check) |
| `server/summarize.ts`, `titles.ts`, `context.ts` | running summary (`createSummarizer` after each reply; `createSummarySweep` for the worker), model titles, history fitting (char estimate, ~3.5/token) |
| `server/metrics.ts` | Prometheus registry and every metric; `job()`, `recordModelStats()`, scheduler hooks, `zeroCounters()` (api, worker), `watchOllama()` (whoever talks to Ollama); served at `/metrics` |
| `server/health.ts`, `shutdown.ts`, `logging.ts` | `/healthz` + `/readyz` (models reported, never failing readiness); graceful SIGTERM; `HEARTH_LOG_FORMAT=json` |
| `server/worker.ts`, `models.ts` | the worker entry point; shared model wiring (`connectModels`), `backgroundJobs(role)`, the gateway-required check |
| `server/busy.ts` | chat-first model scheduler: `ModelScheduler`, slots, `lease()`, `chat()`, `background()` |
| `server/gateway.ts`, `gateway-main.ts` | the model gateway: Ollama-compatible proxy owning the slots (token, priority headers, queue lines, `preempted`); forwards only chat, generate, embed and read-only lookups (`PASS_THROUGH`), never model management |
| `server/images.ts` | image checks, `PendingImages`, describe requests, `withImageText` for text-only readers |
| `server/web-search.ts` | `web_search` tool, search instructions, SearXNG client, `PendingSearches` |
| `shared/plain-symbols.ts` | LaTeX symbol markup → plain characters; imported by server and client |
| `shared/think-effort.ts` | Think effort levels (Medium/High/Max), labels, `higherEffort` for "Think harder"; budgets from `config.thinkingBudgets` |
| `shared/pending-text.ts` | what the chat shows before a reply's first word (search, queue, thinking, loading, still working); tested in `server/pending-text.test.ts` |
| `server/migrations/NNN_name.sql` | applied in order, tracked in `PRAGMA user_version`; add a new file, never edit an old one. `db.ts`: `migrate`, `checkSchema`; `migrate.ts`: the `pnpm migrate` entry point |
| `.github/workflows/ci.yml` | tests + types on every PR and on main (branches only via PRs, so one run per push); images built on PRs, pushed to GHCR from main (`sha-<short>`, `main`); then `deploy` commits the tag to the GitOps repo (environment `gitops`, main only: deploy key + repo name as secrets). `chart.yml`: the Helm chart (lint, kubeconform, helm unittest) when it changes |
| `Dockerfile.prod`, `compose.services.yml`, `deploy/` | production images (server, web), the multi-service stack, nginx configs for web and the ingress stand-in |
| `deploy/charts/hearth/` | the Helm chart: gateway (hostNetwork), api, worker, web, migrate hook, backup CronJob, optional Prometheus Operator monitors (`metrics.enabled`) and Grafana dashboard (`metrics.dashboard.enabled`, `files/hearth-dashboard.json`), alert rules (`metrics.rules.enabled`); `tests/` (helm-unittest), `ci/test-values.yaml`; never creates the data volume |
| `bruno/` | Bruno API test collection (Bruno 4, OpenCollection YAML): health, auth + CSRF, conversations, memories, one real reply, cleanup; environments `local` and `cluster` (password is a Bruno secret); see `bruno/README.md` |
| `server/cli/` | `bin/hearth` admin console; the **only** place cross-user queries live |
| `server/testing.ts` | `setupApp()`: in-memory DB + scripted fake model for route tests |
| `client/public/` | app icons: `icon.svg` (source: fireplace arch + flame) → `apple-touch-icon.png` (iOS, opaque 180), `icon-192/512.png`, `icon-maskable-512.png`; `favicon.svg` (simplified for 16-32 px) → `favicon.ico`; `manifest.webmanifest` (standalone app). PNGs are rendered from the SVGs with headless Chrome |
| `client/src/ConversationView.tsx` | chat UI, Think toggle and effort (per-browser `localStorage` `hearth.think`, `hearth.effort`), "Show raw" toggle on replies with a code block, "Think harder" |
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
  repo's values; Argo CD rolls it out. Merging a PR is the deploy.
  Every step keeps today's single-process setup working by default. The cluster phases happen in
  the private repo; don't start cluster work in this repo without being asked.
- Backups: the chart's nightly CronJob writes consistent copies next to the cluster's database, and
  the host's encrypted restic job snapshots that live database (`hearth db backup`, SQLite's online
  backup) before each run, because a live SQLite file can't be copied safely. Phone layout check and 2FA before any internet exposure:
  see `TODO.md`.
- Bench models no longer needed are still pulled in Ollama (Mistral Small/Nemo, Ministral, Qwen 3,
  Aya, Gemma 12B, Nemotron); remove them if disk matters.
- **Grading French from a photo is unmeasured.** In the first real run (2026-10-01, typed homework
  image, Think: Auto thought first) the reply called "Tu écoute" correct, while the background
  transcription kept the mistake verbatim. A 3-run probe was mixed (image + thinking caught it 3/3,
  image + transcription + thinking 1/3, text only 3/3), far too small to decide anything. Worth a bench
  section (printed and handwritten photos, right and wrong) before trusting photo grading; if images
  grade worse than text, transcribe first and grade the transcript.
- Every local model invents specifics on niche topics (commands, IDs). hearth's system prompt asks it
  to say when it is unsure; don't trust it for anything you'll act on without checking.
