# hearth

A private, local chat companion with long-term memory. It runs on a local
model through Ollama, keeps full chat history, and remembers your likes and
the topics you discuss across sessions. Nothing leaves the machine, except a web search you
approve (see **Web search** below).

## Plan

- **Front end:** Vite + React + TypeScript
- **Backend:** Node + TypeScript (Hono), streaming replies from Ollama
- **Storage:** one SQLite file (`better-sqlite3`) for conversations, messages and memories
- **Memory:** a background extraction pass after each chat goes idle, schema-constrained
  JSON via Ollama's `format`; a short always-on profile plus embedding-based recall
- **Memory editor:** every stored memory is viewable, editable and deletable, linked to
  the chat it came from

## Development

Needs Node 22.18+ (it runs the TypeScript server directly), pnpm and, for the
admin menus, `fzf`.

```
pnpm install
cp .env.example .env         # optional; defaults suit local development
bin/hearth users add <you>   # create an account (there is no web sign-up)
pnpm dev:fullstack           # backend + Vite; open http://localhost:5180
pnpm test                    # vitest
pnpm check-types
```

API tests you can run by hand against a running hearth (local or deployed) are a
[Bruno](https://www.usebruno.com/) collection in [`bruno/`](bruno/README.md).

`pnpm build` puts the front end in `dist/client`, and `pnpm start` serves it
and the API from one process.

**Model gateway** (`pnpm gateway`, optional). One hearth process schedules its
own model calls. Several processes sharing one Ollama (the planned multi-service
deployment) need one scheduler for all of them: the gateway, an Ollama-compatible
server in front of Ollama on `HEARTH_GATEWAY_PORT` (11435). It requires
`Authorization: Bearer $HEARTH_GATEWAY_TOKEN` (and won't start without a token),
schedules `/api/chat` and `/api/generate` by `X-Hearth-Priority: reply|background`
and `X-Hearth-User`, tells a waiting streamed reply its place with
`{"hearth":{"queued":n}}` lines, answers a preempted background call with
`{"error":"preempted"}`, and passes embeddings (`/api/embed`) and the read-only
`ps`, `tags`, `show` and `version` straight through. The rest of Ollama's API
(`pull`, `push`, `create`, `copy`, `delete`) is a 404: the token reaches models,
never their management, so whoever holds it can't remove models or make Ollama
contact an outside registry. Point hearth at it with `HEARTH_GATEWAY_URL` (plus the same token): every
model call, embeddings included, then goes through the gateway, and hearth stops
scheduling in-process. Unset, hearth talks to Ollama directly, as before.

**Worker** (`pnpm worker`, optional). By default the main process also runs the
background jobs. With `HEARTH_ROLE=api` it only serves chats (plus chat titles,
which go out on the reply's own stream, and image descriptions, since an
undescribed image exists only in that process's memory), and `pnpm worker` runs
memory extraction and running summaries in its own process, checking every minute
for chats with new replies. Both need the gateway, so the worker's jobs still
yield to the api's replies; either refuses to start without it.

**Migrations** (`server/migrations/NNN_name.sql`) apply on start by default. A
deployment can make them a separate step instead: run `pnpm migrate` (or
`node server/migrate.ts`) first and start hearth with `HEARTH_AUTO_MIGRATE=0`.
hearth and `bin/hearth` then only check the schema version, and refuse to start
if the database is behind the code (run the migrations) or ahead of it (run the
newer hearth or restore a backup; migrations only go forward).

### In Docker

`docker compose up --build` runs the dev setup in three containers (Linux only),
the way a deployment splits it: **gateway** (`pnpm gateway`, the model gateway on
:11435, owning Ollama's slots), **hearth** (`pnpm dev:fullstack` with
`HEARTH_ROLE=api`: chats, titles, image descriptions) and **worker** (`pnpm
worker`: memory extraction and summaries). hearth and the worker send every model
call through the gateway. All read `HEARTH_GATEWAY_TOKEN` from `.env` (generate one
with `openssl rand -hex 32`); the gateway URL and the api role are set in the
compose file, so `pnpm dev:fullstack` on the host stays single-process.

The repo is bind-mounted, so edits on the host still restart the backend (and
the gateway and the worker) and hot-reload Vite, and the database stays in `data/`. The
containers use host networking, so every address is the same as on the host
(Ollama and SearXNG on 127.0.0.1, Vite on :5180); stop any host dev server
first. They share their own `node_modules` volume: the gateway runs `pnpm
install` on each start and the others wait until the gateway is healthy, so they
never install at once, and lockfile changes land on the next `docker compose
restart` of the gateway (after a dependency change the others stop until it has
reinstalled: `docker compose restart gateway`, then `docker compose restart hearth
worker`). `.git` is mounted read-only, so nothing in a container can plant a git
hook that runs on the host. `pnpm test`, `bin/hearth` and the editor keep using
the host's `node_modules`. Watch the slots with `curl -s localhost:11435/healthz`.

### Production images and the multi-service stack

`Dockerfile.prod` builds two images: **`hearth`** (`--target server`: Node, production
dependencies and the code, no compilers, non-root, `tini` as PID 1 so SIGTERM reaches Node; one
image for every role: the api by default, or `node server/worker.ts`, `node
server/gateway-main.ts`, `node server/migrate.ts`; the database on a `/data` volume) and
**`hearth-web`** (`--target web`: the built front end on unprivileged nginx, port 8080, with
unknown paths answered by `index.html`). An allow-list ignore file
(`Dockerfile.prod.dockerignore`) keeps tests, `data/` and `.env` out of the images.

`compose.services.yml` runs those images the way the planned k3s deployment splits hearth, on one
machine, with its own project, network and fresh database:

```
docker compose -f compose.services.yml up --build -d
printf 'pw\npw\n' | docker compose -f compose.services.yml run --rm -T --no-deps api bin/hearth users add <you>
# open http://localhost:8090 (HEARTH_SERVICES_ORIGIN for another address)
docker compose -f compose.services.yml down        # -v also deletes its database
```

A `migrate` job runs first; then the gateway (host network, port 11436), two api replicas sharing
the SQLite volume, the worker, the web image, its own SearXNG (your settings file, read-only), and
an nginx proxy standing in for the ingress (`deploy/nginx-ingress.conf`: `/` to web, `/api` to the
api replicas, unbuffered, `X-Forwarded-For` set and trusted). It shares Ollama with the dev stack,
so run one at a time for real use.

### Helm chart

`deploy/charts/hearth` runs the same services on Kubernetes: the gateway (host networking, so it
reaches Ollama on its node), the api, the worker, the web image, a migrate hook before every
install and upgrade, and a nightly backup CronJob. It needs a commit image tag, the URL people
open, the node with Ollama and the data, a database folder or a PVC you created (the chart never
creates the data volume, so uninstalling can't delete it) and a Secret with the gateway token. Its
README has the values and an install example. `.github/workflows/chart.yml` lints it, validates
the render with kubeconform and runs its unit tests (`helm unittest`) whenever the chart changes.

### CI

`.github/workflows/ci.yml` runs `pnpm check-types` and `pnpm test` on every pull request and on
`main`,
then builds both images (proof `Dockerfile.prod` still builds) and, on `main` only, pushes them to
GHCR as `ghcr.io/sjwoodr/hearth` and `ghcr.io/sjwoodr/hearth-web`, tagged `sha-<short commit>`
(what a deployment pins) and `main`. It logs in with the built-in `GITHUB_TOKEN`. **A new GHCR package starts private** even though the repo is public: after the first push
of each, set it to public under the package's settings, or pulls without credentials fail with 401.

After the images are pushed, the `deploy` job commits `image.tag: sha-<short commit>` to a
GitOps repo (Argo CD or similar rolls it out from there; CI never talks to a cluster). It needs a
GitHub environment named `gitops`, limited to the `main` branch, with two secrets:
`GITOPS_REPO` (`owner/name`) and `GITOPS_DEPLOY_KEY` (the private half of an SSH deploy key that
has write access to that repo). The values file is `values/hearth.yaml`, and its tag line must
look like `  tag: sha-…`. Without the environment the job fails and nothing else is affected;
delete the job if you don't deploy this way.

## Admin console: `bin/hearth`

Everything in the database is managed from the host with `bin/hearth`; there is
no admin interface on the web. Run it bare for an fzf menu (arrow keys, type to
filter, ESC to go back, details in a preview pane). When input is piped or fzf is
missing it falls back to numbered prompts, which is also how its tests drive it.
Every action is also a subcommand:

```
hearth users    list | add <user> | passwd <user> | name <user> [display name]
                | disable <user> | enable <user> | delete <user>
hearth chats    list [user] | show <id> | search <text> | export <id> [file] | rename <id> [title]
                | delete <id>
hearth messages edit <id> [text] | delete <id>
hearth memories list [user] | add <user> <profile|fact> [text] | edit <id> [text]
                | kind <id> <profile|fact> | delete <id>
hearth sessions list [user] | revoke <id-prefix> | revoke-user <user> | purge
hearth db       info | check | backup [file] | vacuum | shell
```

Deletes ask first (deleting a user means typing the name back); `--yes` skips
that. Text left off the command line opens `$EDITOR`. `db backup` writes a
consistent copy to `data/backups/` while the server runs. `db shell` needs the
`sqlite3` package. The cross-user queries it uses live in `server/cli/` only,
so the web app can't reach an unscoped query.

## Users and sessions

Multi-user, with no sign-up from the web interface; accounts come from
`bin/hearth users`.

- Passwords are hashed with Node's built-in `crypto.scrypt`.
- Sessions are server-side rows keyed by a SHA-256 of the token; the browser
  holds the random token in an HttpOnly, SameSite=Lax cookie. Logging out,
  disabling or deleting a user, or changing their password ends their sessions.
- Every conversation, message and memory has a `user_id`, and every query the
  web app makes (including memory recall) is scoped to the logged-in user.
- Failed logins are throttled: 5 misses for one username from one address, or
  20 from one address, lock that for 15 minutes. Lockouts are in memory, so a
  restart clears them.
- Each user can have a display name (`hearth users name <user> <name>`), used
  in the greeting, the memory prompt and extraction; without one hearth uses
  the username. Extraction fills a blank display name when a user explicitly
  says what to call them, and never replaces one that is set.
- All users share one Ollama instance, which runs a fixed number of requests at once (its
  slots: `OLLAMA_NUM_PARALLEL`, mirrored in `HEARTH_OLLAMA_SLOTS`; 1 by default; measured in
  [docs/ollama-slots.md](docs/ollama-slots.md)). Replies go before background work, which is
  paused and retried. When every slot holds a reply, the next one waits ("queued"), and waiting
  replies take turns between users.
- Before a reply's first word, the chat says why it's waiting: a search running, the queue, the
  model thinking, or **"Loading the model…"** when Ollama had unloaded it (it does after
  `OLLAMA_KEEP_ALIVE`, and loading takes ~15 s; hearth asks Ollama's `/api/ps` alongside the reply,
  so a loaded model costs nothing). After 5 seconds with none of those, it says it's still working
  (usually a long chat being read again).

## Network and TLS

```
LAN / tailnet ──► reverse proxy :443 (TLS) ──► hearth backend ──► Ollama 127.0.0.1:11434
```

Today hearth runs as the dev server (Vite on `:5180`, plain HTTP on the LAN). This is the shape of a
deployment; the planned one is a home k3s cluster with Traefik as the ingress and cert-manager for
certificates, but any reverse proxy fits.

- **A reverse proxy terminates TLS** and forwards to the backend, which never handles TLS. On a
  plain host the backend listens only on `127.0.0.1`.
- **Client addresses:** the backend believes `X-Forwarded-For` only from a trusted proxy
  (`HEARTH_TRUSTED_PROXIES`, addresses or CIDR ranges; by default only this machine), taking the
  rightmost address it doesn't trust, so a client can't fake its own. Behind a proxy elsewhere
  add its range (for a k3s ingress, the pod network: `127.0.0.0/8, ::1/128, 10.42.0.0/16`), or
  every client shares one login-throttle bucket. A typo in the setting stops startup.
- **Probes:** `/healthz` (the process is up) and `/readyz` (the database answers and its schema
  matches; 503 otherwise), with no login, on the backend and on the worker
  (`HEARTH_WORKER_PORT`, 8788). `/readyz` reports whether the models are reachable but doesn't
  fail over it, so an Ollama outage doesn't take the whole UI down.
- **Shutdown:** on SIGTERM each process stops accepting connections, lets open requests finish
  (a reply mid-stream ends normally), closes the database and exits; anything still open after
  `HEARTH_SHUTDOWN_GRACE_MS` (25 s, under Kubernetes' 30) is cut off.
- **Metrics:** `/metrics` (Prometheus) on the backend, the worker and the gateway (behind its
  token there): reply time and time to first word, outcomes (done, search, error, stopped),
  Ollama's own tokens per second and prompt reading time (short when its cache held the chat),
  slot waits, preemptions, searches asked/approved/declined/failed, background jobs by outcome,
  whether Ollama answers (`hearth_ollama_up`, from the gateway, or from hearth on its own), and
  Node's process metrics. Every series carries `service` (hearth, worker, gateway). Counters start
  at 0 for every outcome, so "none yet" reads as 0 rather than a missing series.
- **Logs:** plain lines by default; `HEARTH_LOG_FORMAT=json` writes one JSON object per line
  (`time`, `level`, `service`, `msg`, and `chat` when a message names one) for a log store.
- **Certificates:** Let's Encrypt via the ACME **DNS-01** challenge, so no inbound route is needed
  and LAN-only names still get real certificates. A wildcard certificate (`*.example.com`) also keeps
  individual hostnames out of the public Certificate Transparency logs.
- The real domain, hostnames and tokens live only in local config, never in the repo.
  `example.com` is a placeholder.
- **Names:** `hearth.example.com` → the machine's LAN IP, with DNS only (not proxied). Away from
  home, Tailscale reaches the same name.
- **Ollama stays on `127.0.0.1:11434`.** Never expose it.
- **Opening to the internet later:** add two-factor login first, and expose hearth only through a
  separate public entry point on the proxy, so nothing else becomes reachable.
- The session cookie is `Secure`, since every client connects over HTTPS.
- **Replies stream as NDJSON**, so the proxy must pass chunks straight through rather than buffer
  responses.

## Memory

Two kinds of memory, both per user and both editable on the Memories page or
with `bin/hearth memories`:

- **Always remembered** (`profile`): added to every chat's system prompt.
  hearth never creates these itself; a memory becomes one only when its owner
  promotes it. (The model turned "keep this reply short" into a standing
  preference, so it no longer gets to decide what shapes every chat.)
- **Recalled when relevant** (`fact`): learned from chats. Each message is
  embedded with `embeddinggemma:300m-qat-q8_0` and compared with the user's
  facts; up to 6 scoring at least 0.38 are added, each with the date it was
  learned. (Measured: related pairs scored 0.44-0.61, unrelated 0.19-0.30.)
  Facts are embedded on first use and again after an edit.

**Extraction** runs in the background: once a minute the server looks for chats
whose newest message is at least `HEARTH_MEMORY_IDLE_MINUTES` (5) old and have
messages it hasn't read. It sends the unread part plus the user's existing
memories to the chat model with a JSON schema, then keeps only valid changes: at
most 8 additions and 8 updates, 300 characters each, no duplicates, and updates
only to that user's own memories. It never deletes. Progress is stored per chat
(`memory_through_message_id`), so a restart loses nothing; a chat whose
extraction fails waits 15 minutes before a retry.

**Near-duplicates.** Before saving, each new memory is embedded and compared with the user's
existing memories and the rest of the batch. Similarity alone can't separate a rewording from a
different fact on the same topic (measured: rewordings 0.86-0.94, but "learning French" vs "learning
Spanish" 0.886 and "druid" vs "paladin" 0.905), so anything at 0.85 or above goes to the chat model
as a yes/no "do these say the same thing?" question. It judged 9 of 10 test pairs right, and its one
miss kept a duplicate rather than dropping a fact. Any failure keeps the memory.

`hearth memories extract <chat-id>` runs it on demand, and
`hearth memories recall <user> <text>` shows each fact's score for a message and
the exact memory section the model would get.

## Model

`gemma4:26b-a4b-it-qat`, `num_ctx` 16384, thinking off: a mixture-of-experts model (~4B of 26B
active per token), 15 GB loaded, ~26 tokens/s on the Radeon 780M. Chosen with a 158-question French
bench against nine other setups (Gemma 12B, Nemotron, Mistral Small/Nemo, Ministral, Qwen 3, Aya):
153/158 at ~1.2 s per answer. A follow-up grading test found it marks about 1 in 30 correct answers
wrong in fast mode and none with capped thinking, which is what Think: Auto is for. The method, every
result and the design decisions they led to are in [docs/model-selection.md](docs/model-selection.md).
The bench lives in `~/src/other/french-model-bench`, outside this repo, because its answer key comes
from private content.

**Think: Auto / On / Off.** The button next to Send cycles through three settings (remembered per
browser). Thinking replies use `HEARTH_MODEL_THINKING` with reasoning capped by the effort level
(below; Medium's cap is `HEARTH_THINKING_TOKEN_BUDGET`, 200 tokens): at the cap the model is stopped
and asked to answer, with its reasoning passed back as notes. The reasoning is never shown or stored;
the bubble shows "Thinking… N of 200 · Medium" while it runs. Measured: ~12-15 s per reply instead of ~2 s, for grading as accurate as
unlimited thinking, which sometimes ran past five minutes. Background jobs (memory, titles,
summaries) always use `HEARTH_MODEL` without thinking.

- **Auto** (the default) thinks only when the message calls for it, by plain rules in
  `server/think-router.ts`: asking to check, correct or grade French; answering (or disputing) a quiz
  hearth just gave; asking for a French quiz; asking why, or for the exceptions or differences, in a
  French grammar question. The reply says so ("thought first (auto: checking your French)"). No model
  call decides: a separate classifier request would evict Ollama's cached conversation and cost the
  next reply a full reread. Checked against 29 labelled messages and the owner's real chat history, where it
  picked exactly his 3 French grammar questions out of 23 messages.
- **On** and **Off** override the rules either way.
- A fast reply that corrects itself mid-answer ("wait, no, that's wrong") gets a
  **↻ Re-answer with thinking** button next to Regenerate.

**Think effort: Medium / High / Max.** Next to Think (hidden when it's Off), a second button sets how
much room a thinking reply gets: `HEARTH_THINKING_TOKEN_BUDGET` (200), `_HIGH` (400) and `_MAX`
(800) reasoning tokens. It applies to On, and to Auto when Auto decides to think; remembered per
browser. Medium is the measured one: 200 tokens kept all of unlimited thinking's accuracy on the
grading bench, so more doesn't help checking French. High and Max are for harder questions (code,
multi-step reasoning) and are unmeasured; at ~22 tokens/s each level roughly doubles the worst-case
wait (~9, ~18, ~36 s of reasoning). A higher level also holds back more of the context window
(2 × budget + 64 tokens: 464, 864, 1,664), so in a long chat near the limit it can trim older history
for that reply. After a reply that thought, **↻ Think harder (High)** (or Max) re-answers at the next
level up. The reply's note says which level it used ("thought first (High)").

**Context and caching.** Ollama keeps the prompt it just read, and on the next turn reads only what
changed after the first difference. So the prompt is ordered to keep its start stable: personality,
always-remembered memories and the running summary in the system prompt, then the history. The facts
recalled for each message change every time, so they're attached to that message (in the prompt only;
the stored message is untouched). Measured on a ~7k-token chat: follow-ups start in ~1 s at 16k; with
recall in the system prompt every reply reread the whole chat (~22 s), and at 8k the chat no longer
fits, so trimming changed the start every turn (~7 s). The summarizer scales with `HEARTH_NUM_CTX`:
it summarizes past half the window and keeps a quarter verbatim. With Think on, the thinking budget
(and the notes it produces) is held back from the window too.

**Context size and keep-alive: the trade-off (left at 16k and 30m for now).** Memory is not what
decides the context size: 32k loads at 14.04 GiB against 14.01 at 16k. What it changes is how much a
reply has to reread when Ollama's cache is empty. The unsummarized history can grow to half the window
(about 8-9k tokens at 16k, about 17k at 32k), and a cold reread runs at about 275-290 tokens/s here. The
cache holds one conversation, so it is empty after any of these:

- **The model was unloaded.** `OLLAMA_KEEP_ALIVE=30m` unloads it after 30 idle minutes, so the first
  reply also pays 5-15 s to load it.
- **Another client used the model at a different `num_ctx`.** Ollama keeps one copy per model file,
  so a request at another context size (say an agent harness using a 32k tag of the same model)
  reloads it, and hearth's next reply reloads it back. Measured on two switches: 14.6 s and 4.8 s
  (a 29.7 s and a 17.1 s reply). A reload can also evict the embedding model, which costs the next
  message ~1 s to bring back.
- **Another chat was used in between**, by you or another user. No reload, just the reread.

| Cold reread, chat size | 16k (now) | 32k |
|---|---|---|
| Short (~1.3-1.5k tokens, measured) | ~5 s | same |
| Just below summarizing | ~30 s (estimated from the rate) | **60.2 s** (measured: 16,970 tokens) |

Add 5-15 s when the model also has to load. The 32k row was measured with a throwaway chat: 61.8 s to
the first word cold, then 2.9 s for a follow-up in the same chat. hearth's token estimate (3.5
characters per token) put that chat at 15.9k; Gemma counted 16,970, about 3.2 characters per token,
so summarizing actually starts ~7% later than hearth thinks. The 1024 tokens held back for the reply
absorb that at either size.

With a warm cache both sizes cost the same: only the new message is read. 32k's gains are fewer
summaries (so fewer blurred details) and no reload when sharing the model with a 32k client.

To change either one:

1. **32k for hearth:** set `HEARTH_NUM_CTX=32768` in `.env` and restart hearth. Nothing else needs
   to change, since the summarizer scales with it. Then update the model notes here, in
   `docs/model-selection.md` and in `CLAUDE.md`, and time one reply to a long chat after an idle
   period to replace the estimate above.
2. **Keep the model loaded:** raise `OLLAMA_KEEP_ALIVE` (for example `4h`, or `-1` for never) in
   the Ollama service's systemd drop-in, then `sudo systemctl daemon-reload && sudo systemctl
   restart ollama`. A resumed chat then costs only the reread, and only if something else used
   the model in between. The cost is ~14 GiB of RAM held permanently.

**Where settings come from.** `server/config.ts` holds every default; `.env` (gitignored) overrides
them, and values already in the environment override both. `.env.example` documents the same
defaults and isn't read by anything.

The personality is the system prompt in `prompts/system.md` (or the file
`HEARTH_SYSTEM_PROMPT` names). It is re-read on every message, so edits apply
without a restart. Each request sends the system prompt plus as much recent
history as fits in the context window, oldest turns dropped first, with 1024
tokens held back for the reply.

**Long chats.** After each reply, a background job checks the part of the chat not yet summarized.
Past half the context window it folds the oldest messages into a running summary stored on the chat
(built on the previous summary), keeping the newest quarter of the window verbatim. Later messages
send the summary, under "Earlier in this conversation", in place of what it covers. `hearth chats
show` prints it.

**Titles.** A chat is first titled from its first message. After the first reply the model writes a
2-6 word title, which reaches the sidebar through the reply stream. A chat the user has renamed is
never retitled.

**Retry.** Regenerate (or Retry, when a reply failed) re-answers the last question, replacing the
last reply rather than adding another.

**Markdown and code.** Messages are rendered as Markdown (GitHub style: tables, lists, links), the
user's too, keeping their line breaks as typed. A fenced code block shows its language, highlighting
(when tagged, as in ```` ```python ````; highlight.js's common languages, loaded the first time a
message has a code block) and a **Copy** button. A reply with a code block also has a **Show raw**
button (on hover with a mouse, always on a phone) that shows its exact text, Markdown and all;
**Show rendered** switches back. Plain prose replies don't get one. Copying needs HTTPS or localhost for the clipboard API; on a plain-HTTP address it falls back
to the browser's older copy command.

**Chat goes first.** Ollama runs one request at a time, shared by replies and background jobs
(memory extraction, duplicate checks, summaries, titles). A new reply cancels any background call in
flight; the job fails with `PreemptedError`, writes nothing, and is retried on its next pass
(extraction doesn't count it as a failure, so it skips the 15-minute backoff). The memory sweep
doesn't start while a reply is being generated. A reply only ever waits behind another reply, and
then the client shows "Waiting for the model to finish another reply". Measured: a message sent 4s
into an extraction got its first token 3.0s later, instead of waiting out the ~28s run. Other Ollama
clients are invisible to this.

**Search.** The sidebar searches the user's messages (and image descriptions) with SQLite FTS5 (word forms and accents folded,
the last word matched as a prefix), and opening a result scrolls to the message. Input is quoted word
by word, so it can never be FTS query syntax.

**Images.** Paste, drop or add (**+**) up to 4 images to a message; the browser shrinks each to
1600px JPEG first, which also strips EXIF data such as location. The chat model sees them with that
message only. **Images are never stored**, not even as thumbnails: after the reply, a background job
asks the model to transcribe any text exactly (mistakes kept) and describe the rest, and that
description is all hearth keeps (`messages.image_note`). It stands in for the images in later
prompts, summaries, memory extraction and search, and the message shows it, collapsed, after a
reload. The description is written as a continuation of the prompt just answered, so Ollama reuses
its cache and reads only the reply and the request. Until it's written, the images wait in server
memory (at most 8 messages' worth), and a Regenerate or a re-answer with thinking still sees them
until the next message. A restart loses undescribed images; the message then says so. Measured: an
image costs ~260 prompt tokens however large (Ollama scales it down) and ~3.5 s to encode on the
780M. Think: Auto thinks when an image comes with a request to check or correct, since the rules
can't read the French inside it.

**Web search.** The model can ask to search the web (Ollama tool calling, one `web_search` tool),
but asking runs nothing: the chat shows a card with the exact query, and only **Search** sends it
out (to a local SearXNG, which forwards it to Google, Bing and other engines). **Answer without
searching** makes the model reply from what it knows. The server enforces this: the request waits
in the database (`pending_searches`), and `POST /api/conversations/:id/search` with `approve: true`
is the only code path that calls the search engine. A new message or a retry drops the request; a
restart doesn't, and an unanswered card expires after a day. The saved prompt never holds image
bytes: images are put back from memory when the search runs, or, after a restart, replaced by
their description or a note that they're gone. Answered after midnight, the prompt gets today's
date. The model sees the top 5 results (title, URL, snippet), labelled as untrusted web text, on that
turn only; the reply keeps just the links (`messages.sources`), shown as site pills and listed for
the model in later turns. At most 2 searches per message, then it must answer. The system prompt
gains today's date and when to search: without them Gemma 4 asked for 1 of 10 questions that
needed a search; with them 9 of 10, and 0 of 10 that didn't (French practice, grammar, chat).
Setup: SearXNG in Docker on 127.0.0.1:8888 with `json` in `search.formats`
(`HEARTH_SEARXNG_URL`; `off` never offers the tool).
