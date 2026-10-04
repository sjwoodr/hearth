// How a hearth process reaches the models: Ollama directly with an in-process scheduler (one
// process, the default), or the model gateway, which schedules every process's calls. Shared by
// the api (index.ts) and the worker (worker.ts) so both are wired the same way.
import { createModelScheduler } from './busy.ts';
import type { config as appConfig } from './config.ts';
import { ollamaEmbed, ollamaJson, type ChatFn, type Endpoint, type JsonFn } from './ollama.ts';

type Config = typeof appConfig;

/** Why this setup can't run, or undefined if it can. `separate` = api or worker in their own process. */
export function modelSetupProblem(config: Config, separate: boolean): string | undefined {
  if (config.gatewayUrl && !config.gatewayToken) {
    return 'HEARTH_GATEWAY_URL is set but HEARTH_GATEWAY_TOKEN is not: the gateway would refuse every call.';
  }
  if (separate && !config.gatewayUrl) {
    return (
      'Running the api and the worker as separate processes needs the model gateway (HEARTH_GATEWAY_URL): ' +
      "without it, background jobs can't see the other process's replies, so they would never yield to them."
    );
  }
  return undefined;
}

/**
 * Which background jobs the main process runs for a role. "all" runs everything; "api" leaves memory
 * extraction and summaries to the worker. Titles and image descriptions always stay with the api
 * (a title goes out on the reply's stream; an undescribed image lives only in that process).
 */
export function backgroundJobs(role: string) {
  const all = role === 'all';
  return { memories: all, summariesAfterReply: all };
}

export function connectModels(config: Config) {
  // With a gateway it schedules every hearth process's calls; without one, this process schedules its own.
  const endpoint: Endpoint = config.gatewayUrl ? { url: config.gatewayUrl, token: config.gatewayToken } : config.ollamaUrl;
  const scheduler = config.gatewayUrl ? undefined : createModelScheduler({ slots: config.ollamaSlots });
  const asBackground = (fn: JsonFn) => (scheduler ? scheduler.background(fn) : fn);
  return {
    endpoint,
    asReply: (fn: ChatFn) => (scheduler ? scheduler.chat(fn) : fn),
    // Background sweeps hold off while a reply is active. With a gateway this process can't see other
    // processes' replies, but the gateway preempts for them anyway.
    replyActive: () => scheduler?.replyActive() ?? false,
    json: asBackground(ollamaJson(endpoint, config.model, config.numCtx)),
    // Embeddings go through the gateway too when there is one, so only the gateway reaches Ollama.
    embed: ollamaEmbed(endpoint, config.embedModel),
    describe: () =>
      config.gatewayUrl ? `models via the gateway at ${config.gatewayUrl}` : `${config.ollamaSlots} Ollama slot${config.ollamaSlots === 1 ? '' : 's'}`,
  };
}
