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

Everything else has defaults (see `values.yaml`). Set `timezone` (e.g. `America/New_York`): hearth
gives the model today's date, and in UTC pods the evening is already tomorrow. `ollama.slots` must equal Ollama's
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

## Metrics

Every process serves Prometheus metrics on `/metrics` (reply and first-word times, tokens/s,
queue waits, preemptions, cache hits, searches, background jobs; see `server/metrics.ts`). With
the Prometheus Operator installed (e.g. kube-prometheus-stack), `metrics.enabled: true` adds
ServiceMonitors for the api and the gateway and a PodMonitor for the worker. The gateway's
`/metrics` needs its bearer token, which its monitor reads from `gateway.tokenSecret`. Metrics keep
hearth's own `service` label (`hearth`, `worker`, `gateway`). If your Prometheus only picks up
monitors with certain labels, add them in `metrics.labels`.

`metrics.dashboard.enabled: true` adds a Grafana dashboard (`files/hearth-dashboard.json`) as a
ConfigMap labelled `grafana_dashboard: "1"`, for Grafana's dashboard sidecar (kube-prometheus-stack
runs one; it has to search hearth's namespace, e.g. `searchNamespace: ALL`). Rows: an overview of
the time range, replies (first word and whole reply by Think, outcomes, searches), the model
(tokens/s, prompt reading as the cache-hit signal, tokens), the scheduler (slots, waits,
preemptions) and background jobs next to the node's memory. A **Window** selector sets the range
for rates and percentiles; with a few replies an hour, 1h or wider reads better than 15m. Orange
markers show where the api started: each deploy (every merge restarts the pods) or a crash. To change
the dashboard, edit it in Grafana, export the JSON (Share → Export), and replace the file.

`metrics.rules.enabled: true` adds alert rules (a PrometheusRule), only for what
kube-prometheus-stack's default rules don't already catch (a target down, crash loops, a failed
Job, node memory and disk):

| Alert | Fires when |
|---|---|
| `HearthOllamaDown` (critical) | Ollama hasn't answered for 5 minutes (`hearth_ollama_up`) |
| `HearthRepliesFailing` (warning) | two or more replies ended in an error in 15 minutes |
| `HearthBackupStale` (warning) | no successful backup for `metrics.rules.backupMaxAgeHours` (36); needs kube-state-metrics |

## Checks

`ci/test-values.yaml` holds complete placeholder values. CI runs:

```sh
helm lint deploy/charts/hearth -f deploy/charts/hearth/ci/test-values.yaml --strict
helm template ci deploy/charts/hearth -f deploy/charts/hearth/ci/test-values.yaml \
  | kubeconform -strict -summary -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
helm unittest deploy/charts/hearth      # tests/: placement, host networking, required values, monitors
```
