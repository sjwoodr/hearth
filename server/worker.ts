// The background worker: `pnpm worker`. Runs memory extraction and running summaries in their own
// process, so the api (HEARTH_ROLE=api) only serves chats. Chat titles and image descriptions stay
// in the api: a title goes to the client on the reply's own stream, and an undescribed image exists
// only in the memory of the api process that received it. Needs the gateway, so these jobs still
// yield to replies from the other process.
import { config } from './config.ts';
import { openDbOrExit } from './db.ts';
import { startMemorySweeper } from './extract.ts';
import { connectModels, modelSetupProblem } from './models.ts';
import { startSummarySweeper } from './summarize.ts';

const problem = modelSetupProblem(config, true);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const db = openDbOrExit(config.dbPath, { autoMigrate: config.autoMigrate });
const models = connectModels(config);
startMemorySweeper(db, models.json, models.embed, config.memoryIdleMinutes, { paused: models.replyActive });
// Its timer keeps the worker process alive (the memory sweeper's doesn't: the api has its server).
startSummarySweeper(db, models.json, config.numCtx);
console.log(
  `hearth worker running: memories after ${config.memoryIdleMinutes} idle minutes, summaries for long chats ` +
    `(checked every minute, ${models.describe()})`,
);
