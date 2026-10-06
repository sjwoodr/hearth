# hearth as plain Kubernetes manifests

hearth on a single-node k3s cluster, as plain YAML you can read top to bottom. The Helm chart in
[`../charts/hearth`](../charts/hearth) deploys the same thing with values and hooks; these files are
the version without either, for learning or for a cluster without Helm.

Assumed: one machine running k3s with its bundled Traefik, and Ollama installed on that machine
(outside Kubernetes) with hearth's models pulled. A wildcard certificate as Traefik's default
(a `TLSStore`) gives the Ingress real HTTPS without a `tls` section.

| File | What |
|---|---|
| `00-namespace.yaml` | the `hearth` namespace |
| `01-config.yaml` | settings for api, worker and migrate (a ConfigMap) |
| `02-migrate-job.yaml` | applies database migrations, then exits |
| `10-gateway.yaml` | the model gateway (host network, to reach Ollama on 127.0.0.1) |
| `11-api.yaml`, `12-worker.yaml`, `13-web.yaml` | the three services |
| `20-ingress.yaml` | `/api` to the api, `/` to the front end, on Traefik's internal door |
| `30-backup-cronjob.yaml` | a nightly consistent copy of the database |

## Install

On the machine:

```
# The data folder, owned by the uid the containers run as. The SQLite file lives here.
sudo mkdir -p /var/lib/hearth && sudo chown 1000:1000 /var/lib/hearth

# Ollama runs two requests at once; HEARTH_OLLAMA_SLOTS in 10-gateway.yaml must match.
#   (OLLAMA_NUM_PARALLEL=2 in Ollama's systemd service settings)
```

Edit `01-config.yaml` (`HEARTH_ORIGIN`) and `20-ingress.yaml` (the host) for your address, then:

```
kubectl apply -f 00-namespace.yaml -f 01-config.yaml

# The token between hearth and its gateway. Never commit it.
kubectl -n hearth create secret generic hearth-gateway --from-literal=token="$(openssl rand -hex 32)"

# Migrations first, and wait for them: the api and worker refuse to start on an old schema.
kubectl apply -f 02-migrate-job.yaml
kubectl -n hearth wait --for=condition=complete job/hearth-migrate --timeout=120s

# Everything else.
kubectl apply -f 10-gateway.yaml -f 11-api.yaml -f 12-worker.yaml -f 13-web.yaml \
  -f 20-ingress.yaml -f 30-backup-cronjob.yaml
kubectl -n hearth rollout status deploy --timeout=180s

# Your account.
kubectl -n hearth exec -it deploy/hearth-api -- bin/hearth users add <you>
```

Open `https://hearth.example.com` (your host) from the home network.

## Upgrade

Change the image tag in every file that names it (`sha-...`), then run the migrations before the
new version starts:

```
kubectl -n hearth delete job hearth-migrate --ignore-not-found
kubectl apply -f 02-migrate-job.yaml
kubectl -n hearth wait --for=condition=complete job/hearth-migrate --timeout=120s
kubectl apply -f .
```

A ConfigMap change doesn't restart anything on its own:
`kubectl -n hearth rollout restart deploy/hearth-api deploy/hearth-worker`.

The Helm chart does all three for you (one tag in values, the migration as a hook, and a checksum
that restarts pods when settings change), which is most of the reason it exists.
