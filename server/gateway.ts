// The model gateway: an Ollama-compatible HTTP server in front of Ollama that owns its slots. Every
// hearth process (api replicas, the worker) sends model calls here instead of to Ollama, so one
// scheduler sees all of them: replies first, background work preempted, turns between users.
//
// It speaks Ollama's API, so a client only changes its base URL and adds three headers:
//   Authorization: Bearer <HEARTH_GATEWAY_TOKEN>   required on /api/*: the gateway runs with host
//                                                  networking on a LAN with no host firewall, and
//                                                  without the token it would expose Ollama to it
//   X-Hearth-Priority: reply | background          absent means background
//   X-Hearth-User: <user id>                       for turns between users
// Differences from plain Ollama:
//   - a streamed reply waiting for a slot first gets lines {"hearth":{"queued":<position>}}
//   - a preempted background call gets {"error":"preempted"} (HTTP 409, or as a stream line)
// Embeddings and other endpoints pass straight through: the embedding model runs apart from the
// chat slots. Only /api/chat and /api/generate are scheduled.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import type { ModelScheduler } from './busy.ts';
import { metricsResponse } from './metrics.ts';

export const PREEMPTED = 'preempted';

export type GatewayOptions = {
  /** Ollama's base URL, e.g. http://127.0.0.1:11434. */
  upstream: string;
  token: string;
  scheduler: ModelScheduler;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

const digest = (text: string) => createHash('sha256').update(text).digest();
// Hashing first gives equal lengths, so the comparison takes the same time whatever was sent.
const sameToken = (sent: string, token: string) => timingSafeEqual(digest(sent), digest(token));

type Forward = (c: Context, path: string, body: string | undefined, signal?: AbortSignal) => Promise<Response>;

/** What a scheduled request asks for, read from its headers and body. */
type Call = {
  priority: 'reply' | 'background';
  userId?: number;
  body: string;
  path: string;
  streamed: boolean;
};

// Reads a scheduled request, or returns the 400 to send instead.
async function readCall(c: Context): Promise<Call | Response> {
  const priority = c.req.header('x-hearth-priority') ?? 'background';
  if (priority !== 'reply' && priority !== 'background') {
    return c.json({ error: 'X-Hearth-Priority must be "reply" or "background".' }, 400);
  }
  const userHeader = c.req.header('x-hearth-user');
  const userId = userHeader && /^\d+$/.test(userHeader) ? Number(userHeader) : undefined;
  const body = await c.req.text();
  try {
    // Ollama streams unless told not to.
    const streamed = (JSON.parse(body) as { stream?: boolean }).stream !== false;
    return { priority, userId, body, path: new URL(c.req.url).pathname, streamed };
  } catch {
    return c.json({ error: 'The request body must be JSON.' }, 400);
  }
}

// A non-streamed call (background jobs): one answer, or 409 if a reply preempted it.
async function proxyOnce(c: Context, call: Call, scheduler: ModelScheduler, forward: Forward) {
  const lease = await scheduler.lease(call.priority, { userId: call.userId, signal: c.req.raw.signal });
  try {
    if (lease.isPreempted()) return c.json({ error: PREEMPTED }, 409);
    const res = await forward(c, call.path, call.body, lease.signal);
    const text = await res.text();
    // However the abort surfaced (a rejected fetch, or an error response), preempted is the answer.
    if (lease.isPreempted()) return c.json({ error: PREEMPTED }, 409);
    return c.body(text, res.status as 200, { 'Content-Type': res.headers.get('content-type') ?? 'application/json' });
  } catch (err) {
    if (lease.isPreempted()) return c.json({ error: PREEMPTED }, 409);
    return c.json({ error: `The gateway couldn't reach Ollama: ${message(err)}` }, 502);
  } finally {
    lease.release();
  }
}

// A streamed call (replies): queue lines while waiting, then Ollama's lines byte for byte.
function proxyStream(c: Context, call: Call, scheduler: ModelScheduler, forward: Forward) {
  const clientGone = c.req.raw.signal;
  c.header('Content-Type', 'application/x-ndjson');
  return stream(c, async (s) => {
    let writes: Promise<unknown> = Promise.resolve();
    const line = (event: object) =>
      (writes = writes.then(() => s.write(`${JSON.stringify(event)}\n`)).catch(() => undefined));
    let lease;
    try {
      lease = await scheduler.lease(call.priority, {
        userId: call.userId,
        signal: clientGone,
        onQueued: (position) => void line({ hearth: { queued: position } }),
      });
    } catch {
      return; // the client left while queued
    }
    try {
      if (lease.isPreempted()) return void (await line({ error: PREEMPTED }));
      const res = await forward(c, call.path, call.body, lease.signal);
      await writes;
      if (!res.ok || !res.body) return void (await line({ error: `Ollama returned ${res.status}: ${await res.text()}` }));
      for await (const chunk of res.body) await s.write(chunk);
      if (lease.isPreempted()) await line({ error: PREEMPTED });
    } catch (err) {
      if (lease.isPreempted()) await line({ error: PREEMPTED });
      else if (!clientGone.aborted) await line({ error: `The gateway lost Ollama: ${message(err)}` });
    } finally {
      lease.release();
      await writes;
    }
  });
}

export function createGateway(opts: GatewayOptions) {
  const upstreamFetch = opts.fetch ?? fetch;
  const app = new Hono();

  // Open, so a probe can check the process is up; it reaches no model.
  app.get('/healthz', (c) => c.json({ ok: true, ...opts.scheduler.stats() }));

  const tokenRequired = async (c: Context, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const sent = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!sent || !sameToken(sent, opts.token)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  };
  app.use('/api/*', tokenRequired);
  // Behind the token too (unlike the api's): the gateway's port is on the LAN, with no firewall.
  app.get('/metrics', tokenRequired, metricsResponse);

  const forward: Forward = (c, path, body, signal) =>
    upstreamFetch(`${opts.upstream}${path}`, {
      method: c.req.method,
      // Only the content type goes on: never the caller's Authorization header.
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body,
      signal,
    });

  const scheduled = async (c: Context) => {
    const call = await readCall(c);
    if (call instanceof Response) return call;
    return call.streamed ? proxyStream(c, call, opts.scheduler, forward) : proxyOnce(c, call, opts.scheduler, forward);
  };
  app.post('/api/chat', scheduled);
  app.post('/api/generate', scheduled);

  // Everything else (embeddings, tags, version, show) goes straight through, unscheduled.
  app.all('/api/*', async (c) => {
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.text();
    try {
      const res = await forward(c, new URL(c.req.url).pathname, body, c.req.raw.signal);
      return c.body(await res.arrayBuffer(), res.status as 200, {
        'Content-Type': res.headers.get('content-type') ?? 'application/json',
      });
    } catch (err) {
      return c.json({ error: `The gateway couldn't reach Ollama: ${message(err)}` }, 502);
    }
  });

  return app;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
