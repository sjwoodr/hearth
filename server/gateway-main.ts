// Runs the model gateway (server/gateway.ts): `pnpm gateway`. Optional for one hearth process,
// which schedules in-process; needed once several processes share Ollama.
import { serve } from '@hono/node-server';
import { createModelScheduler } from './busy.ts';
import { config } from './config.ts';
import { createGateway } from './gateway.ts';

if (!config.gatewayToken) {
  console.error('HEARTH_GATEWAY_TOKEN is not set. The gateway never runs without one: it would expose Ollama.');
  process.exit(1);
}

const scheduler = createModelScheduler({ slots: config.ollamaSlots });
const app = createGateway({ upstream: config.ollamaUrl, token: config.gatewayToken, scheduler });

serve({ fetch: app.fetch, hostname: config.gatewayHost, port: config.gatewayPort }, (info) => {
  const slots = `${config.ollamaSlots} slot${config.ollamaSlots === 1 ? '' : 's'}`;
  console.log(`hearth gateway listening on http://${info.address}:${info.port} (Ollama ${config.ollamaUrl}, ${slots})`);
});
