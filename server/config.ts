import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Values already in the environment win over .env (loadEnvFile never overwrites).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const isOff = (value: string) => ['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());

const numCtx = Number(env('HEARTH_NUM_CTX', '32768'));

export const config = {
  root,
  host: env('HEARTH_HOST', '127.0.0.1'),
  // Proxies allowed to say who the client is (X-Forwarded-For), as addresses or CIDR ranges. The
  // default trusts only this machine. Behind a Kubernetes ingress, add the pod network
  // ("127.0.0.0/8, ::1/128, 10.42.0.0/16" on k3s), or every client shares one login-throttle bucket.
  trustedProxies: env('HEARTH_TRUSTED_PROXIES', '127.0.0.0/8, ::1/128'),
  port: Number(env('HEARTH_PORT', '8787')),
  origin: env('HEARTH_ORIGIN', 'http://localhost:5180'),
  dbPath: path.resolve(root, env('HEARTH_DB_PATH', './data/hearth.db')),
  // Apply pending migrations on start (the default, fine for one process). A deployment sets 0 and
  // runs `pnpm migrate` as its own step; hearth then only checks the schema version.
  autoMigrate: !isOff(env('HEARTH_AUTO_MIGRATE', '1')),
  ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434'),
  // Chosen by the French bench (docs/model-selection.md): 153/158 at 1.2 s/answer.
  model: env('HEARTH_MODEL', 'gemma4:26b-a4b-it-qat'),
  // Used, with thinking on, when the in-app Think toggle is on. The same model as HEARTH_MODEL keeps
  // one copy in memory; a different one loads a second model.
  thinkingModel: env('HEARTH_MODEL_THINKING', env('HEARTH_MODEL', 'gemma4:26b-a4b-it-qat')),
  // Reasoning-token caps for the three Think effort levels (shared/think-effort.ts). Medium's 200 kept
  // all of unlimited thinking's grading accuracy on the French bench; High and Max are unmeasured.
  thinkingBudgets: {
    medium: Number(env('HEARTH_THINKING_TOKEN_BUDGET', '200')),
    high: Number(env('HEARTH_THINKING_TOKEN_BUDGET_HIGH', '400')),
    max: Number(env('HEARTH_THINKING_TOKEN_BUDGET_MAX', '800')),
  },
  // The context window Ollama loads the model with. 32k matches the 32k tag agent harnesses (pi) use
  // for the same model: Ollama keeps one copy per model file and reloads it for a request at another
  // size, so mismatched sizes evicted each other (5-15 s load, then a cold reread). With 2 slots it
  // loads at 15.79 GB against 15.26 at 16k, with the same generation speed (2026-10-07).
  numCtx,
  // How much of that window hearth fills: history is trimmed to it and the summarizer scales with it
  // (summarize past half, keep a quarter). 16k: long chats fit without trimming, so follow-ups reuse
  // Ollama's cache (~1 s to the first word on a ~7k-token chat, against ~7 s at 8k), while a cold
  // reread stays ~30 s at worst instead of the ~60 s measured for a chat grown to 32k's limit.
  // Never more than numCtx.
  contextBudget: Math.min(Number(env('HEARTH_CONTEXT_BUDGET', '16384')), numCtx),
  // Requests Ollama runs at once. Must equal Ollama's OLLAMA_NUM_PARALLEL: more than that and Ollama
  // queues internally, out of the scheduler's sight, so a reply could wait behind background work.
  ollamaSlots: Number(env('HEARTH_OLLAMA_SLOTS', '1')),
  // The model gateway (server/gateway-main.ts, `pnpm gateway`): where it listens, and the token
  // every caller must send. It refuses to start without a token.
  gatewayHost: env('HEARTH_GATEWAY_HOST', '127.0.0.1'),
  gatewayPort: Number(env('HEARTH_GATEWAY_PORT', '11435')),
  gatewayToken: env('HEARTH_GATEWAY_TOKEN', ''),
  // Set, hearth sends every model call (embeddings too) to the gateway instead of Ollama and leaves
  // scheduling to it; unset (one process), hearth schedules in-process and talks to Ollama directly.
  gatewayUrl: env('HEARTH_GATEWAY_URL', ''),
  // What `node server/index.ts` runs: "all" (the default: the API plus every background job) or
  // "api" (the API, chat titles and image descriptions; memory extraction and summaries are left to
  // the worker, `pnpm worker`). Separate processes need the gateway.
  role: env('HEARTH_ROLE', 'all'),
  // The worker's health endpoints (/healthz, /readyz) for probes; it serves nothing else.
  workerPort: Number(env('HEARTH_WORKER_PORT', '8788')),
  // On SIGTERM, how long open requests (a streaming reply) get to finish before they're cut off.
  // Keep it under the supervisor's limit: Kubernetes kills after 30 s by default.
  shutdownGraceMs: Number(env('HEARTH_SHUTDOWN_GRACE_MS', '25000')),
  // "text" (default): readable lines for a terminal. "json": one JSON object per line, for Loki.
  logFormat: env('HEARTH_LOG_FORMAT', 'text'),
  embedModel: env('HEARTH_EMBED_MODEL', 'embeddinggemma:300m-qat-q8_0'),
  memoryIdleMinutes: Number(env('HEARTH_MEMORY_IDLE_MINUTES', '5')),
  systemPromptPath: path.resolve(root, env('HEARTH_SYSTEM_PROMPT', './prompts/system.md')),
  // SearXNG behind the web_search tool; the model asks, the user approves each search. Set to
  // "off" to never offer the tool.
  searxngUrl: env('HEARTH_SEARXNG_URL', 'http://127.0.0.1:8888'),
};
