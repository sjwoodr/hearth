# API tests (Bruno)

A [Bruno](https://www.usebruno.com/) collection that exercises hearth's HTTP API end to end:
health and metrics, sign-in (including the login throttle's message and the CSRF check),
conversations, memories, one real chat reply through the model, and cleanup. 27 requests,
32 tests. Bruno 4 format (OpenCollection YAML), so each request is a readable `.yml` file here.

## Set up

1. **A test user.** The run signs in, creates a conversation and a memory, and deletes them again.
   Use a user of its own, not yours:
   ```
   bin/hearth users add bruno                                            # local (dev database)
   kubectl -n hearth exec -it deploy/hearth-api -- bin/hearth users add bruno   # the cluster
   ```
2. **`bruno/.env`.** Copy `.env.example` to `.env` here and fill it in: `HEARTH_USERNAME` and
   `HEARTH_PASSWORD` for the test user, `HEARTH_URL` for the cluster's address (its
   `HEARTH_ORIGIN`). `.env` is gitignored, so none of it reaches the repo. Bruno reads it when it
   opens the collection: reopen the collection after editing it.
3. **Open the collection** in Bruno (Open Collection → this `bruno/` folder) and pick an
   environment (top right):
   - `local`: `pnpm dev:fullstack` (backend on :8787, `origin` = `HEARTH_ORIGIN`).
   - `cluster`: through the ingress at `HEARTH_URL`. Health is at `healthUrl`, the api pod itself,
     because the ingress routes only `/` and `/api`:
     `kubectl -n hearth port-forward deploy/hearth-api 18787:8787` (18787, so it doesn't clash with a
     local dev server on 8787). Without it, the Health requests stop with that command
     as the error.

## Run

Run the whole collection (collection menu → Run). The order matters: **Auth** signs in and the
session cookie carries the folders after it; **Cleanup** deletes the conversation and signs out.
A single request works on its own once you have signed in (Auth → login).

- **Chat (uses the model)** sends one real message with thinking off, so Ollama must be up. If
  the model was unloaded, that reply also waits ~16 s for it to load.
- **Without `bruno/.env`** (or with a key missing), "login" stops before sending and says which
  key to add; the requests after it then fail as signed out.
- **The login throttle:** misses count per user name (5) and per address (20) in 15 minutes.
  "login (unknown user)" uses a new made-up name each run, so it never locks the test user,
  but 20 runs in 15 minutes from one address will lock that address until the window passes.
- From the command line, with Bruno's CLI (`npm i -g @usebruno/cli`):
  ```
  cd bruno && bru run --env local      # reads bruno/.env too
  cd bruno && bru run --env cluster
  ```

## What it checks

| Folder | Requests |
|---|---|
| Health | `/healthz`, `/readyz` (database and models), `/metrics` (counters present, starting at 0) |
| Auth | signed out → 401; login without a password → 400; unknown user → 401 with the same message as a wrong password; a cross-site form post → 403 (CSRF); login → 200 with an httpOnly, SameSite=Lax cookie; `/api/me` |
| Conversations | create, list, rename (and an empty title → 400), get, an unknown id → 404 |
| Memories | add, a bad kind → 400, list, edit (whitespace tidied), delete |
| Chat (uses the model) | a message streams as NDJSON (`start`, `delta`, `done`, no `error`) and answers; both messages saved; an empty message → 400 |
| Cleanup | delete the conversation → then 404; logout → `/api/me` is 401 again |
