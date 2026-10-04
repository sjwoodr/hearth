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

export const config = {
  root,
  host: env('HEARTH_HOST', '127.0.0.1'),
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
  thinkingTokenBudget: Number(env('HEARTH_THINKING_TOKEN_BUDGET', '200')),
  // 16k: long chats fit without trimming, so follow-ups reuse Ollama's cache (~1 s to the first word
  // on a ~7k-token chat, against ~7 s at 8k). Gemma 4's sliding-window attention makes it nearly free:
  // 14.01 GiB loaded against 13.99 at 8k.
  numCtx: Number(env('HEARTH_NUM_CTX', '16384')),
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
  embedModel: env('HEARTH_EMBED_MODEL', 'embeddinggemma:300m-qat-q8_0'),
  memoryIdleMinutes: Number(env('HEARTH_MEMORY_IDLE_MINUTES', '5')),
  systemPromptPath: path.resolve(root, env('HEARTH_SYSTEM_PROMPT', './prompts/system.md')),
  // SearXNG behind the web_search tool; the model asks, the user approves each search. Set to
  // "off" to never offer the tool.
  searxngUrl: env('HEARTH_SEARXNG_URL', 'http://127.0.0.1:8888'),
};
