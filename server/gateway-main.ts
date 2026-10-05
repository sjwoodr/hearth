// Runs the model gateway (server/gateway.ts): `pnpm gateway`. Optional for one hearth process,
// which schedules in-process; needed once several processes share Ollama.
import { serve } from '@hono/node-server';
import { createModelScheduler } from './busy.ts';
import { config } from './config.ts';
import { setLogFormat } from './logging.ts';
import { createGateway } from './gateway.ts';
import { probeModels } from './health.ts';
import { schedulerHooks, startMetrics, watchOllama, watchScheduler } from './metrics.ts';
import { closeGracefully } from './shutdown.ts';

setLogFormat(config.logFormat, 'gateway');

if (!config.gatewayToken) {
  console.error('HEARTH_GATEWAY_TOKEN is not set. The gateway never runs without one: it would expose Ollama.');
  process.exit(1);
}

startMetrics('gateway');
const scheduler = createModelScheduler({ slots: config.ollamaSlots, ...schedulerHooks });
watchScheduler(scheduler);
watchOllama(probeModels(config.ollamaUrl, false));
const app = createGateway({ upstream: config.ollamaUrl, token: config.gatewayToken, scheduler });

const server = serve({ fetch: app.fetch, hostname: config.gatewayHost, port: config.gatewayPort }, (info) => {
  const slots = `${config.ollamaSlots} slot${config.ollamaSlots === 1 ? '' : 's'}`;
  console.log(`hearth gateway listening on http://${info.address}:${info.port} (Ollama ${config.ollamaUrl}, ${slots})`);
});
// Replies streaming through the gateway get to finish before it stops.
closeGracefully(server, { name: 'gateway', graceMs: config.shutdownGraceMs });
