// Background-model benchmark: can a smaller model do hearth's memory bookkeeping as well as the chat
// model? Runs the real code (extractMemories, saysTheSame, summarizeIfLong) against each model, on a
// throwaway in-memory database per run, talking to Ollama directly (not through hearth).
//
// What it scores, per model:
// - corrections/extensions: cases whose expect.update names memories that must be rewritten. Pass =
//   every one was updated. Unwanted = any other memory updated (that's the costly mistake).
// - adds: cases with expect.adds "none" count a miss for any new memory; "some" for none at all.
// - keep/avoid (optional, regexes, case-insensitive): every keep must match some memory afterwards
//   (a lasting fact lost); no avoid may match a memory the run added or changed (noise kept). One
//   chat can then hold both, like a live game that ends with "I'm a Notre Dame fan".
// - pairs: the yes/no "same memory?" judge on pairs with a known answer. False "same" merges two
//   different facts (one is lost); false "different" only keeps a duplicate.
// - summaries: written to the results file for reading; only their time is scored.
// - seconds per job and the model's loaded size (`ollama ps`) next to whatever else is loaded.
//
//   node scripts/bench-extraction.ts --models gemma4:26b-a4b-it-qat,gemma4:e2b-it-qat [--runs 3]
//       [--cases scripts/extraction-cases.json,data/bench/extraction-live.json] [--ctx 16384]
//
// Generic cases live in scripts/extraction-cases.json. Cases built from real chats belong in data/
// (gitignored), never in this repo. Embeddings stay on HEARTH_EMBED_MODEL for every model, since only
// the background chat model would change. Results are printed and saved to data/bench/extraction/.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDb, type DB } from '../server/db.ts';
import { extractMemories, saysTheSame } from '../server/extract.ts';
import { ollamaEmbed, ollamaJson } from '../server/ollama.ts';
import { summarizeIfLong } from '../server/summarize.ts';
import { createUser } from '../server/users.ts';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.HEARTH_EMBED_MODEL ?? 'embeddinggemma:300m-qat-q8_0';

const { values: args } = parseArgs({
  options: {
    models: { type: 'string' },
    runs: { type: 'string', default: '3' },
    cases: { type: 'string', default: 'scripts/extraction-cases.json' },
    ctx: { type: 'string', default: '16384' },
  },
});
if (!args.models) {
  console.error('usage: node scripts/bench-extraction.ts --models a,b [--runs 3] [--cases f1,f2] [--ctx 16384]');
  process.exit(1);
}

type Role = 'user' | 'assistant';
type ExtractionCase = {
  name: string;
  user: string;
  memories: Record<string, string>;
  messages: [Role, string][];
  expect: { update: string[]; adds: 'none' | 'some' | 'any'; keep?: string[]; avoid?: string[] };
};
type Pair = { existing: string; candidate: string; same: boolean };
type SummaryCase = { name: string; user: string; messages: [Role, string][]; budget: number };
type Cases = { extraction?: ExtractionCase[]; pairs?: Pair[]; summaries?: SummaryCase[] };

const cases: Required<Cases> = { extraction: [], pairs: [], summaries: [] };
for (const file of args.cases.split(',')) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Cases;
  cases.extraction.push(...(c.extraction ?? []));
  cases.pairs.push(...(c.pairs ?? []));
  cases.summaries.push(...(c.summaries ?? []));
}
const runs = Number(args.runs);
const embed = ollamaEmbed(OLLAMA, EMBED_MODEL);

/** A fresh database holding one user, their memories and one unread conversation. */
async function seed(user: string, memories: Record<string, string>, messages: [Role, string][]) {
  const db = openDb(':memory:', { autoMigrate: true });
  const u = await createUser(db, user, 'a good password for the bench');
  const labels = new Map<number, string>();
  for (const [label, content] of Object.entries(memories)) {
    const id = db.prepare("INSERT INTO memories (user_id, kind, content) VALUES (?, 'fact', ?)").run(u.id, content).lastInsertRowid;
    labels.set(Number(id), label);
  }
  const chat = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(u.id).lastInsertRowid);
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)');
  for (const [role, content] of messages) insert.run(chat, role, content);
  return { db, chat, labels };
}

const memoriesOf = (db: DB) => db.prepare('SELECT id, content FROM memories ORDER BY id').all() as { id: number; content: string }[];

async function loadedGb(model: string): Promise<number | undefined> {
  const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string; size_vram: number }[] };
  const m = ps.models.find((x) => x.name === model);
  return m ? Math.round(m.size_vram / 1e8) / 10 : undefined;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);

const summary: Record<string, unknown>[] = [];
fs.mkdirSync('data/bench/extraction', { recursive: true });

for (const model of args.models.split(',')) {
  const json = ollamaJson(OLLAMA, model, Number(args.ctx));
  console.log(`\n▶ ${model}`);
  await json([{ role: 'user', content: 'Say OK.' }], null); // load it, so no job pays for loading

  const extraction: Record<string, unknown>[] = [];
  const times = { extraction: [] as number[], pair: [] as number[], summary: [] as number[] };
  for (const c of cases.extraction) {
    for (let r = 0; r < runs; r++) {
      const { db, chat, labels } = await seed(c.user, c.memories, c.messages);
      const before = new Map(memoriesOf(db).map((m) => [m.id, m.content]));
      const t = performance.now();
      let error: string | undefined;
      let dropped: { fleeting: number; unstated: number; duplicates: number } | undefined;
      try {
        // What the checks dropped, so a lost fact can be told apart from one the model never proposed.
        const { fleeting, unstated, duplicates } = await extractMemories(db, chat, json, embed);
        dropped = { fleeting, unstated, duplicates };
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      times.extraction.push(performance.now() - t);
      const after = memoriesOf(db);
      const updated = after.filter((m) => before.has(m.id) && before.get(m.id) !== m.content);
      const added = after.filter((m) => !before.has(m.id));
      const updatedLabels = updated.map((m) => labels.get(m.id)!);
      const missing = c.expect.update.filter((l) => !updatedLabels.includes(l));
      const unwanted = updatedLabels.filter((l) => !c.expect.update.includes(l));
      const addMiss = (c.expect.adds === 'none' && added.length > 0) || (c.expect.adds === 'some' && added.length === 0);
      const lost = (c.expect.keep ?? []).filter((k) => !after.some((m) => new RegExp(k, 'i').test(m.content)));
      const changed = [...updated, ...added];
      const noise = (c.expect.avoid ?? []).filter((a) => changed.some((m) => new RegExp(a, 'i').test(m.content)));
      extraction.push({
        case: c.name,
        run: r,
        pass: !error && missing.length === 0 && unwanted.length === 0 && !addMiss && lost.length === 0 && noise.length === 0,
        missing,
        unwanted,
        addMiss,
        lost,
        noise,
        error,
        dropped,
        updated: updated.map((m) => ({ label: labels.get(m.id), content: m.content })),
        added: added.map((m) => m.content),
      });
      process.stdout.write(missing.length || unwanted.length || addMiss || lost.length || noise.length || error ? 'x' : '.');
    }
  }

  const pairs: Record<string, unknown>[] = [];
  for (const p of cases.pairs) {
    for (let r = 0; r < runs; r++) {
      const t = performance.now();
      let said: boolean | undefined;
      try {
        said = await saysTheSame(json, p.existing, p.candidate);
      } catch {
        said = undefined;
      }
      times.pair.push(performance.now() - t);
      pairs.push({ ...p, run: r, said, ok: said === p.same });
      process.stdout.write(said === p.same ? '.' : 'x');
    }
  }

  const summaries: Record<string, unknown>[] = [];
  for (const s of cases.summaries) {
    const { db, chat } = await seed(s.user, {}, s.messages);
    const t = performance.now();
    let error: string | undefined;
    try {
      await summarizeIfLong(db, chat, json, s.budget);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    times.summary.push(performance.now() - t);
    const text = (db.prepare('SELECT summary FROM conversations WHERE id = ?').get(chat) as { summary: string | null }).summary;
    summaries.push({ case: s.name, error, summary: text });
    process.stdout.write(text ? '.' : 'x');
  }
  console.log();

  const gb = await loadedGb(model);
  const kind = (pred: (c: ExtractionCase) => boolean) => {
    const names = new Set(cases.extraction.filter(pred).map((c) => c.name));
    const rows = extraction.filter((e) => names.has(e.case as string));
    return { rows, pass: rows.filter((e) => e.pass).length };
  };
  const count = (k: 'lost' | 'noise') => extraction.reduce((n, e) => n + (e[k] as string[]).length, 0);
  const checks = (k: 'keep' | 'avoid') => cases.extraction.reduce((n, c) => n + (c.expect[k]?.length ?? 0), 0) * runs;
  const toUpdate = kind((c) => c.expect.update.length > 0);
  const controls = kind((c) => c.expect.update.length === 0);
  const row = {
    model,
    'loaded GB': gb ?? '-',
    'updates done': `${toUpdate.pass}/${toUpdate.rows.length}`,
    'clean controls': `${controls.pass}/${controls.rows.length}`,
    'unwanted updates': extraction.reduce((n, e) => n + (e.unwanted as string[]).length, 0),
    'facts lost': `${count('lost')}/${checks('keep')}`,
    'noise kept': `${count('noise')}/${checks('avoid')}`,
    'pairs right': `${pairs.filter((p) => p.ok).length}/${pairs.length}`,
    'false same': pairs.filter((p) => p.said === true && !p.same).length,
    'extract s': (median(times.extraction) / 1000).toFixed(1),
    'pair s': (median(times.pair) / 1000).toFixed(1),
    'summary s': times.summary.length ? (median(times.summary) / 1000).toFixed(1) : '-',
  };
  summary.push(row);
  const file = path.join('data/bench/extraction', `${model.replace(/[:/]/g, '_')}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ model, runs, ctx: Number(args.ctx), row, extraction, pairs, summaries }, null, 2)}\n`);
  console.log(`  saved ${file}`);
  await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => {});
}

console.log('\n══ background-model bench (updates done = corrections and extensions landed on the right memory)');
console.table(summary);
