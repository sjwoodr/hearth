// Which of a user's memories memory extraction is shown (memoriesToShow in extract.ts), and the
// always-remembered allowance the Memories page reports (shared/memory-budget.ts). Made-up data only.
import { describe, expect, it } from 'vitest';
import { PreemptedError } from './busy.ts';
import { openDb, type DB } from './db.ts';
import { extractMemories, MAX_EXISTING_SHOWN } from './extract.ts';
import type { ChatMessage, EmbedFn, JsonFn } from './ollama.ts';
import { createUser } from './users.ts';
import { alwaysUse, MEMORY_BUDGET_CHARS, MEMORY_BUDGET_TOKENS, RECALL_ROOM_TOKENS } from '../shared/memory-budget.ts';

// A toy embedding: one dimension per topic word, plus a small constant so nothing is all zeros.
const TOPICS = ['civic', 'subaru', 'cello', 'lisbon'];
const vector = (t: string) => [...TOPICS.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01];

async function seed(fillers: number, extra: { content: string; kind?: 'fact' | 'profile'; age: string }[] = []) {
  const db = openDb(':memory:');
  const userId = (await createUser(db, 'sam', 'a good password')).id;
  const add = db.prepare("INSERT INTO memories (user_id, kind, content, updated_at) VALUES (?, ?, ?, ?)");
  // The extras are the oldest; fillers changed recently, one a minute.
  for (const e of extra) add.run(userId, e.kind ?? 'fact', e.content, e.age);
  for (let i = 0; i < fillers; i++) add.run(userId, 'fact', `Sam enjoys hobby number ${i}.`, `2026-11-01 00:${String(i % 60).padStart(2, '0')}:00`);
  const chat = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid);
  const say = db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', '-10 minutes'))");
  say.run(chat, 'user', 'I sold my Civic last month, I drive a Subaru now.');
  say.run(chat, 'assistant', 'A Subaru suits Florida rain.');
  return { db, chat };
}

/** Runs extraction with a model that changes nothing; returns the memories it was shown. */
async function shown(db: DB, chat: number, embed?: EmbedFn): Promise<string[]> {
  let listed = '';
  const json: JsonFn = async (messages: ChatMessage[]) => {
    const prompt = messages.at(-1)!.content;
    if (prompt.startsWith('Existing memories:')) listed = prompt.split('\n\nNew conversation:')[0]!;
    if (messages[0]!.content.startsWith('You keep the character sheet')) return { facts: [] };
    return { add: [], update: [] };
  };
  await extractMemories(db, chat, json, embed);
  return listed.split('\n').slice(1);
}

const embedding: EmbedFn = async (texts) => texts.map(vector);

describe('the memories extraction is shown', () => {
  it(`are all of them up to ${MAX_EXISTING_SHOWN}, newest-changed first, without embedding anything`, async () => {
    const { db, chat } = await seed(MAX_EXISTING_SHOWN - 1, [{ content: 'Sam drives a Honda Civic.', age: '2020-01-01 00:00:00' }]);
    let embedded = 0;
    const lines = await shown(db, chat, async (texts) => ((embedded += texts.length), texts.map(vector)));
    expect(lines).toHaveLength(MAX_EXISTING_SHOWN);
    expect(lines.at(-1)).toMatch(/Honda Civic/);
    expect(embedded).toBe(0);
  });

  it(`past ${MAX_EXISTING_SHOWN}, include an old memory the chat is about`, async () => {
    const { db, chat } = await seed(MAX_EXISTING_SHOWN + 40, [{ content: 'Sam drives a Honda Civic.', age: '2020-01-01 00:00:00' }]);
    const lines = await shown(db, chat, embedding);
    expect(lines).toHaveLength(MAX_EXISTING_SHOWN);
    expect(lines.some((l) => l.includes('Honda Civic'))).toBe(true);
    // Still listed newest-changed first, so the oldest comes last.
    expect(lines.at(-1)).toMatch(/Honda Civic/);
  });

  it('always include the always-remembered ones, however unrelated', async () => {
    const { db, chat } = await seed(MAX_EXISTING_SHOWN + 40, [
      { content: 'Sam lives in Naples.', kind: 'profile', age: '2019-01-01 00:00:00' },
      { content: 'Sam drives a Honda Civic.', age: '2020-01-01 00:00:00' },
    ]);
    const lines = await shown(db, chat, embedding);
    expect(lines.some((l) => l.includes('(profile) Sam lives in Naples.'))).toBe(true);
    expect(lines.some((l) => l.includes('Honda Civic'))).toBe(true);
  });

  it('fall back to the newest-changed when embedding fails, and a preemption still stops the run', async () => {
    const { db, chat } = await seed(MAX_EXISTING_SHOWN + 40, [{ content: 'Sam drives a Honda Civic.', age: '2020-01-01 00:00:00' }]);
    let calls = 0;
    // The duplicate check embeds too; only the first call (the matching) fails.
    const failsFirst: EmbedFn = async (texts) => {
      if (calls++ === 0) throw new Error('embedding model is down');
      return texts.map(vector);
    };
    const lines = await shown(db, chat, failsFirst);
    expect(lines).toHaveLength(MAX_EXISTING_SHOWN);
    expect(lines.some((l) => l.includes('Honda Civic'))).toBe(false);

    // A fresh chat: the run above marked the first one read.
    const again = await seed(MAX_EXISTING_SHOWN + 40, [{ content: 'Sam drives a Honda Civic.', age: '2020-01-01 00:00:00' }]);
    const preempted: EmbedFn = async () => {
      throw new PreemptedError();
    };
    await expect(shown(again.db, again.chat, preempted)).rejects.toBeInstanceOf(PreemptedError);
  });
});

describe('the always-remembered allowance', () => {
  const ofTokens = (tokens: number) => 'x'.repeat(Math.round((tokens - 4) * 3.5));

  it('counts characters, and warns before and past the limit', () => {
    expect(MEMORY_BUDGET_CHARS).toBe(2800);
    expect(alwaysUse([])).toEqual({ chars: 0, state: 'ok' });
    expect(alwaysUse(['Sam lives in Naples, Florida'])).toEqual({ chars: 28, state: 'ok' });
    const roomy = MEMORY_BUDGET_TOKENS - RECALL_ROOM_TOKENS;
    expect(alwaysUse([ofTokens(roomy)]).state).toBe('ok');
    expect(alwaysUse([ofTokens(roomy + 2)]).state).toBe('crowding');
    expect(alwaysUse([ofTokens(MEMORY_BUDGET_TOKENS)]).state).toBe('crowding');
    expect(alwaysUse([ofTokens(MEMORY_BUDGET_TOKENS / 2), ofTokens(MEMORY_BUDGET_TOKENS / 2 + 2)]).state).toBe('over');
  });
});
