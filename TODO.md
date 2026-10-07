# TODO

## Deployment (planned: home k3s cluster; the detailed plan is kept privately)

- [x] Waiting searches in SQLite, so an approval survives a restart and any replica can answer it
- [x] Migrations as their own step (a Job), with the app checking the schema version on start
- [x] Model gateway: Ollama-compatible, slots, reply priority, preemption, user turns, bearer token
- [x] Separate worker process for extraction and summaries (titles and image descriptions stay in the api)
- [x] Health and readiness endpoints, graceful shutdown, JSON logs, a trusted-proxy setting
- [x] `/metrics` (Prometheus) on the api, worker and gateway
- [x] Production images (`Dockerfile.prod`: server and web) and the multi-service stack
- [x] CI pushing the images to GHCR
- [x] CI deploying: commits the new image tag to the GitOps repo after a merge
- [x] Helm chart (`deploy/charts/hearth`; checked in CI)
- [x] Running in the cluster (install, data moved over, then Argo CD)
- [x] Check from a phone on the LAN and one on Tailscale: valid certificate, login, streaming (2026-10-05, iPhone, also over LTE)
- [x] Push to GitHub (the repo is public; nothing secret is committed)

## Gaps worth closing

- [x] **Search past chats.** SQLite FTS5 over messages, from the sidebar and `hearth chats search`.
- [x] **Retry a failed reply.** Regenerate / Retry under the last message.
- [x] **Check the phone layout in a real browser.** Checked on an iPhone: the slide-over chat list
      works, and the composer got a full-width text box on narrow screens.
- [x] **Show when a reply is queued.** Only this server's own model calls are visible, not other
      Ollama clients.
- [x] **Scheduled backups.** The host's nightly restic job (encrypted, off-site) runs
      `hearth db backup <fixed path>` first, because the repo directory is excluded from it and a
      live SQLite file can't be copied safely. Restore: `restic restore`, stop hearth, replace
      `data/hearth.db` and delete its `-wal`/`-shm`.

## Later, if wanted

- [x] Long chats: a running summary replaces the oldest turns. Summaries can blur details (one test
      summary attached a band to the wrong antenna), which is why recent turns stay verbatim.
- [x] Near-duplicate memories: embeddings pick candidates, the model judges them. A fixed similarity
      cutoff doesn't work: different facts on one topic score as high as rewordings.
- [x] Model-written chat titles after the first reply.
- [ ] Per-user personality, or editing the system prompt from the web instead of the file.
- [ ] Users changing their own password or display name from the web (today it's CLI only, by design).
- [x] Web search for current events; the model asks, the user approves each search on a card.
- [ ] Automated front-end tests. Browser checks so far were ad hoc scripts driving headless Chrome with
      playwright-core borrowed from another project.

### Using the embedding model for more

The embedding model can't write replies (it turns text into a vector of meaning), but comparing
vectors is cheap, and it runs apart from the chat model, so it never disturbs the chat model's
slot or cached conversation. Measure each idea before trusting it.

- [ ] **Think: Auto second opinion.** When the keyword rules don't match, compare the message's
      vector (already computed for memory recall) with labelled examples of "needs thinking" and
      "doesn't", and take the nearer. Catches rephrasings the keywords miss, with no cache cost (the
      reason a model-call classifier was ruled out). Measure against `think-router.test.ts`'s
      labelled messages and real history; false "think" costs ~10 s, a miss costs French accuracy.
- [ ] **Search chats by meaning (hybrid).** Today's FTS5 search matches word forms (porter stemming,
      accents ignored) but needs the same word: "antenna" never finds "the dipole on the roof", French
      forms stem poorly, and English never matches French. Embed messages (or exchanges) and merge
      the vector ranking with the keyword ranking, so exact strings (names, numbers, errors) still hit
      and rephrasings, related words and the other language do too.
- [ ] **Recall old conversations, not just facts.** Retrieve the most relevant earlier exchanges for
      a new message, beyond what the running summary keeps. Bigger: it adds prompt tokens, so attach
      them to the newest message only (like recalled facts) to protect the cache.
- [ ] **Group recurring French mistakes** by similarity ("five dropped *-s* on *tu* forms this month")
      to suggest targeted drills.
- [ ] **Ask about a long document.** Today a message is capped at 16,000 characters and prompts to
      16k tokens, so a 67 KB document (~19k tokens) is refused, and even under a raised cap it would
      stay in the chat's history, slowing every later reply and overflowing the summarizer. Instead:
      attach a file, keep it out of the running history, split it into sections, embed them, and
      bring only the sections relevant to each question into the prompt.

## Before exposing hearth to the internet

- [ ] Two-factor login
- [ ] Persist login lockouts in SQLite (they're in memory and reset on restart)
- [ ] Expose hearth only through a separate public entry point on the proxy; internal routes stay
      unreachable from outside
