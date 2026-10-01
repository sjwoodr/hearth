# TODO

## Deployment (deferred milestone 4)

- [ ] Custom Caddy build with the `caddy-dns/cloudflare` module (caddyserver.com download or `xcaddy`)
- [ ] Cloudflare API token scoped to `Zone:DNS:Edit` on the one zone, in Caddy's own environment file
- [ ] `Caddyfile`: one certificate for the LAN and Tailscale names, `reverse_proxy 127.0.0.1:8787`
      with `flush_interval -1` so streamed replies aren't buffered
- [ ] DNS records (DNS only, not proxied): LAN name → LAN IP, `-ts` name → Tailscale IP
- [ ] systemd units for Caddy and hearth (`pnpm build`, then `pnpm start` with a production `.env`)
- [ ] Check from a phone on the LAN and one on Tailscale: valid certificate, login, streaming
- [ ] Push to GitHub (the repo is public; nothing secret is committed)

## Gaps worth closing

- [x] **Search past chats.** SQLite FTS5 over messages, from the sidebar and `hearth chats search`.
- [x] **Retry a failed reply.** Regenerate / Retry under the last message.
- [ ] **Check the phone layout in a real browser.** The slide-over chat list is written but was only
      tested at desktop width.
- [x] **Show when a reply is queued.** Only this server's own model calls are visible, not other
      Ollama clients.
- [ ] **Scheduled backups.** `hearth db backup` is manual. Either a timer, or confirm restic's include
      list covers `data/`.

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
- [ ] Forward only 443 on the router; point the public name at the public IP
