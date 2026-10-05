# hearth Helm chart

Runs hearth on Kubernetes as the services `compose.services.yml` runs on one machine: the model
**gateway** (owns Ollama's slots), the **api**, the **worker** (memory extraction and summaries),
the **web** front end, a **migrate** hook and a nightly **backup** CronJob. Built for a small
cluster where one node has Ollama, a GPU and the data (tested on k3s with Traefik).

## What you provide

| Value | Why |
|---|---|
| `image.tag` | A commit tag CI pushed (`sha-<short>`). `main` and `latest` are refused, so a deploy is always a known build. |
| `origin` | The URL people open. CSRF checks and secure cookies depend on it. |
| `placement` | `nodeSelector` (and a toleration if tainted) for the node with Ollama and the data. The gateway, api, worker, migrate and backup all run there: the gateway reaches Ollama on that node's `127.0.0.1`, and SQLite needs every writer on one kernel. |
| `persistence.hostPath` **or** `persistence.existingClaim` | Where the database lives. The chart never creates this volume, so `helm uninstall` (or removing the app from Argo CD) can't delete your data. A host folder must exist and be writable by uid 1000. |
| `gateway.tokenSecret.name` | A Secret with a long random bearer token (key `token`). The gateway uses host networking, so it listens on the node's addresses; the token is what keeps others out. |
| `ingress.host` | The hostname for the Ingress (`/api` → api, `/` → web). Add your ingress controller's TLS annotations or a `tls` block. |

Everything else has defaults (see `values.yaml`): `ollama.slots` must equal Ollama's
`OLLAMA_NUM_PARALLEL`; `searxngUrl` enables web search; `env` passes extra `HEARTH_*` settings;
`systemPrompt` replaces the built-in prompt with a mounted file.

## Install

```sh
kubectl create namespace hearth
kubectl -n hearth create secret generic hearth-gateway --from-literal=token="$(openssl rand -hex 32)"
helm install hearth deploy/charts/hearth -n hearth -f my-values.yaml
kubectl -n hearth exec -it deploy/hearth-api -- bin/hearth users add <name>
```

Upgrades run the migrate Job first (a `pre-upgrade` hook; Argo CD runs Helm hooks as `PreSync`),
then roll the pods. The api and worker refuse to start on an older schema, so a failed migration
stops the rollout instead of running new code on an old database.

## Backups

The CronJob writes consistent copies (SQLite's online backup) to `<data>/backups/hearth-*.db` and
keeps `backup.keepDays` days. Copy those files offsite, not the live `hearth.db`.

## Checks

`ci/test-values.yaml` holds complete placeholder values. CI runs:

```sh
helm lint deploy/charts/hearth -f deploy/charts/hearth/ci/test-values.yaml --strict
helm template ci deploy/charts/hearth -f deploy/charts/hearth/ci/test-values.yaml | kubeconform -strict -summary
helm unittest deploy/charts/hearth      # tests/: placement, host networking, required values
```
