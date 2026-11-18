import { describe, expect, it } from 'vitest';
import { createModelChoice } from './active-model.ts';
import { getNotes, MAX_NOTES_CHARS, NOTES_INSTRUCTIONS, PrivateNotes, saveNotes } from './chat-notes.ts';
import { openDb, type DB } from './db.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';

// Spoiler-like text the app must never hand to the browser, wherever it looks.
const PLAN = 'SPOILER-7f3a: the baker did it, for the inheritance. Clues: flour (ch. 1), a torn apron (ch. 2).';

type Event = { type: string; text?: string; query?: string; error?: string };

async function events(res: Response): Promise<{ raw: string; list: Event[] }> {
  const raw = await res.text();
  return { raw, list: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Event) };
}

const newChat = async (app: TestApp, cookie: string) =>
  ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;

const say = async (app: TestApp, cookie: string, id: number, content: string, extra: object = {}) =>
  events(await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content, ...extra }));

const userId = (db: DB, name: string) => (db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number }).id;

describe('chat notes', () => {
  it('keeps what the model saves, then lets it carry on and write the reply', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    ctx.model.reply = ['Chapitre 1. ', 'Le fromage a disparu.'];

    const first = await say(ctx.app, alice, id, 'Plan the mystery in your notes, then write chapter 1.');
    expect(first.list.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toBe(PLAN);

    // Two model calls: the one that saved, then the same prompt with the tool turn, answered "Saved.".
    const [saving, writing] = ctx.model.calls;
    expect(saving![0]!.content).toContain(NOTES_INSTRUCTIONS);
    expect(writing!.slice(0, -2)).toEqual(saving);
    expect(writing!.slice(-2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'save_notes', arguments: { notes: PLAN } } }] },
      { role: 'tool', tool_name: 'save_notes', content: 'Saved.' },
    ]);
    // Only the chapter is stored as the reply.
    const chat = (await (await call(ctx.app, alice, 'GET', `/conversations/${id}`)).json()) as { messages: { content: string }[] };
    expect(chat.messages.map((m) => m.content).at(-1)).toBe('Chapitre 1. Le fromage a disparu.');

    // Next turn: the notes ride on the newest message, and the earlier one reads as stored.
    ctx.model.reply = ['Chapitre 2.'];
    await say(ctx.app, alice, id, 'Next chapter please.');
    const next = ctx.model.calls.at(-1)!;
    expect(next[0]!.content).toBe(saving![0]!.content); // the system prompt didn't change: the cache holds
    expect(next.at(-1)!.content).toBe(`[Your notes for this chat; only you can see them]\n${PLAN}\n\n[alice's message]\nNext chapter please.`);
    expect(next.find((m) => m.content.includes('Plan the mystery'))!.content).toBe('Plan the mystery in your notes, then write chapter 1.');
  });

  it('never puts the notes in anything the app reads', async () => {
    const ctx = setupApp({ webSearch: true });
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    const res = await call(ctx.app, alice, 'POST', `/conversations/${id}/messages`, { content: 'Plan a riddle and keep the answer to yourself.' });
    expect(JSON.stringify([...res.headers]) + (await res.text())).not.toContain('SPOILER');
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toBe(PLAN);

    // Every GET the client makes, with searches aimed at the notes' own words.
    for (const path of ['/conversations', `/conversations/${id}`, '/memories', '/me', '/search?q=SPOILER', '/search?q=baker']) {
      const res = await call(ctx.app, alice, 'GET', path);
      expect(res.status, path).toBe(200);
      // Headers too: anything the browser receives is one devtools click from being read.
      const seen = JSON.stringify([...res.headers]) + (await res.text());
      expect(seen, path).not.toMatch(/SPOILER|baker|inheritance/);
    }
    expect(ctx.db.prepare("SELECT count(*) AS n FROM messages WHERE content LIKE '%SPOILER%'").get()).toEqual({ n: 0 });
  });

  it("keeps each user's notes to their own chats", async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    await signIn(ctx, 'bob');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    await say(ctx.app, alice, id, 'Plan it.');

    const bob = userId(ctx.db, 'bob');
    expect(getNotes(ctx.db, bob, id)).toBe('');
    expect(saveNotes(ctx.db, bob, id, 'overwritten by bob')).toBe(false);
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toBe(PLAN);
  });

  it('goes with the chat when it is deleted', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    await say(ctx.app, alice, id, 'Plan it.');
    expect((await call(ctx.app, alice, 'DELETE', `/conversations/${id}`)).status).toBe(200);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM chat_notes').get()).toEqual({ n: 0 });
  });

  it('clips notes to the cap', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = ['x'.repeat(MAX_NOTES_CHARS + 500)];
    await say(ctx.app, alice, id, 'Plan it.');
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toHaveLength(MAX_NOTES_CHARS);
  });

  it('stops a model that only keeps saving, instead of looping', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = ['one', 'two', 'three', 'four', 'five'];
    const { list } = await say(ctx.app, alice, id, 'Plan it.');
    expect(ctx.model.calls).toHaveLength(3); // the first save and two more rounds, then it has to answer
    expect(list.at(-1)!.type).toBe('error');
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toBe('three');
  });

  it('saves and carries on when thinking, too', async () => {
    const ctx = setupApp({ thinkingBudgets: { medium: 50, high: 100, max: 200 } });
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    const { list } = await say(ctx.app, alice, id, 'Plan it.', { think: true });
    expect(ctx.model.thinkingCalls).toHaveLength(2);
    expect(list.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('Considered answer.');
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toBe(PLAN);
  });

  it('keeps the notes turn when a search follows it, through the card and after', async () => {
    const ctx = setupApp({ webSearch: true });
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    ctx.model.asks = ['Fishbach tour dates'];
    const asked = await say(ctx.app, alice, id, 'Plan a quiz on her tour, check the dates first.');
    expect(asked.list.at(-1)).toMatchObject({ type: 'search', query: 'Fishbach tour dates' });
    expect(getNotes(ctx.db, userId(ctx.db, 'alice'), id)).toBe(PLAN);

    const answered = await events(await call(ctx.app, alice, 'POST', `/conversations/${id}/search`, { approve: true }));
    expect(answered.list.at(-1)!.type).toBe('done');
    // The prompt after the search: the notes' tool turn, then the search's, in order.
    const tail = ctx.model.calls.at(-1)!.slice(-4);
    expect(tail.map((m) => `${m.role}:${m.tool_calls?.[0]?.function.name ?? m.tool_name ?? ''}`)).toEqual([
      'assistant:save_notes',
      'tool:save_notes',
      'assistant:web_search',
      'tool:web_search',
    ]);
  });

  it("offers neither the tool nor its instructions to a model that can't call tools", async () => {
    const db = openDb(':memory:');
    const ctx = setupApp({
      db,
      modelChoice: createModelChoice(db, 'plain:7b'),
      models: [{ name: 'plain:7b', size: 1, capabilities: ['completion'] }],
    });
    const alice = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, alice);
    ctx.model.saves = [PLAN];
    await say(ctx.app, alice, id, 'Plan it.');
    expect(ctx.model.notesOffered).toEqual([false]);
    expect(ctx.model.calls[0]![0]!.content).not.toContain('## Your notes');
    expect(getNotes(db, userId(db, 'alice'), id)).toBe('');
  });
});

describe('private chat notes', () => {
  const CHAT = 'private-notes-1';
  const send = async (app: TestApp, cookie: string, messages: object[]) =>
    events(await call(app, cookie, 'POST', `/private/${CHAT}/messages`, { messages }));

  it('lives in server memory for the chat, never the database, and ends with it', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const rows = () => ctx.db.prepare('SELECT count(*) AS n FROM chat_notes').get();
    ctx.model.saves = [PLAN];
    ctx.model.reply = ['Riddle one.'];
    await send(ctx.app, alice, [{ role: 'user', content: 'Plan a riddle.' }]);
    expect(rows()).toEqual({ n: 0 });

    ctx.model.reply = ['Not quite.'];
    const history = [
      { role: 'user', content: 'Plan a riddle.' },
      { role: 'assistant', content: 'Riddle one.' },
      { role: 'user', content: 'Is it a candle?' },
    ];
    await send(ctx.app, alice, history);
    expect(ctx.model.calls.at(-1)!.at(-1)!.content).toContain(PLAN);

    // Another user's private chat with the same id has no notes.
    const bob = await signIn(ctx, 'bob');
    await send(ctx.app, bob, history);
    expect(ctx.model.calls.at(-1)!.at(-1)!.content).not.toContain('SPOILER');

    expect((await call(ctx.app, alice, 'DELETE', `/private/${CHAT}`)).status).toBe(200);
    await send(ctx.app, alice, history);
    expect(ctx.model.calls.at(-1)!.at(-1)!.content).not.toContain('SPOILER');
    expect(rows()).toEqual({ n: 0 });
  });

  it('forgets notes left idle for half a day', () => {
    let now = new Date('2026-11-17T20:00:00Z');
    const notes = new PrivateNotes(() => now);
    notes.set('private:1:a', 'plan');
    now = new Date('2026-11-18T07:59:00Z');
    expect(notes.get('private:1:a')).toBe('plan'); // read, so idle again from here
    now = new Date('2026-11-18T19:58:00Z');
    expect(notes.get('private:1:a')).toBe('plan');
    now = new Date('2026-11-19T08:00:00Z');
    expect(notes.get('private:1:a')).toBe('');
  });
});
