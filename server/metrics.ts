// Prometheus metrics, served at /metrics by the api, the worker and the gateway. One registry per
// process; each process labels its series with `service`. The numbers are the ones this project
// has been measuring by hand: reply speed, Ollama's cache (prompt reading time), queueing and
// preemption, searches asked vs approved, and how background jobs fare.
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Context } from 'hono';
import type { ModelScheduler } from './busy.ts';
import { EFFORTS } from '../shared/think-effort.ts';

export const registry = new Registry();

/** Labels every series with the process's role and adds Node's process metrics (CPU, memory, event loop). */
export function startMetrics(service: string) {
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
}

const registers = [registry];
// Seconds: a fast reply is ~1 s, a thinking one ~12 s, a cold model load ~16 s.
const SECONDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];

export const replySeconds = new Histogram({
  name: 'hearth_reply_seconds',
  help: 'Time from a reply starting to its last word (or the search card).',
  labelNames: ['think', 'effort'],
  buckets: SECONDS,
  registers,
});
export const replyFirstTokenSeconds = new Histogram({
  name: 'hearth_reply_first_token_seconds',
  help: 'Time from a reply starting to its first word: waiting, recall, prompt reading.',
  labelNames: ['think', 'effort'],
  buckets: SECONDS,
  registers,
});
export const replies = new Counter({
  name: 'hearth_replies_total',
  help: 'Replies by how they ended: done, search (a card was shown), error, stopped. effort: the Think level (none when not thinking).',
  labelNames: ['outcome', 'think', 'effort'],
  registers,
});

export const searches = new Counter({
  name: 'hearth_searches_total',
  help: 'Web searches: asked for by the model, approved or declined by the user, failed.',
  labelNames: ['outcome'],
  registers,
});

export const backgroundJobs = new Counter({
  name: 'hearth_background_jobs_total',
  help: 'Background jobs by outcome (ok, preempted, failed): memory, summary, title, image.',
  labelNames: ['job', 'outcome'],
  registers,
});
export const job = (name: 'memory' | 'summary' | 'title' | 'image', outcome: 'ok' | 'preempted' | 'failed') =>
  backgroundJobs.inc({ job: name, outcome });

export const modelTokensPerSecond = new Histogram({
  name: 'hearth_model_tokens_per_second',
  help: "Generation speed, from Ollama's own count (eval_count / eval_duration).",
  labelNames: ['kind'],
  buckets: [2, 5, 10, 15, 20, 25, 30, 40, 60],
  registers,
});
export const modelPromptSeconds = new Histogram({
  name: 'hearth_model_prompt_seconds',
  help: "Time Ollama spent reading the prompt: short when its cache held the conversation, long when it reread it.",
  labelNames: ['kind'],
  buckets: SECONDS,
  registers,
});
export const modelTokens = new Counter({
  name: 'hearth_model_tokens_total',
  help: 'Tokens generated.',
  labelNames: ['kind'],
  registers,
});

/** Ollama's final line (or non-streamed reply) carries its timings; record them. */
export function recordModelStats(kind: 'reply' | 'background', stats: { eval_count?: number; eval_duration?: number; prompt_eval_duration?: number }) {
  if (stats.eval_count && stats.eval_duration) {
    modelTokensPerSecond.observe({ kind }, stats.eval_count / (stats.eval_duration / 1e9));
    modelTokens.inc({ kind }, stats.eval_count);
  }
  if (stats.prompt_eval_duration !== undefined) modelPromptSeconds.observe({ kind }, stats.prompt_eval_duration / 1e9);
}

export const slotWaitSeconds = new Histogram({
  name: 'hearth_model_slot_wait_seconds',
  help: 'Time a model call waited for a slot.',
  labelNames: ['kind'],
  buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 600],
  registers,
});
export const preemptions = new Counter({
  name: 'hearth_model_preemptions_total',
  help: 'Background calls cancelled so a reply could have their slot.',
  registers,
});
export const overdueBackground = new Counter({
  name: 'hearth_model_overdue_background_total',
  help: 'Background calls that waited past the limit and ran next, unpreemptible.',
  registers,
});

/** The hooks a ModelScheduler reports through (in-process, or in the gateway). */
export const schedulerHooks = {
  onStart: (kind: 'reply' | 'background', waitedMs: number) => slotWaitSeconds.observe({ kind }, waitedMs / 1000),
  onPreempt: () => preemptions.inc(),
  onOverdue: () => overdueBackground.inc(),
};

/** Live slot gauges, read from the scheduler at scrape time. */
export function watchScheduler(scheduler: ModelScheduler) {
  new Gauge({
    name: 'hearth_model_slots',
    help: 'Slots the scheduler hands out (must equal Ollama OLLAMA_NUM_PARALLEL).',
    registers,
    collect() {
      this.set(scheduler.slots);
    },
  });
  const byKind = (name: string, help: string, read: (s: ReturnType<ModelScheduler['stats']>) => [number, number]) =>
    new Gauge({
      name,
      help,
      labelNames: ['kind'],
      registers,
      collect() {
        const [reply, background] = read(scheduler.stats());
        this.set({ kind: 'reply' }, reply);
        this.set({ kind: 'background' }, background);
      },
    });
  byKind('hearth_model_running', 'Model calls holding a slot.', (s) => [s.runningReplies, s.runningBackground]);
  byKind('hearth_model_waiting', 'Model calls waiting for a slot.', (s) => [s.waitingReplies, s.waitingBackground]);
}

/**
 * Starts every known label combination of the counters at 0, so "none yet" is a 0, not a missing
 * series: a panel shows zeros instead of "No data", and `increase()` counts the first event after
 * a restart (from a missing series to 1 it sees no increase). For the api and the worker; the
 * gateway counts none of these.
 */
export function zeroCounters() {
  for (const outcome of ['done', 'search', 'error', 'stopped'])
    for (const effort of ['none', ...EFFORTS]) replies.inc({ outcome, think: String(effort !== 'none'), effort }, 0);
  for (const outcome of ['asked', 'approved', 'declined', 'failed']) searches.inc({ outcome }, 0);
  for (const name of ['memory', 'summary', 'title', 'image'] as const)
    for (const outcome of ['ok', 'preempted', 'failed'] as const) backgroundJobs.inc({ job: name, outcome }, 0);
}

/**
 * hearth_ollama_up: 1 when Ollama answers, 0 when not, probed at each scrape. Registered by the
 * process that talks to Ollama itself: the gateway, or hearth on its own without one.
 */
export function watchOllama(probe: () => Promise<string | undefined>) {
  new Gauge({
    name: 'hearth_ollama_up',
    help: 'Whether Ollama answered at the last scrape (1) or not (0).',
    registers,
    async collect() {
      this.set((await probe()) === undefined ? 1 : 0);
    },
  });
}

/** The /metrics response. */
export async function metricsResponse(c: Context) {
  return c.body(await registry.metrics(), 200, { 'Content-Type': registry.contentType });
}
