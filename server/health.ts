// Health endpoints for a process supervisor (Kubernetes probes, docker compose), outside /api:
// no login, no CSRF. Used by the api (index.ts) and the worker (worker.ts).
//   /healthz  the process is up. Liveness: touches nothing that could hang.
//   /readyz   the database answers and its schema matches this code: 503 otherwise, so traffic
//             goes elsewhere. Whether the models are reachable is reported, but doesn't fail it:
//             with Ollama down hearth can still show chats and memories, and failing readiness
//             would take the whole UI offline over one dependency.
//   /metrics  Prometheus metrics (server/metrics.ts). Unauthenticated: the api's and worker's
//             ports aren't reachable through the ingress, which routes only / and /api.
import type { Env, Hono } from 'hono';
import { checkSchema, type DB } from './db.ts';
import { metricsResponse } from './metrics.ts';

/** Resolves undefined when the models are reachable, or a short reason when not. */
export type ModelsProbe = () => Promise<string | undefined>;

export function registerHealthRoutes<E extends Env>(app: Hono<E>, opts: { db: DB; models?: ModelsProbe }) {
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/metrics', metricsResponse);
  app.get('/readyz', async (c) => {
    let database = 'ok';
    try {
      opts.db.prepare('SELECT 1').get();
      checkSchema(opts.db);
    } catch (err) {
      database = err instanceof Error ? err.message : String(err);
    }
    const models = opts.models ? ((await opts.models().catch((err: unknown) => String(err))) ?? 'ok') : undefined;
    const ready = database === 'ok';
    return c.json({ ready, checks: { database, ...(models !== undefined ? { models } : {}) } }, ready ? 200 : 503);
  });
}

/**
 * Probes the models: the gateway's /healthz (no token needed) or Ollama's /api/version, with a
 * short timeout so a hung dependency can't hang the probe.
 */
export function probeModels(url: string, viaGateway: boolean, timeoutMs = 2000): ModelsProbe {
  return async () => {
    try {
      const res = await fetch(`${url}${viaGateway ? '/healthz' : '/api/version'}`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? undefined : `${viaGateway ? 'gateway' : 'Ollama'} returned ${res.status}`;
    } catch (err) {
      return `${viaGateway ? 'gateway' : 'Ollama'} unreachable: ${err instanceof Error ? err.message : err}`;
    }
  };
}
