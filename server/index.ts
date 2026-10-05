import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { parseTrustedProxies, resolveClientIp } from './client-ip.ts';
import { config } from './config.ts';
import { setLogFormat } from './logging.ts';
import { startMetrics, watchOllama, zeroCounters } from './metrics.ts';
import { openDbOrExit } from './db.ts';
import { startMemorySweeper } from './extract.ts';
import { probeModels } from './health.ts';
import { makeImageDescriber } from './images.ts';
import { memoryContext } from './memories.ts';
import { backgroundJobs, connectModels, modelSetupProblem } from './models.ts';
import { ollamaChat, ollamaModelLoaded, ollamaThinkingChat } from './ollama.ts';
import { createSummarizer } from './summarize.ts';
import { makeTitler } from './titles.ts';
import { closeGracefully } from './shutdown.ts';
import { searxngSearch } from './web-search.ts';

setLogFormat(config.logFormat, 'hearth');
startMetrics('hearth');
zeroCounters();
// Through a gateway, the gateway reports Ollama; on its own, hearth does.
if (!config.gatewayUrl) watchOllama(probeModels(config.ollamaUrl, false));

if (config.role !== 'all' && config.role !== 'api') {
  console.error(`HEARTH_ROLE must be "all" or "api" (the worker is \`pnpm worker\`), not "${config.role}".`);
  process.exit(1);
}
const jobs = backgroundJobs(config.role);
const problem = modelSetupProblem(config, config.role === 'api');
if (problem) {
  console.error(problem);
  process.exit(1);
}

let trustedProxies;
try {
  trustedProxies = parseTrustedProxies(config.trustedProxies);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const db = openDbOrExit(config.dbPath, { autoMigrate: config.autoMigrate });
const webSearch = config.searxngUrl === 'off' ? undefined : searxngSearch(config.searxngUrl);
// Every chat-model call goes through a scheduler: replies go first, background work yields.
const models = connectModels(config);
const { embed, json } = models;
const modelLoaded = ollamaModelLoaded(models.endpoint);
const app = createApp({
  db,
  origin: config.origin,
  clientIp: (c) => resolveClientIp(getConnInfo(c).remote.address, c.req.header('x-forwarded-for'), trustedProxies),
  chat: models.asReply(ollamaChat(models.endpoint, config.model, config.numCtx)),
  thinkingChat: models.asReply(ollamaThinkingChat(models.endpoint, config.thinkingModel, config.numCtx, config.thinkingTokenBudget)),
  // Read per request, so edits to the prompt file apply without a restart.
  systemPrompt: () => fs.readFileSync(config.systemPromptPath, 'utf8').trim(),
  numCtx: config.numCtx,
  // Up to ~800 tokens of memories per message, out of the context window.
  memoryContext: (user, message) => memoryContext(db, user, message, embed, 800),
  // The budget itself, plus roughly as much again when the reasoning is handed back as notes.
  thinkingReserve: 2 * config.thinkingTokenBudget + 64,
  titleFor: makeTitler(json),
  describeImages: makeImageDescriber(json),
  // With HEARTH_ROLE=api the worker finds long chats itself (createSummarySweep).
  afterReply: jobs.summariesAfterReply ? createSummarizer(db, json, config.numCtx) : undefined,
  webSearch,
  checkModels: probeModels(config.gatewayUrl || config.ollamaUrl, !!config.gatewayUrl),
  // Says "loading the model" when Ollama has unloaded it (asked alongside each reply).
  modelLoaded: (think) => modelLoaded(think ? config.thinkingModel : config.model),
});
const stopMemories = jobs.memories
  ? startMemorySweeper(db, json, embed, config.memoryIdleMinutes, { paused: models.replyActive })
  : undefined;

// Built front end (pnpm build). In development, Vite serves it and proxies /api here.
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
const clientDir = path.relative(process.cwd(), path.join(config.root, 'dist/client'));
app.use('/*', serveStatic({ root: clientDir }));
app.get('*', serveStatic({ path: path.join(clientDir, 'index.html') }));

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    `hearth listening on http://${info.address}:${info.port} (origin ${config.origin}, model ${config.model}, ` +
      `thinking ${config.thinkingModel} ≤${config.thinkingTokenBudget} tokens, ` +
      `web search ${webSearch ? `${config.searxngUrl}, each search approved by the user` : 'off'}, ` +
      `${models.describe()}${jobs.memories ? '' : ', api only: the worker extracts memories and summarizes'})`,
  );
});
closeGracefully(server, {
  name: 'hearth',
  graceMs: config.shutdownGraceMs,
  beforeClose: () => stopMemories?.(),
  cleanup: () => void db.close(),
});
