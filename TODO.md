# TODO

## Deployment (planned: home k3s cluster; the detailed plan is kept privately)

- [x] Waiting searches in SQLite, so an approval survives a restart and any replica can answer it
- [ ] Migrations as their own step (a Job), with the app checking the schema version on start
- [ ] Model gateway: Ollama-compatible, slots, reply priority, preemption, user turns, bearer token
- [ ] Separate worker process for extraction, summaries and titles
- [ ] Health and readiness endpoints, graceful shutdown, JSON logs, a trusted-proxy setting
- [ ] Production images and CI pushing to GHCR
- [ ] Helm chart
- [ ] Check from a phone on the LAN and one on Tailscale: valid certificate, login, streaming
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
- [ ] Web search for current events; the local model knows nothing recent.
- [ ] Automated front-end tests. Browser checks so far were ad hoc scripts driving headless Chrome with
      playwright-core borrowed from another project.

## Before exposing hearth to the internet

- [ ] Two-factor login
- [ ] Persist login lockouts in SQLite (they're in memory and reset on restart)
- [ ] Expose hearth only through a separate public entry point on the proxy; internal routes stay
      unreachable from outside
