# hearth

A private, local chat companion with long-term memory. It runs on a local
model through Ollama, keeps full chat history, and remembers your likes and
the topics you discuss across sessions (except in a private chat, which is never saved). Nothing leaves the machine, except a web search you
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

### Plain manifests

`deploy/k8s/` is the same deployment as plain YAML, without Helm, for a single-node k3s cluster:
numbered files, the migration as an explicit step before the services start, and the gateway token
created with `kubectl`. Its README has the install and upgrade steps. Tested on k3s 1.36 (Ubuntu
24.04, Traefik's bundled chart) with a small model; the chart remains the maintained way to deploy.

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

Everything in the database is managed from the host with `bin/hearth`; the one
admin control on the web is the model switch (below), and only for admins. Run it bare for an fzf menu (arrow keys, type to
filter, ESC to go back, details in a preview pane). When input is piped or fzf is
missing it falls back to numbered prompts, which is also how its tests drive it.
Every action is also a subcommand:

```
hearth users    list | add <user> | passwd <user> | name <user> [display name]
                | role <user> <admin|user> | disable <user> | enable <user> | delete <user>
hearth chats    list [user] | show <id> | search <text> | export <id> [file] | rename <id> [title]
                | delete <id> | stats [user]   (replies per week: ending in a question, length)
                | notes <id>   (the model's private notes for the chat: spoilers, never shown in the app)
hearth persona  show <user> | name <user> [name] | about <user> [text] | reset <user>
hearth messages edit <id> [text] | delete <id>
hearth memories list [user] | add <user> <profile|fact> [text] | edit <id> [text]
                | kind <id> <profile|fact> | delete <id>
hearth sessions list [user] | revoke <id-prefix> | revoke-user <user> | purge
hearth model    show | list | use <model> | reset
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
- **Roles: `user` (everyone, by default) and `admin`.** Only `hearth users role <user> admin` grants
  admin; the web app can't. An admin can switch the model (below); nothing else differs.
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
- **Version:** each image knows the git sha it was built from (`HEARTH_VERSION`, `sha-<short>`,
  passed by CI as a build argument; `dev` from a checkout). `/healthz` and every `/api` answer
  (`X-Hearth-Version`) report the server's, and the chat list's footer shows it (hover for the
  page's own). If it changes while a page is open, a deploy rolled out under it, and the page
  offers a reload; it asks once whenever the tab or Home Screen app comes back into view.
- **Shutdown:** on SIGTERM each process stops accepting connections, lets open requests finish
  (a reply mid-stream ends normally), closes the database and exits; anything still open after
  `HEARTH_SHUTDOWN_GRACE_MS` (25 s, under Kubernetes' 30) is cut off.
- **Replies outlive the connection:** a reply runs to the end even if the browser goes away (a
  phone's screen locking closes the stream), and is saved whole. Stop is its own request
  (`POST /api/conversations/:id/stop`), and a second message in that chat waits (409) until the
  reply is done. A page that lost its stream shows "Still writing…", and once it's visible again
  checks every 2 s (`replying` on `GET /api/conversations/:id`) until the reply is saved. The list of
  replies in progress is in the api's memory, which is enough for one api process; a shutdown
  doesn't wait for a reply whose browser has already gone.
- **Metrics:** `/metrics` (Prometheus) on the backend, the worker and the gateway (behind its
  token there): reply time and time to first word, outcomes (done, search, error, stopped),
  Ollama's own tokens per second and prompt reading time (short when its cache held the chat),
  reasoning tokens per thinking reply by effort, cut by the budget or finished on its own
  (`hearth_thinking_tokens`), slot waits, preemptions, searches asked/approved/declined/failed, background jobs by outcome,
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

## Word lookup

Tap a word in a reply, or select a phrase, and a popup says what it means in that sentence, with the
dictionary form or idiom when there is one. It works on any reply text except links and code. The
sentence goes with the word, so *sent* in "Le fromage sent bon" reads "smells", and a selected idiom
gets the idiom's meaning. Nothing is stored, and answers are kept in the page until it reloads.

This runs on a small model of its own, `HEARTH_WORD_MODEL` (default `gemma4:e2b-it-qat`), as background
work, so a reply can interrupt it. On the mini PC a word takes about half a second once the model is
loaded, and the first lookup after it unloads takes about 4 s. It's a quick gloss and can be wrong: it
knows common idioms, but in testing it missed *vendre la mèche*.

## Listen

The speaker under a reply reads it aloud, and **Hear** in the word popup says the word or phrase. Press
the speaker again to stop. Code blocks, link addresses, Markdown and emoji are left out.

**Two voices, one per language.** The model's voices are a language and a gender, and each only sounds
right in its own language: the French voice reading English sounds British. So a reply is read sentence
by sentence, French sentences in the French voice and the rest in the English one. A sentence counts as
French when it has more French-only words (*je*, *est*, *avec*…, accented words, *j'*/*l'*/*qu'*) than
English-only ones (*the*, *is*, *with*…); one with neither (*Bravo !*, a name) goes with the sentence
before it. An English sentence that quotes a little French (*the word « marché » means market*) is read
in the English voice, accent and all. Hear in the popup always uses the French voice. Each user picks
both on the Memories page (About <name>, **Voice**, with a sample of each); the defaults are
`HEARTH_SPEECH_VOICE_ENGLISH` (`female-american-english`) and `HEARTH_SPEECH_VOICE_FRENCH`
(`female-french`), and each list is every voice the speech model has (39 for LFM3-Omni: female and male
for 19 languages, plus its own, which is American English).

It runs on `HEARTH_SPEECH_MODEL` (default `lfm3-omni:latest`, Liquid AI's LFM3-Omni: 1.7B, about 3 GB
loaded beside the chat model; needs Ollama 0.40.13 or later and `ollama pull lfm3-omni`). Set it to `off`
to hide the buttons; they also hide themselves when Ollama doesn't have the model. The audio streams to
the browser as it's made, so the first words play about half a second after the press, and the model
keeps ahead at about twice the speed it plays. A long reply goes in pieces of up to 300 characters, one language each. Each
press counts as a reply for Ollama's slots (it waits its turn behind replies, and background work makes
way). Nothing is stored except the choice of voices: the audio is kept in the page so a replay starts at
once, until it reloads. The speech model only reads text; it doesn't write any.

## Memory

Two kinds of memory, both per user and both editable on the Memories page or
with `bin/hearth memories` (the page shows each memory's ID, `#64`, the same
one the CLI takes, and lists the most recently changed first, each marked
"added Oct 24" or, once edited, rewritten by a later chat or moved, "changed
Oct 27"):

- **Always remembered** (`profile`): added to every chat's system prompt.
  hearth never creates these itself; a memory becomes one only when its owner
  promotes it. (The model turned "keep this reply short" into a standing
  preference, so it no longer gets to decide what shapes every chat.) A reply
  carries up to 800 tokens of memories (about 2,800 characters), and these take
  it first, with the always-remembered ones about the assistant; recalled facts
  get what's left. The Memories page shows how much they use, both tabs counted
  together, and warns once recalled memories start getting crowded out, or some
  of these no longer fit.
- **Recalled when relevant** (`fact`): learned from chats. Each message is
  embedded with `embeddinggemma:300m-qat-q8_0` as a search query and compared
  with the user's facts, embedded as documents (EmbeddingGemma's task prompts);
  up to 6 scoring at least 0.30 are added, each with the date it was learned.
  Without the prompts a short message ("lol", "ok") resembled every memory, so
  filler messages carried several unrelated ones; with them, filler scored
  0.19-0.27 on made-up memories and real messages found the fact they were
  about. Facts are embedded on first use and again after an edit (recall keeps
  its own vector, `recall_embedding`; near-duplicate checks use the raw one). A reply that had any
  shows **Remembered N things** above it; tap it for the list. The reply keeps
  only the memories' ids (`messages.remembered`, migration 019), so the list
  shows each one as it reads now, and one deleted since drops out. Private chats
  show it too, and store nothing.
- **For now** (a `fact` with an end date, `until`): a trip, a visit, a sick week,
  a busy stretch before a deadline. It goes with every reply through its last day,
  on the newest message like recalled facts (never the system prompt), so a new
  chat's "good evening" knows about the trip; at most 5 at a time, after the
  always-remembered ones in the 800-token allowance. They aren't listed under
  "Remembered"; a chat's **first** reply gets its own **For now: N** line instead
  (tap for the list; `messages.for_now`, migration 023), since a new chat's
  answer is where one shows, and a line under every reply of a trip would be
  clutter. The day after it ends, the memory sweep rewrites it once in the
  past tense ("went on a cruise in November 2026 and liked the piano bar") and it
  becomes an ordinary recalled memory; if the rewrite fails it stays as written.
  Either way it's listed under **Ended** ("ended Nov 29") until you look at it:
  **Keep for good** moves it to the ordinary memories, Edit fixes the wording (or
  makes it "for now" again, if the trip was extended), Forget deletes it. It's
  recalled when relevant meanwhile, so reviewing is optional (`memories.ended_on`,
  migration 022). On the Memories page these have their own section with "until Nov 29"; Edit
  changes or clears the date (cleared, it's kept for good), and the add box has
  "For now (a week)". Promoting one to always-remembered, or moving it to About
  <name>, ends it.

**Extraction** runs in the background: once a minute the server looks for chats
whose newest message is at least `HEARTH_MEMORY_IDLE_MINUTES` (5) old and have
messages it hasn't read. It sends the unread part plus the user's existing
memories to the chat model with a JSON schema: all of them up to 80, and past
that the always-remembered ones and the facts closest to what the chat says
(each scored by its best match against any message read), so a correction finds
the memory it corrects however old it is. It then keeps only valid changes: at
most 8 additions and 8 updates, 400 characters each, no duplicates, and updates
only to that user's own memories. The model is told to update an existing memory
on the same subject rather than add another, and to rewrite the memory behind
anything the user corrects, so a vague memory that led to a wrong reply gets fixed
instead of gaining a second, competing one. It never deletes. Progress is stored per chat
(`memory_through_message_id`), so a restart loses nothing; a chat whose
extraction fails waits 15 minutes before a retry.

**Only what lasts.** Each new memory, and each update, is first asked: will this still be true and worth
knowing in a month? "Is watching the game live, tied 24-24", "is going to a game tonight, row 2"
and "notes it is still dark at 6:30 am" are not; a hobby, a project, a plan for next year or a story from
the past are. A fleeting addition is dropped, and a fleeting update leaves the memory as it was. The
extraction prompt also asks the model to leave the passing details out of a memory, so "a Bears fan
watching tonight's game" keeps only the Bears. On real chats this cut the noise saved from about half the
fleeting moments to 6 in 100, without dropping a lasting fact; a failed check keeps the memory.

**For now, with an end date.** A situation that lasts days or weeks and then ends is saved as one
"for now" memory with its last day: the date the user gave ("back Sunday", worked out from today and a
two-week calendar in the prompt), or a week from today if they didn't say. Details from during it (a
favourite spot on the trip) go in that memory, and a trip that's extended moves its date. Tonight's plans
and anything over by tomorrow still aren't saved: a new one ending today or tomorrow is dropped.
A yes/no check then asks whether it really will be over within weeks: the prompt alone gave "has been
learning ukulele since the summer" an end date, and anything that fails is saved as a lasting memory
instead (and asked whether it lasts, like any other). These skip the one-month question, which they fail
by design.

**Only what the user said.** Each new memory gets one more yes/no question before it's saved:
did the user say this about themselves, or only ask about it? A lone lookup ("who is the Jaguars'
quarterback?") used to become "interested in the Jaguars" about 1 time in 7; with the check, 0 in 20.
Updates to existing memories aren't checked, and a failed check keeps the memory.

**Near-duplicates.** Before saving, each new memory is embedded and compared with the user's
existing memories and the rest of the batch. Similarity alone can't separate a rewording from a
different fact on the same topic (measured: rewordings 0.86-0.94, but "learning French" vs "learning
Spanish" 0.886 and "druid" vs "paladin" 0.905), so anything at 0.85 or above goes to the chat model
as a yes/no "do these say the same thing?" question. It judged 9 of 10 test pairs right, and its one
miss kept a duplicate rather than dropping a fact. Any failure keeps the memory. A memory updated
in the same batch is checked from 0.70: the model often saves a correction twice, as the update
and as a new memory, and those pairs scored only 0.77-0.83.

**`[no extraction]`.** Start a message with `[no extraction]` (any capitalisation; `[no-extraction]`
works too) and neither it nor the reply to it is ever read by memory extraction (about you or about
the assistant), the chat's summary or its titles, and neither is in search. The marker is removed
before the message is saved or sent to the model, and both messages show "Not remembered"; the chat
box says the same while you type it. They stay in the chat like any other message, so the model sees
them until the chat grows long enough to fold them away; after that the chat has forgotten them too,
as the summary never mentions them. The marker covers that one message: a later message that refers
back to it is read as usual. For a conversation that's never saved at all, use a private chat (below).

`hearth memories extract <chat-id>` runs it on demand, and
`hearth memories recall <user> <text>` shows each fact's score for a message and
the exact memory section the model would get.

## Who the assistant is

Each user can shape their own assistant on the Memories page, in its second tab, **About <name>**
(the first is **About you**; the open tab is in the URL, `#/memories/assistant`, so a reload keeps it):

- **A name and a description** ("who they are to you": a voice, a backstory, how you picture them).
  Both go into that user's system prompt as a "Who you are" section, after hearth's own instructions,
  so a persona can add to how hearth behaves but can't remove the measured parts (correcting French,
  symbols, the app). Empty means the defaults: `HEARTH_ASSISTANT_NAME` and no description. Every
  save keeps the version it replaced (the last 20), and **Earlier versions** brings one back
  (Restore) or deletes it (Forget). The list never shows the same version twice or a copy of the
  current one.
- **Memories about the assistant**, beside the user's own: added by hand, moved from **About you**
  ("Move to About <name>", for a memory filed under the user), or learned from chats. After a chat
  goes quiet, extraction also asks what the user established about the assistant (a name they gave
  it, a backstory, how they picture it, a role) and keeps only what the user said, asked for or
  agreed to: never what the assistant made up about itself, which would otherwise come back in every
  chat as lore. "Always" ones join the description; the others are recalled when relevant.

The name is per user: the system prompt, the running summary and memory extraction all call the
assistant by that user's name for it, and so does the app wherever the assistant itself acts (the chat
box's "Message Gemma", a web search request, the Think: Auto help, the private-chat note). Where the app
works in the background (memories, summaries, image descriptions) it stays hearth. `bin/hearth persona show|name|about|reset <user>` does the same
from the console (`server/persona.ts`, tables `personas` and `persona_history`, `memories.subject`).

## Chat notes

Besides memories, the model keeps private notes for each chat: a story's plan and culprit, a quiz's
answer key, a game's secret, a checklist. It writes them itself with a `save_notes` tool, in the
middle of a reply (no card to approve: they never leave the machine), and reads them on every later
turn, attached to the newest message like recalled memories. Saving replaces the old notes, up to
3,000 characters (`server/chat-notes.ts`, table `chat_notes`, deleted with the chat).

**Nobody sees them in the app**, by design: no page shows them and no API response contains them, so
a story's ending can't be spoiled by a stray click. The chat does show *that* they were saved: a quiet
"Updated its private notes" line on the reply (kept after a reload, `messages.notes_saved`), and
"Writing notes…" while the model saves and carries on. That line is also how to catch the model
claiming a plan it never saved ("I've mapped it all out in my notes" with no line: it happened once in
17 runs of a story brief). `bin/hearth chats notes <id>` prints them, for
debugging. A private chat's notes stay in server memory only, until the chat ends, hearth restarts,
or 12 hours pass unused.

The model rarely writes notes unprompted. Ask for them where they matter: "Before Chapter 1, decide
the whole mystery and save it in your notes: the culprit and motive, at most five characters, which
clue appears in which chapter, and how it ends around Chapter 10. Then keep to it." Measured on a
real story brief, 8 chapters x2 per setup: without a plan the cast kept growing and the premise
changed 2-4 times; with one, every character came from the plan and the clues landed in their
planned chapters. Only models that can call tools get the tool.

## Model

Gemma 4 26B-A4B as `gemma4-26b-a4b-ud-64k`, `num_ctx` 65536 with prompts kept to 16k, thinking off: a mixture-of-experts model (~4B of 26B
active per token), ~17 GB loaded, ~29 tokens/s on the Radeon 780M. The tag is Unsloth's UD-Q4_K_XL build
of Google's QAT checkpoint with Gemma's renderer and parser, plus Google's small assistant model for that
checkpoint, which guesses the next few tokens for the model to check (speculative decoding: same
answers, faster writing; [docs/model-scorecard.md](docs/model-scorecard.md)); create it from
[deploy/ollama/gemma4-26b-a4b-ud-64k.Modelfile](deploy/ollama/gemma4-26b-a4b-ud-64k.Modelfile) (the file
says how). It replaced Ollama's library build, `gemma4:26b-a4b-it-qat`, on 2026-10-21: a little faster,
level on accuracy. Chosen with a 158-question French
bench against nine other setups (Gemma 12B, Nemotron, Mistral Small/Nemo, Ministral, Qwen 3, Aya):
153/158 at ~1.2 s per answer. A follow-up grading test found it marks about 1 in 30 correct answers
wrong in fast mode and none with capped thinking, which is what Think: Auto is for. The method, every
result and the design decisions they led to are in [docs/model-selection.md](docs/model-selection.md).
The bench lives in `~/src/other/model-bench/french`, outside this repo, because its answer key comes
from private content.

**Switching the model (admins).** The sidebar shows the model in use; an admin's **Change** opens a
list of every chat model Ollama has pulled (embedding models are left out), with its size and what
it can do: photos (`vision`), Think (`thinking`) and web search (`tools`). A switch is for everyone,
because one model fits in memory: it's stored in the `settings` table, so the api and the worker pick
it up within seconds, and chat, thinking, titles, image descriptions and summaries all use it. What
the new model can't do is turned off for it: images are refused with a message, Think answers fast,
and web search isn't offered. Every API answer carries `X-Hearth-Model`, so other users see a notice
on their next request ("The model is now …"); there is no push. **Memory extraction waits** while a
non-default model is active (a weaker model can merge or invent memories) and catches up later.
**hearth goes back to `HEARTH_MODEL` by itself** once Ollama has unloaded the other model
(`OLLAMA_KEEP_ALIVE`) and no reply has used it for 5 minutes. The same from the console: `hearth model
list | use <model> | reset`.

**Think: Auto / On / Off.** The button next to Send cycles through three settings (remembered per
browser). Thinking replies use `HEARTH_MODEL_THINKING` with reasoning capped by the effort level
(below; Medium's cap is `HEARTH_THINKING_TOKEN_BUDGET`, 200 tokens): at the cap the model is stopped
and asked to answer, with its reasoning passed back as notes. The reasoning is never shown or stored;
the bubble shows "Thinking… N of 200 · Medium" while it runs. Measured: ~12-15 s per reply instead of ~2 s, for grading as accurate as
unlimited thinking, which sometimes ran past five minutes. Background jobs (memory, titles,
summaries) never think, and use `HEARTH_MODEL` unless an admin has switched the model.

- **Auto** (the default) thinks only when the message calls for it, by plain rules in
  `server/think-router.ts`: asking to check, correct or grade French; answering (or disputing) a quiz
  hearth just gave; asking for a French quiz; asking why, or for the exceptions or differences, in a
  French grammar question; asking about wording ("is it correct to say", "don't they use") with any
  French in the message, even a short unquoted phrase like "je m'en voir"; and any message written
  in French, since practising in French with hearth correcting as it goes is the main use. A French
  reply takes ~15-20 s instead of a few seconds. The reply says so ("thought first (auto: checking your French)"). No model
  call decides: a separate classifier request would evict Ollama's cached conversation and cost the
  next reply a full reread. Checked against 50 labelled messages and the owner's real chat history, where it
  picked exactly their 3 French grammar questions out of 23 messages.
- **On** and **Off** override the rules either way.
- A fast reply gets a **↻ Re-answer with thinking** button next to Regenerate, at the current
  effort level: keyword rules miss rephrasings, and a fast reply can misread details (in a search
  result, a date from the wrong row) that a short think catches. It matters most when the reply
  corrects itself mid-answer ("wait, no, that's wrong"), which the button's tooltip points out.
  Like Think harder, it shows only on a reply that arrived on this page; after a reload,
  Regenerate with Think on does the same.

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
the stored message is untouched). So is a note on how long the user was away, when the newest message
comes 3 hours or more after the one before it ("Sent about 4 days after the previous message"): the
history carries no times, so a chat picked up days later otherwise reads as one sitting. After a day
or more the note also asks the model to greet them like someone it missed. A chat's first message
and the first after a break also carry the user's weekday and time ("It's Tuesday 8:34 PM for
Steve", in the server's time zone, `TZ`), so an evening hello isn't answered with "good morning". A
message that mentions something coming up ("I have to start getting ready in 30 minutes", "show's at
8:30, I'll head out in a bit") carries a note that the user is still here and will say when they're
going (`server/coming-up.ts`, keyword rules): without it the model often wrapped the chat up there ("I'll
let you get your things sorted… I'll be here whenever you're back"). The chat
shows the same break as a divider ("4 days later"; `shared/time-gap.ts`). Measured on a ~7k-token chat: follow-ups start in ~1 s at 16k; with
recall in the system prompt every reply reread the whole chat (~22 s), and at 8k the chat no longer
fits, so trimming changed the start every turn (~7 s). Prompts are kept to `HEARTH_CONTEXT_BUDGET`
(16k), and the summarizer scales with it: it summarizes past half the budget and keeps a quarter
verbatim. With Think on, the thinking budget
(and the notes it produces) is held back from the window too.

**Context window vs context budget: 64k loaded, 16k used.** Two settings, because they cost
different things:

- `HEARTH_NUM_CTX` (65536) is the window Ollama loads the model with. It costs memory, not speed:
  15.79 GB loaded at 32k against 15.26 at 16k (two slots), and the same ~24-25 tokens/s
  (2026-10-07). It's 64k to match agent harnesses that use a 64k tag of the same model (via
  `~/.prime/agent/Modelfile.gemma4-26b-a4b-64k`). Ollama keeps one copy per model file and reloads
  it when a request asks for another size, so with hearth at 16k each switch reloaded the model
  (measured 14.6 s and 4.8 s on two switches), emptied the cache, and could evict the embedding
  model (~1 s to bring back). At the same size, a request from either tag loads nothing (0.0 s).
- `HEARTH_CONTEXT_BUDGET` (16384, never more than the window) is how much of it hearth fills:
  history is trimmed to it and the summarizer scales with it. This is what decides speed, because
  a reply rereads its whole prompt when Ollama's cache is empty, at about 275-290 tokens/s here.

The cache is empty after the model was unloaded (`OLLAMA_KEEP_ALIVE=30m`, which also adds 5-15 s to
load it) or after another chat used the model in between. The unsummarized history can grow to half
the budget, so a bigger budget means longer cold rereads:

| Cold reread, chat size | 16k budget (now) | 32k budget |
|---|---|---|
| Short (~1.3-1.5k tokens, measured) | ~5 s | same |
| Just below summarizing | ~30 s (estimated from the rate) | **60.2 s** (measured: 16,970 tokens) |

Add 5-15 s when the model also has to load. The 32k row was measured with a throwaway chat: 61.8 s to
the first word cold, then 2.9 s for a follow-up in the same chat. hearth's token estimate (3.5
characters per token) put that chat at 15.9k; Gemma counted 16,970, about 3.2 characters per token,
so summarizing actually starts ~7% later than hearth thinks. The 1024 tokens held back for the reply
absorb that at either size. With a warm cache both cost the same: only the new message is read. A
32k budget's only gain is fewer summaries (so fewer blurred details).

To change either one:

1. **A bigger budget:** set `HEARTH_CONTEXT_BUDGET=32768` in `.env` and restart hearth (raise
   `HEARTH_NUM_CTX` too if it should go past 32k). The summarizer follows it. Then update the model
   notes here, in `docs/model-selection.md` and in `CLAUDE.md`, and time one reply to a long chat
   after an idle period to replace the estimate above.
2. **Keep the model loaded:** raise `OLLAMA_KEEP_ALIVE` (for example `4h`, or `-1` for never) in
   the Ollama service's systemd drop-in, then `sudo systemctl daemon-reload && sudo systemctl
   restart ollama`. A resumed chat then costs only the reread, and only if something else used
   the model in between. The cost is ~15 GB of RAM held permanently.

**Where settings come from.** `server/config.ts` holds every default; `.env` (gitignored) overrides
them, and values already in the environment override both. `.env.example` documents the same
defaults and isn't read by anything.

The personality is the system prompt in `prompts/system.md` (or the file
`HEARTH_SYSTEM_PROMPT` names). It is re-read on every message, so edits apply
without a restart. `HEARTH_ASSISTANT_NAME` (default `hearth`) is the name the
assistant answers to: it fills `{{name}}` in the prompt (a replacement prompt
can use it too), and the running summary and memory extraction call the
assistant by it. The app itself stays hearth, and the prompt says so. To rename
the assistant, set this rather than copying the whole prompt, which would stop
following changes to the built-in one. Each request sends the system prompt plus as much recent
history as fits in the context window, oldest turns dropped first, with 1024
tokens held back for the reply.

**Long chats.** After each reply, a background job checks the part of the chat not yet summarized.
Past half the context window it folds the oldest messages into a running summary stored on the chat,
keeping the newest quarter of the window verbatim. The summary is a short "Latest" paragraph, rewritten
each fold, and a topic list that only grows: the model writes the new lines and hearth keeps the rest,
dropping the oldest once the summary passes 6,000 characters. Later messages
send the summary, under "Earlier in this conversation", in place of what it covers. `hearth chats
show` prints it. The percentage at the right of the title bar is that unsummarized part against the fold
point (100% = fold; hover or tap it for "N% until auto-compact" and the estimated token count behind it); it's counted the way the summarizer
counts, so it can read past 100% until the summary is written, and drops to around half after a fold. Each fold
also leaves a line in the chat where it happened ("This chat is going strong! I folded the earliest
messages into my notes…", a different wording each time; hover for how many messages it took in).
The folded messages stay on screen; only the model sees the summary in their place. Once the view is
more than a screen above the newest message, **↓ Latest** takes it back down; a chat opens at its newest
message and stays there while it renders. Folds are
recorded in `summary_folds` (since migration 010), so folds from before it have no line.

**Looking back.** The summary keeps a short note and a topic line, so a detail from a couple of
folds back (a name, a time, what hearth recommended) is gone from what the model sees. So folded
messages stay findable (`server/lookback.ts`): wherever summaries are folded, a job every minute cuts
each newly folded message into pieces of up to 500 characters and embeds them with the embedding
model (`message_pieces`, migration 018; "[no extraction]" messages are skipped, as the summary skips
them). For each new message in a chat with a summary, hearth scores those pieces against it and
attaches the best-matching earlier exchanges to the newest message, the way recalled memories ride
on it: at most 3 exchanges and 2,400 characters, each with when it was said, the user's side and
the reply's matching pieces ("…" for what's left out). Nothing is attached when nothing scores at
least 0.45 (cosine, with EmbeddingGemma's task prompts: pieces embedded as documents, the message as
a search query), and it is never stored. The assistant's name (the user's own, from About <name>, else
`HEARTH_ASSISTANT_NAME`) is left out of the message before it's searched: in a short message the name
outweighs the rest, so a question that named the assistant matched every short message that named it
too. The excerpts come with instructions to answer from them when the question is about something
in them, else to reply as usual, and never to comment on them or on how its memory works. When something is attached, the first word comes ~0.6 s
later (the extra ~370 tokens to read); otherwise it costs one ~17 ms embedding. A deploy indexes the folds of existing
chats in the background, the most recently active chat first. Private chats are never folded, so they
have no look-back. A reply that looked back says so above it: **Recalled from earlier in this chat ·
Sat 3:10 PM · 4:05 PM**. Tapping a time opens exactly what the model was shown of that exchange ("…"
for what was left out), and **Show in chat** scrolls to it (folded messages stay on the page) at the
part that matched, with the whole exchange highlighted. The reply keeps those excerpts in
`messages.recalled`: copies of the chat's own words, deleted with it. Replies from before 2026-11-24
kept only the ids, so their times jump straight to the exchange. It
shows while the reply streams (the `recall` event, sent before the first word with the Remembered
list) and after a reload, and a reply that waited on a search card or was stopped part-way keeps it.
"Recalled" is for this chat's own past, "Remembered" for memories. `hearth_lookback_total{outcome}` counts replies with something attached, with
nothing close enough, and failures (embedding down: the reply goes ahead without it).

**Titles.** A chat is first titled from its first message. After the first reply the model writes a
2-6 word title, which reaches the sidebar through the reply stream. A chat that moves on gets a new
one: once it has been quiet for `HEARTH_MEMORY_IDLE_MINUTES` with 4 or more messages since its last
check, the model reads the user's side of the whole chat (up to 100 messages, sampled evenly, each
cut to 200 characters), says whether the title names one of its main subjects, and only if it names
nothing but a passing start (a greeting, a one-off question) writes a new one, naming one subject (`server/retitle.ts`; it runs wherever memory extraction runs, and pauses with
it). The sidebar shows it the next time it loads. A chat the user has renamed is never retitled.

**Renaming.** ✎ in the chat list opens a rename box in place of the title. **Suggest** asks the model
for a title right away, from the same reading of the user's side as above but without the "does it
still fit?" check, since asking means it doesn't (`POST /api/conversations/:id/title-suggestion`;
nothing is saved). Pressing it again asks for a different one: the box sends the current title and
every title it has shown, and the model is told to avoid them. Save a suggestion as it is and the
title is hearth's again, so the chat can be retitled as it moves on (checked again after 4 more
messages); type or edit one and it is yours, never retitled. Escape or Cancel saves nothing. A message
sent with `[no extraction]` is never read for a suggestion. The suggestion is background work, like
the word popup: a reply preempts it, and the box says to try again.

The title bar follows the title with when the chat ran, from its first message
to its last, in the browser's time zone: "(Oct 24 – Oct 27)", or "(Oct 27, 6:14 PM – 9:02 PM)" within a
day; the year shows only when it isn't this one (`shared/chat-span.ts`).

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
searching** makes the model reply from what it knows. Asked for recommendations (music, books, films,
games…), it searches first: from memory about a third of the names it gave didn't exist. The server enforces this: the request waits
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
A last line ties "latest", "next" and "this season" to today's date: without it, "what's the
latest iPhone model?" was searched 1 of 4 times (the rest answered from training); with it 4 of 4,
every query carrying the current year.
Setup: SearXNG in Docker on 127.0.0.1:8888 with `json` in `search.formats`
(`HEARTH_SEARXNG_URL`; `off` never offers the tool).

**Private chats.** **New chat ▾ → New private chat** opens a chat that is never saved: nothing goes
into the database, so it isn't remembered (no memory extraction), summarized, titled, searchable or
in a backup, and `bin/hearth` can't show it. The browser holds the conversation and sends all of it
with each message (`POST /api/private/:chatId/messages`, a random id made by the page); the server
builds the prompt, streams the reply and forgets it. It still reads what hearth already remembers
about you (recall and always-remembered memories), so it knows who "my boss" is, but learns nothing
new. The view is greyer, with a lock in the title bar and a note at the top. Leaving it (or reloading
or closing the tab) ends it, and the page asks first once it has messages. A long private chat drops
its oldest messages to fit, since there's no summary. A reply stops when its connection closes,
because nobody could come back for it. An image works on its own message (and a Regenerate) but isn't
described, so later turns only know one was there. Web search works as usual (asked for, then
approved on the card), but the waiting request is held in server memory only, for an hour; a restart
drops it and Retry asks again. "Not saved" means not on disk in hearth: while a reply is being written
the text passes through Ollama (which keeps it in its cache until other chats push it out) and your
reverse proxy, and an approved search sends its query out like any other.
