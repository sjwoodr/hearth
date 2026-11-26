// The lines under a reply that say what it drew on: "Recalled from earlier in this chat" (look-back)
// and "Remembered" (memories recalled for it). Sent as a `recall` event and kept on the reply: what the
// model was shown of each earlier exchange, and memory ids, read back with each memory's current wording. Every chat here is made up.
import { describe, expect, it } from 'vitest';
import type { DB } from './db.ts';
import type { Recalled } from './lookback.ts';
import { addMemory, deleteMemory, memoryContext, updateMemory } from './memories.ts';
import type { EmbedFn } from './ollama.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';
import { createUser, nameOf } from './users.ts';

type Event = { type: string; recalled?: Recalled[]; remembered?: { id: number; content: string }[]; messageId?: number };
type Stored = { messages: { id: number; role: string; recalled: Recalled[]; remembered: { id: number; content: string }[] }[] };

async function post(app: TestApp, cookie: string, path: string, body: object) {
  const res = await call(app, cookie, 'POST', path, body);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Event);
}
const stored = async (app: TestApp, cookie: string, id: number) =>
  (await (await call(app, cookie, 'GET', `/conversations/${id}`)).json()) as Stored;
const newChat = async (app: TestApp, cookie: string) =>
  ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
const userId = (db: DB, name: string) => (db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number }).id;
const columns = (db: DB, id: number) => db.prepare('SELECT recalled, remembered FROM messages WHERE id = ?').get(id);

const shown = (start: number): Recalled => ({ start, best: start, said: [{ role: 'user', text: 'Our dog Waffles sees the vet Thursday at 10.' }] });

/** A chat with one exchange folded into its summary, and Alice's memory about her dog. */
async function setup(opts: { webSearch?: boolean } = {}) {
  const ctx = setupApp(opts);
  const cookie = await signIn(ctx, 'alice');
  const id = await newChat(ctx.app, cookie);
  await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'Our dog Waffles sees the vet Thursday at 10.' });
  const [earlier] = (await stored(ctx.app, cookie, id)).messages;
  ctx.db.prepare("UPDATE conversations SET summary = 'Earlier notes.', summary_through_message_id = ? WHERE id = ?").run(earlier!.id + 1, id);
  const memory = addMemory(ctx.db, userId(ctx.db, 'alice'), 'fact', 'Has a beagle mix called Waffles');
  return { ...ctx, cookie, id, earlier: earlier!.id, memory };
}

describe('what a reply drew on', () => {
  it('is sent before the reply, kept on it as ids, and read back with the memory as it reads now', async () => {
    const ctx = await setup();
    ctx.model.lookedBack = { text: '[Earlier in this chat: the vet on Thursday.]', recalled: [shown(ctx.earlier)] };
    ctx.model.remembered = [{ id: ctx.memory.id, content: ctx.memory.content }];
    const events = await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'When was the vet again?' });

    const recall = events.find((e) => e.type === 'recall');
    expect(recall).toEqual({ type: 'recall', recalled: [shown(ctx.earlier)], remembered: [{ id: ctx.memory.id, content: 'Has a beagle mix called Waffles' }] });
    expect(events.findIndex((e) => e.type === 'recall')).toBeLessThan(events.findIndex((e) => e.type === 'delta'));
    const done = events.find((e) => e.type === 'done')!;
    expect(columns(ctx.db, done.messageId!)).toEqual({ recalled: JSON.stringify([shown(ctx.earlier)]), remembered: `[${ctx.memory.id}]` });

    const reply = () => stored(ctx.app, ctx.cookie, ctx.id).then((s) => s.messages.find((m) => m.id === done.messageId)!);
    expect(await reply()).toMatchObject({ recalled: [shown(ctx.earlier)], remembered: [{ id: ctx.memory.id, content: 'Has a beagle mix called Waffles' }] });
    // Edited since: the new wording. Deleted: gone from the line.
    updateMemory(ctx.db, userId(ctx.db, 'alice'), ctx.memory.id, { content: 'Has a nine-year-old beagle mix called Waffles' });
    expect((await reply()).remembered).toEqual([{ id: ctx.memory.id, content: 'Has a nine-year-old beagle mix called Waffles' }]);
    deleteMemory(ctx.db, userId(ctx.db, 'alice'), ctx.memory.id);
    expect((await reply()).remembered).toEqual([]);
    expect((await reply()).recalled).toEqual([shown(ctx.earlier)]);
    // A reply from before excerpts were kept holds a bare id: it still reads, with nothing to show.
    ctx.db.prepare('UPDATE messages SET recalled = ? WHERE id = ?').run(`[${ctx.earlier}]`, done.messageId);
    expect((await reply()).recalled).toEqual([{ start: ctx.earlier, best: ctx.earlier, said: [] }]);
  });

  it('sends and keeps nothing when the reply drew on nothing', async () => {
    const ctx = await setup();
    const events = await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'Hello again' });
    expect(events.some((e) => e.type === 'recall')).toBe(false);
    const done = events.find((e) => e.type === 'done')!;
    expect(columns(ctx.db, done.messageId!)).toEqual({ recalled: null, remembered: null });
    expect((await stored(ctx.app, ctx.cookie, ctx.id)).messages.at(-1)).toMatchObject({ recalled: [], remembered: [] });
  });

  it("never shows another user's memory, even if its id were on the reply", async () => {
    const ctx = await setup();
    const bob = await createUser(ctx.db, 'bob', 'a good password');
    const theirs = addMemory(ctx.db, bob.id, 'fact', "Bob's secret recipe");
    ctx.model.remembered = [{ id: ctx.memory.id, content: ctx.memory.content }];
    const done = (await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'hi' })).find((e) => e.type === 'done')!;
    ctx.db.prepare('UPDATE messages SET remembered = ? WHERE id = ?').run(JSON.stringify([ctx.memory.id, theirs.id]), done.messageId);
    const body = JSON.stringify(await stored(ctx.app, ctx.cookie, ctx.id));
    expect(body).toContain('Has a beagle mix called Waffles');
    expect(body).not.toContain('secret recipe');
  });

  it('a reply that waited on a search card keeps its lines, across a restart too', async () => {
    const ctx = await setup({ webSearch: true });
    ctx.model.lookedBack = { text: '[Earlier: the vet.]', recalled: [shown(ctx.earlier)] };
    ctx.model.remembered = [{ id: ctx.memory.id, content: ctx.memory.content }];
    ctx.model.asks.push('vet opening hours');
    const asked = await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'Is the vet open late?' });
    expect(asked.at(-1)?.type).toBe('search');

    // Same database, empty server memory.
    const after = setupApp({ webSearch: true, db: ctx.db });
    const events = await post(after.app, ctx.cookie, `/conversations/${ctx.id}/search`, { approve: true });
    expect(events.find((e) => e.type === 'recall')).toMatchObject({ recalled: [shown(ctx.earlier)], remembered: [{ id: ctx.memory.id }] });
    const done = events.find((e) => e.type === 'done')!;
    expect(columns(ctx.db, done.messageId!)).toEqual({ recalled: JSON.stringify([shown(ctx.earlier)]), remembered: `[${ctx.memory.id}]` });
  });

  it('so does one answered without the search it asked for, and one stopped part-way', async () => {
    const ctx = await setup({ webSearch: true });
    ctx.model.remembered = [{ id: ctx.memory.id, content: ctx.memory.content }];
    ctx.model.asks.push('vet opening hours');
    await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'Is the vet open late?' });
    const declined = await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/search`, { approve: false });
    const done = declined.find((e) => e.type === 'done')!;
    expect(columns(ctx.db, done.messageId!)).toEqual({ recalled: null, remembered: `[${ctx.memory.id}]` });

    ctx.model.reply = ['Thursday', ' at', ' ten', '.', ' And', ' more', ' words', '.'];
    ctx.model.chunkDelayMs = 20;
    const replying = Promise.resolve(call(ctx.app, ctx.cookie, 'POST', `/conversations/${ctx.id}/messages`, { content: 'When again?' })).then(
      (r) => r.text(),
    );
    await new Promise((r) => setTimeout(r, 60));
    await call(ctx.app, ctx.cookie, 'POST', `/conversations/${ctx.id}/stop`);
    const stopped = (await replying)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Event)
      .find((e) => e.type === 'stopped')!;
    expect(stopped.messageId).toBeDefined();
    expect(columns(ctx.db, stopped.messageId!)).toEqual({ recalled: null, remembered: `[${ctx.memory.id}]` });
  });

  it('a private chat gets the Remembered line but stores nothing', async () => {
    const ctx = await setup();
    ctx.model.remembered = [{ id: ctx.memory.id, content: ctx.memory.content }];
    const before = ctx.db.prepare('SELECT count(*) AS n FROM messages').get();
    const events = await post(ctx.app, ctx.cookie, '/private/a1b2c3d4-private/messages', { messages: [{ role: 'user', content: 'how is Waffles?' }] });
    expect(events.find((e) => e.type === 'recall')).toEqual({ type: 'recall', recalled: [], remembered: [{ id: ctx.memory.id, content: ctx.memory.content }] });
    expect(ctx.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual(before);
    expect(ctx.model.lookBackQueries).toHaveLength(0);
  });
});

describe('memoryContext reports what it recalled', () => {
  // Which of a few words a text has.
  const WORDS = ['waffles', 'vet', 'paris', 'hearth'];
  const embed: EmbedFn = async (texts) => texts.map((t) => [...WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01]);

  it('the facts recalled for this message, the user\'s and the assistant\'s, never the always-remembered ones', async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    const dog = addMemory(ctx.db, alice.id, 'fact', 'Has a dog called Waffles who sees the vet');
    addMemory(ctx.db, alice.id, 'fact', 'Went to Paris in 2019');
    addMemory(ctx.db, alice.id, 'profile', 'Is learning French, and Waffles is her dog');
    const self = addMemory(ctx.db, alice.id, 'fact', 'Hearth likes hearing about Waffles', null, 'assistant');
    const { remembered } = await memoryContext(ctx.db, { id: alice.id, name: nameOf(alice) }, 'how is Waffles?', embed, 800);
    expect(remembered).toEqual([
      { id: dog.id, content: dog.content },
      { id: self.id, content: self.content },
    ]);
  });
});

describe('the For now line', () => {
  /** A brand-new chat, and a "for now" memory riding on every reply (shared/for-now.ts). */
  async function fresh(opts: { webSearch?: boolean } = {}) {
    const ctx = setupApp(opts);
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    const trip = addMemory(ctx.db, userId(ctx.db, 'alice'), 'fact', 'Is on a cruise this week', null, 'user', '2099-01-01');
    ctx.model.forNow = [{ id: trip.id, content: trip.content }];
    return { ...ctx, cookie, id, trip };
  }
  const forNowColumn = (db: DB, id: number) => (db.prepare('SELECT for_now FROM messages WHERE id = ?').get(id) as { for_now: string | null }).for_now;
  type WithForNow = Event & { for_now?: { id: number; content: string }[] };

  it("goes on a chat's first reply only, kept as ids and read back as the memory reads now", async () => {
    const ctx = await fresh();
    const first = (await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'Good evening!' })) as WithForNow[];
    expect(first.find((e) => e.type === 'recall')).toEqual({ type: 'recall', recalled: [], remembered: [], for_now: [{ id: ctx.trip.id, content: 'Is on a cruise this week' }] });
    const done = first.find((e) => e.type === 'done')!;
    expect(forNowColumn(ctx.db, done.messageId!)).toBe(`[${ctx.trip.id}]`);

    // The second reply knows it too, but says nothing: no line, and here nothing else to show either.
    const second = await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'What should I do tonight?' });
    expect(second.find((e) => e.type === 'recall')).toBeUndefined();
    expect(forNowColumn(ctx.db, second.find((e) => e.type === 'done')!.messageId!)).toBeNull();

    const reply = async () =>
      ((await stored(ctx.app, ctx.cookie, ctx.id)) as unknown as { messages: { id: number; for_now: { id: number; content: string }[] }[] }).messages.find(
        (m) => m.id === done.messageId,
      )!;
    updateMemory(ctx.db, userId(ctx.db, 'alice'), ctx.trip.id, { content: 'Is on a cruise until Sunday' });
    expect((await reply()).for_now).toEqual([{ id: ctx.trip.id, content: 'Is on a cruise until Sunday' }]);
    // Another user's id on the reply shows nothing.
    const bob = await createUser(ctx.db, 'bob', 'a good password');
    const theirs = addMemory(ctx.db, bob.id, 'fact', 'Bob is in Lisbon', null, 'user', '2099-01-01');
    ctx.db.prepare('UPDATE messages SET for_now = ? WHERE id = ?').run(JSON.stringify([ctx.trip.id, theirs.id]), done.messageId);
    expect((await reply()).for_now).toEqual([{ id: ctx.trip.id, content: 'Is on a cruise until Sunday' }]);
    deleteMemory(ctx.db, userId(ctx.db, 'alice'), ctx.trip.id);
    expect((await reply()).for_now).toEqual([]);
  });

  it('sends nothing when nothing rides along', async () => {
    const ctx = await fresh();
    ctx.model.forNow = [];
    const events = await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'Good evening!' });
    expect(events.find((e) => e.type === 'recall')).toBeUndefined();
  });

  it('a first reply that waited on a search card keeps it, across a restart too', async () => {
    const ctx = await fresh({ webSearch: true });
    ctx.model.asks.push('cruise port hours');
    expect((await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'When does the port open?' })).at(-1)?.type).toBe('search');
    const after = setupApp({ webSearch: true, db: ctx.db });
    const events = (await post(after.app, ctx.cookie, `/conversations/${ctx.id}/search`, { approve: true })) as WithForNow[];
    expect(events.find((e) => e.type === 'recall')?.for_now).toEqual([{ id: ctx.trip.id, content: 'Is on a cruise this week' }]);
    expect(forNowColumn(ctx.db, events.find((e) => e.type === 'done')!.messageId!)).toBe(`[${ctx.trip.id}]`);
  });

  it("a private chat's first reply gets it, and stores nothing", async () => {
    const ctx = await fresh();
    const before = ctx.db.prepare('SELECT count(*) AS n FROM messages').get();
    const first = (await post(ctx.app, ctx.cookie, '/private/a1b2c3d4-private/messages', { messages: [{ role: 'user', content: 'hi!' }] })) as WithForNow[];
    expect(first.find((e) => e.type === 'recall')?.for_now).toEqual([{ id: ctx.trip.id, content: 'Is on a cruise this week' }]);
    const later = await post(ctx.app, ctx.cookie, '/private/a1b2c3d4-private/messages', {
      messages: [
        { role: 'user', content: 'hi!' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'what now?' },
      ],
    });
    expect(later.find((e) => e.type === 'recall')).toBeUndefined();
    expect(ctx.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual(before);
  });
});

describe('memoryContext reports what rides along for now', () => {
  it('the for-now memories it attached, and only those', async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    const embed: EmbedFn = async (texts) => texts.map(() => [1, 0]);
    const trip = addMemory(ctx.db, alice.id, 'fact', 'Alice is on a cruise.', null, 'user', '2026-11-29');
    addMemory(ctx.db, alice.id, 'fact', 'Alice was in Rome.', null, 'user', '2026-11-20');
    addMemory(ctx.db, alice.id, 'profile', 'Alice likes tea.');
    const { forNow } = await memoryContext(ctx.db, { id: alice.id, name: nameOf(alice) }, 'hello', embed, 800, undefined, '2026-11-25');
    expect(forNow).toEqual([{ id: trip.id, content: 'Alice is on a cruise.' }]);
  });
});
