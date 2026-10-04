import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { createModelScheduler } from './busy.ts';
import { resolveClientIp } from './client-ip.ts';
import { config } from './config.ts';
import { openDbOrExit } from './db.ts';
import { startMemorySweeper } from './extract.ts';
import { makeImageDescriber } from './images.ts';
import { memoryContext } from './memories.ts';
import { ollamaChat, ollamaEmbed, ollamaJson, ollamaThinkingChat } from './ollama.ts';
import { createSummarizer } from './summarize.ts';
import { makeTitler } from './titles.ts';
import { searxngSearch } from './web-search.ts';

const db = openDbOrExit(config.dbPath, { autoMigrate: config.autoMigrate });
const webSearch = config.searxngUrl === 'off' ? undefined : searxngSearch(config.searxngUrl);
const embed = ollamaEmbed(config.ollamaUrl, config.embedModel);
// Every chat-model call goes through the scheduler: replies go first, background work yields.
const model = createModelScheduler({ slots: config.ollamaSlots });
const json = model.background(ollamaJson(config.ollamaUrl, config.model, config.numCtx));
const app = createApp({
  db,
  origin: config.origin,
  clientIp: (c) => resolveClientIp(getConnInfo(c).remote.address, c.req.header('x-forwarded-for')),
  chat: model.chat(ollamaChat(config.ollamaUrl, config.model, config.numCtx)),
  thinkingChat: model.chat(
    ollamaThinkingChat(config.ollamaUrl, config.thinkingModel, config.numCtx, config.thinkingTokenBudget),
  ),
  // Read per request, so edits to the prompt file apply without a restart.
  systemPrompt: () => fs.readFileSync(config.systemPromptPath, 'utf8').trim(),
  numCtx: config.numCtx,
  // Up to ~800 tokens of memories per message, out of the context window.
  memoryContext: (user, message) => memoryContext(db, user, message, embed, 800),
  // The budget itself, plus roughly as much again when the reasoning is handed back as notes.
  thinkingReserve: 2 * config.thinkingTokenBudget + 64,
  titleFor: makeTitler(json),
  describeImages: makeImageDescriber(json),
  afterReply: createSummarizer(db, json, config.numCtx),
  webSearch,
});
startMemorySweeper(db, json, embed, config.memoryIdleMinutes, { paused: model.replyActive });

// Built front end (pnpm build). In development, Vite serves it and proxies /api here.
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
const clientDir = path.relative(process.cwd(), path.join(config.root, 'dist/client'));
app.use('/*', serveStatic({ root: clientDir }));
app.get('*', serveStatic({ path: path.join(clientDir, 'index.html') }));

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    `hearth listening on http://${info.address}:${info.port} (origin ${config.origin}, model ${config.model}, ` +
      `thinking ${config.thinkingModel} ≤${config.thinkingTokenBudget} tokens, ` +
      `web search ${webSearch ? `${config.searxngUrl}, each search approved by the user` : 'off'}, ` +
      `${config.ollamaSlots} Ollama slot${config.ollamaSlots === 1 ? '' : 's'})`,
  );
});
