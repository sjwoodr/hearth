// The background worker: `pnpm worker`. Runs memory extraction and running summaries in their own
// process, so the api (HEARTH_ROLE=api) only serves chats. Chat titles and image descriptions stay
// in the api: a title goes to the client on the reply's own stream, and an undescribed image exists
// only in the memory of the api process that received it. Needs the gateway, so these jobs still
// yield to replies from the other process.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.ts';
import { setLogFormat } from './logging.ts';
import { startMetrics, zeroCounters } from './metrics.ts';
import { openDbOrExit } from './db.ts';
import { probeModels, registerHealthRoutes } from './health.ts';
import { startMemorySweeper } from './extract.ts';
import { connectModels, modelSetupProblem } from './models.ts';
import { closeGracefully } from './shutdown.ts';
import { startSummarySweeper } from './summarize.ts';

setLogFormat(config.logFormat, 'worker');
startMetrics('worker');
zeroCounters();

const problem = modelSetupProblem(config, true);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const db = openDbOrExit(config.dbPath, { autoMigrate: config.autoMigrate });
const models = connectModels(config);
const stopMemories = startMemorySweeper(db, models.json, models.embed, config.memoryIdleMinutes, { paused: models.replyActive });
const stopSummaries = startSummarySweeper(db, models.json, config.contextBudget);
// Only health endpoints, for probes. Its server also keeps the process alive.
const health = new Hono();
registerHealthRoutes(health, { db, models: probeModels(config.gatewayUrl, true) });
const server = serve({ fetch: health.fetch, hostname: config.host, port: config.workerPort }, (info) => {
  console.log(
    `hearth worker running: memories after ${config.memoryIdleMinutes} idle minutes, summaries for long chats ` +
      `(checked every minute, ${models.describe()}); health on http://${info.address}:${info.port}`,
  );
});
// A job in flight when the worker stops is cut off: it writes nothing (each write is one
// transaction) and the next worker picks the chat up again.
closeGracefully(server, {
  name: 'worker',
  graceMs: config.shutdownGraceMs,
  beforeClose: () => {
    stopMemories();
    stopSummaries();
  },
  cleanup: () => void db.close(),
});
