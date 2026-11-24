// Look-back (lookback.ts): a long chat's folded-out messages are indexed in pieces, and the earlier
// exchanges that match a new message ride on it in the prompt. Every chat here is made up.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from './db.ts';
import {
  createLookbackIndexer,
  DOC_PREFIX,
  indexFolded,
  lookBack,
  lookBackForPrompt,
  PIECE_CHARS,
  pieces,
  QUERY_PREFIX,
} from './lookback.ts';
import { lookBacks } from './metrics.ts';
import type { EmbedFn } from './ollama.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';
import { createUser, nameOf } from './users.ts';

// A toy embedding: which of a few topic words a text has, so similarity is predictable.
const TOPICS = ['priya', 'washer', 'waffles', 'vet', 'lisbon', 'sintra', 'paint', 'green', 'recital'];
const fakeEmbed = (log: string[][] = []): EmbedFn => async (texts) => {
  log.push(texts);
  return texts.map((t) => [...TOPICS.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01]);
};

async function seed() {
  const db = openDb(':memory:');
  const named = async (u: string) => {
    const user = await createUser(db, u, 'a good password');
    return { ...user, name: nameOf(user) };
  };
  return { db, alice: await named('alice'), bob: await named('bob') };
}

/** A chat of [role, text] lines; `folded` of them (from the start) are folded into its summary. */
function chat(db: DB, userId: number, lines: [string, string, number?][], folded = lines.length): number {
  const id = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid);
  const ids = lines.map(([role, content, flagged]) =>
    Number(
      db
        .prepare('INSERT INTO messages (conversation_id, role, content, no_extraction) VALUES (?, ?, ?, ?)')
        .run(id, role, content, flagged ?? 0).lastInsertRowid,
    ),
  );
  if (folded) {
    db.prepare("UPDATE conversations SET summary = 'Earlier notes.', summary_through_message_id = ? WHERE id = ?").run(
      ids[folded - 1],
      id,
    );
  }
  return id;
}

const stored = (db: DB, id: number) =>
  db.prepare('SELECT message_id AS messageId, text FROM message_pieces WHERE conversation_id = ? ORDER BY id').all(id) as {
    messageId: number;
    text: string;
  }[];
const indexedThrough = (db: DB, id: number) =>
  (db.prepare('SELECT lookback_through_message_id AS n FROM conversations WHERE id = ?').get(id) as { n: number }).n;
const messageIds = (db: DB, id: number) =>
  (db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id').all(id) as { id: number }[]).map((r) => r.id);

const PRESSURE = 'My neighbor Priya lent me her pressure washer for the driveway.';
const PRESSURE_REPLY = 'Nice of Priya! Keep the washer at least a foot from the concrete.';
const DOG = 'Our dog Waffles is limping, vet on Thursday at 10.';
const DOG_REPLY = 'Poor Waffles. Rest him until the vet sees him.';
const TRIP = 'Lisbon plan: day 1 Alfama, day 2 Sintra, day 3 Belém.';
const TRIP_REPLY = 'Sintra on day 2 works well by train from Rossio.';
const PAINT = 'We picked Studio Green paint for the den.';
const PAINT_REPLY = 'A dark green paint looks great with warm light.';

describe('pieces', () => {
  it('keeps a short text whole', () => {
    expect(pieces('  Just one line.  ')).toEqual(['Just one line.']);
    expect(pieces('')).toEqual([]);
  });

  it('cuts long text at paragraphs, then lines, sentences and words, never over the limit, losing nothing', () => {
    const sentence = (i: number) => `Sentence number ${i} is here to fill the paragraph a little.`;
    const text = [
      Array.from({ length: 4 }, (_, i) => sentence(i)).join(' '),
      Array.from({ length: 20 }, (_, i) => sentence(100 + i)).join(' '),
      Array.from({ length: 30 }, (_, i) => `- list item ${i} with a few words`).join('\n'),
      `A word: ${'x'.repeat(1200)} ends here.`,
    ].join('\n\n');
    const out = pieces(text);
    expect(out.length).toBeGreaterThan(5);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(PIECE_CHARS);
    const words = (s: string) => s.split(/\s+/).join('');
    expect(words(out.join(''))).toBe(words(text));
    // A paragraph that fits stays one piece; list lines aren't cut mid-item.
    expect(out[0]).toContain(sentence(0));
    expect(out[0]).toContain(sentence(3));
    expect(out.some((p) => p.startsWith('- list item'))).toBe(true);
    const itemLines = out.flatMap((p) => p.split('\n')).filter((l) => l.includes('list item'));
    expect(itemLines).toHaveLength(30);
    for (const line of itemLines) expect(line).toMatch(/^- list item \d+ with a few words$/);
  });
});

describe('indexFolded', () => {
  it('indexes only the folded messages, skips "[no extraction]" ones, and does it once', async () => {
    const { db, alice } = await seed();
    const id = chat(
      db,
      alice.id,
      [
        ['user', PRESSURE],
        ['assistant', PRESSURE_REPLY],
        ['user', DOG, 1],
        ['assistant', DOG_REPLY, 1],
        ['user', TRIP],
        ['assistant', TRIP_REPLY],
      ],
      4,
    );
    const log: string[][] = [];
    expect(await indexFolded(db, id, fakeEmbed(log), 256)).toBe(2);
    const [first, second, , fourth] = messageIds(db, id);
    expect(stored(db, id)).toEqual([
      { messageId: first, text: PRESSURE },
      { messageId: second, text: PRESSURE_REPLY },
    ]);
    expect(indexedThrough(db, id)).toBe(fourth);
    // Embedded as documents (EmbeddingGemma's task prompt); stored without it.
    expect(log).toEqual([[DOC_PREFIX + PRESSURE, DOC_PREFIX + PRESSURE_REPLY]]);
    // Nothing new folded: no model call.
    expect(await indexFolded(db, id, fakeEmbed(log), 256)).toBe(0);
    expect(log).toHaveLength(1);
  });

  it('stops at whole messages near the limit and carries on next time, with no piece twice', async () => {
    const { db, alice } = await seed();
    const long = Array.from({ length: 3 }, (_, i) => `${'Paragraph '.repeat(40)}${i}.`).join('\n\n');
    const id = chat(db, alice.id, [
      ['user', long],
      ['assistant', PRESSURE_REPLY],
      ['user', DOG],
      ['assistant', DOG_REPLY],
    ]);
    const [first, second, , last] = messageIds(db, id);
    expect(await indexFolded(db, id, fakeEmbed(), 2)).toBe(pieces(long).length);
    expect(indexedThrough(db, id)).toBe(first);
    expect(await indexFolded(db, id, fakeEmbed(), 1)).toBe(1);
    expect(indexedThrough(db, id)).toBe(second);
    expect(await indexFolded(db, id, fakeEmbed(), 256)).toBe(2);
    expect(indexedThrough(db, id)).toBe(last);
    expect(stored(db, id).map((p) => p.text)).toEqual([...pieces(long), PRESSURE_REPLY, DOG, DOG_REPLY]);
  });

  it("stores nothing when another indexer got there first, or when embedding fails", async () => {
    const { db, alice } = await seed();
    const id = chat(db, alice.id, [
      ['user', PRESSURE],
      ['assistant', PRESSURE_REPLY],
    ]);
    const both = await Promise.all([indexFolded(db, id, fakeEmbed()), indexFolded(db, id, fakeEmbed())]);
    expect(both.sort()).toEqual([0, 2]);
    expect(stored(db, id)).toHaveLength(2);

    const other = chat(db, alice.id, [['user', DOG]]);
    await expect(
      indexFolded(db, other, async () => {
        throw new Error('embedder down');
      }),
    ).rejects.toThrow('embedder down');
    expect(indexedThrough(db, other)).toBe(0);
    expect(stored(db, other)).toEqual([]);
  });

  it("deleting a chat or a message deletes its pieces", async () => {
    const { db, alice } = await seed();
    const id = chat(db, alice.id, [
      ['user', PRESSURE],
      ['assistant', PRESSURE_REPLY],
    ]);
    await indexFolded(db, id, fakeEmbed());
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageIds(db, id)[1]);
    expect(stored(db, id).map((p) => p.text)).toEqual([PRESSURE]);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    expect(db.prepare('SELECT count(*) AS n FROM message_pieces').get()).toEqual({ n: 0 });
  });
});

describe('the indexer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes the most recently active chat first, spreads the work over passes, and logs no message text', async () => {
    const { db, alice } = await seed();
    const older = chat(db, alice.id, [['user', PRESSURE]]);
    const newer = chat(db, alice.id, [['user', DOG]]);
    db.prepare("UPDATE conversations SET updated_at = datetime('now', '-1 day') WHERE id = ?").run(older);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void logged.push(a.join(' ')));
    const pass = createLookbackIndexer(db, fakeEmbed(), 1);
    await pass();
    expect(stored(db, newer)).toHaveLength(1);
    expect(stored(db, older)).toHaveLength(0);
    await pass();
    expect(stored(db, older)).toHaveLength(1);
    expect(logged.join('\n')).not.toMatch(/Priya|Waffles/);
  });

  it('stops a pass at the first failure, and the next pass picks it up', async () => {
    const { db, alice } = await seed();
    const one = chat(db, alice.id, [['user', PRESSURE]]);
    const two = chat(db, alice.id, [['user', DOG]]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    let down = true;
    const embed: EmbedFn = async (texts) => {
      calls++;
      if (down) throw new Error('embedder down');
      return fakeEmbed()(texts);
    };
    const pass = createLookbackIndexer(db, embed);
    await pass();
    expect(calls).toBe(1);
    down = false;
    await pass();
    expect(stored(db, one)).toHaveLength(1);
    expect(stored(db, two)).toHaveLength(1);
  });
});

describe('lookBack', () => {
  afterEach(() => vi.restoreAllMocks());

  const longChat = async () => {
    const ctx = await seed();
    const id = chat(
      ctx.db,
      ctx.alice.id,
      [
        ['user', PRESSURE],
        ['assistant', PRESSURE_REPLY],
        ['user', DOG],
        ['assistant', DOG_REPLY],
        ['user', TRIP],
        ['assistant', TRIP_REPLY],
        ['user', PAINT],
        ['assistant', PAINT_REPLY],
        ['user', 'What a day.'],
        ['assistant', 'Sounds like a full one.'],
      ],
      8,
    );
    await indexFolded(ctx.db, id, fakeEmbed());
    return { ...ctx, id };
  };

  it('brings back the matching exchange, both sides, and nothing for an unrelated message', async () => {
    const { db, alice, id } = await longChat();
    const block = await lookBack(db, alice, id, 'Ugh, I broke the pressure washer', fakeEmbed(), undefined, 'UTC');
    expect(block).toMatch(/^\[Earlier in this chat/);
    expect(block).toContain(`alice: ${PRESSURE}`);
    expect(block).toContain(`You: ${PRESSURE_REPLY}`);
    expect(block).not.toContain('Waffles');
    expect(block).not.toContain('title: none');
    expect(await lookBack(db, alice, id, 'How do tides work?', fakeEmbed())).toBe('');
    // The message is embedded as a search query.
    const log: string[][] = [];
    await lookBack(db, alice, id, 'the washer', fakeEmbed(log));
    expect(log).toEqual([[QUERY_PREFIX + 'the washer']]);
  });

  it('reads only folded messages of the user\'s own chat', async () => {
    const { db, alice, bob, id } = await longChat();
    expect(await lookBack(db, bob, id, 'the pressure washer', fakeEmbed())).toBe('');
    // The two newest messages are still in the prompt: not looked back on, even once pieces exist.
    const [, , , , , , , , ninth] = messageIds(db, id);
    db.prepare("INSERT INTO message_pieces (message_id, conversation_id, text, embedding) VALUES (?, ?, 'Priya again', ?)").run(
      ninth,
      id,
      Buffer.from(new Float32Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0.01]).buffer),
    );
    expect(await lookBack(db, alice, id, 'Priya', fakeEmbed())).not.toContain('Priya again');
  });

  it('keeps the best few exchanges within the budget, in chat order', async () => {
    const { db, alice, id } = await longChat();
    const query = 'Priya washer waffles vet lisbon sintra green';
    // Each of the first three exchanges matches on two words, the paint one on one: all four pass the
    // bar, and the paint one is left out as the fourth.
    const all = await lookBack(db, alice, id, query, fakeEmbed(), { minScore: 0.1, maxExchanges: 3, maxChars: 10_000 });
    expect(all).toContain('Priya');
    expect(all).toContain('Waffles');
    expect(all).toContain('Lisbon');
    expect(all).not.toContain('Studio Green');
    expect(await lookBack(db, alice, id, query, fakeEmbed(), { minScore: 0.1, maxExchanges: 4, maxChars: 10_000 })).toContain('Studio Green');
    // The trip matches best, yet comes after the washer: they are shown in the order they were said.
    const ordered = await lookBack(db, alice, id, 'lisbon sintra priya', fakeEmbed(), { minScore: 0.1, maxExchanges: 2, maxChars: 10_000 });
    expect(ordered.indexOf('Priya')).toBeGreaterThan(0);
    expect(ordered.indexOf('Priya')).toBeLessThan(ordered.indexOf('Lisbon'));
    // The best one always comes back; past the budget, no more.
    const tight = await lookBack(db, alice, id, query, fakeEmbed(), { minScore: 0.3, maxExchanges: 3, maxChars: 100 });
    expect(tight.split('\n\n')).toHaveLength(2);
    expect(tight).toContain('Priya');
  });

  it("shows a long reply's matching pieces, marking what's left out", async () => {
    const { db, alice } = await seed();
    const filler = (n: number) => `${'Some general advice about the weekend. '.repeat(10)}${n}`;
    const reply = [filler(1), filler(2), 'For the den, Studio Green paint needs two coats.', filler(3), filler(4)].join('\n\n');
    const id = chat(db, alice.id, [
      ['user', 'Plans?'],
      ['assistant', reply],
    ]);
    await indexFolded(db, id, fakeEmbed());
    const block = await lookBack(db, alice, id, 'which paint again?', fakeEmbed());
    expect(block).toContain('You: … ');
    expect(block).toContain('Studio Green paint needs two coats.');
    expect(block).toMatch(/ …$/);
    expect(block.length).toBeLessThan(reply.length + 300);
  });

  it('asks no model when the chat has nothing indexed or the message has no words', async () => {
    const { db, alice } = await seed();
    const id = chat(db, alice.id, [['user', PRESSURE]]);
    const log: string[][] = [];
    expect(await lookBack(db, alice, id, 'Priya', fakeEmbed(log))).toBe('');
    await indexFolded(db, id, fakeEmbed());
    expect(await lookBack(db, alice, id, '  ', fakeEmbed(log))).toBe('');
    expect(log).toEqual([]);
  });

  it('for a prompt: counts what happened, and a failure is no look-back, logged without the message', async () => {
    const { db, alice, id } = await longChat();
    const count = async (outcome: string) => (await lookBacks.get()).values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
    const before = { attached: await count('attached'), none: await count('none'), failed: await count('failed') };
    expect(await lookBackForPrompt(db, alice, id, 'the pressure washer', fakeEmbed())).toContain('Priya');
    expect(await lookBackForPrompt(db, alice, id, 'tides', fakeEmbed())).toBe('');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a.join(' ')));
    const down: EmbedFn = async () => {
      throw new Error('embedder down');
    };
    expect(await lookBackForPrompt(db, alice, id, 'my secret plans for the washer', down)).toBe('');
    expect(errors.join('\n')).toContain('embedder down');
    expect(errors.join('\n')).not.toContain('secret');
    expect(await count('attached')).toBe(before.attached + 1);
    expect(await count('none')).toBe(before.none + 1);
    expect(await count('failed')).toBe(before.failed + 1);
    // A short chat, never folded: not counted.
    const short = chat(db, alice.id, [['user', 'hi']], 0);
    await lookBackForPrompt(db, alice, short, 'hi', fakeEmbed());
    expect(await count('none')).toBe(before.none + 1);
  });
});

describe('in the prompt', () => {
  type Event = { type: string };
  const say = async (app: TestApp, cookie: string, id: number, content: string) =>
    (await (await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Event);
  const newChat = async (app: TestApp, cookie: string) =>
    ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;

  it('rides on the newest message only: never stored, never in the system prompt or on older messages', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await say(ctx.app, cookie, id, 'first');
    await say(ctx.app, cookie, id, 'second');
    const [firstId] = messageIds(ctx.db, id);
    ctx.db.prepare("UPDATE conversations SET summary = 'Earlier notes.', summary_through_message_id = ? WHERE id = ?").run(firstId, id);
    ctx.model.lookedBack = '[Earlier in this chat: Priya lent the washer.]';
    await say(ctx.app, cookie, id, 'the washer broke');
    const prompt = ctx.model.calls.at(-1)!;
    expect(prompt[0]!.content).not.toContain('Priya');
    expect(prompt.at(-1)!.content).toMatch(/^\[Earlier in this chat: Priya lent the washer\.\]\n\n\[alice's message\]\nthe washer broke$/);
    expect(prompt.slice(0, -1).some((m) => m.content.includes('Priya'))).toBe(false);
    expect(ctx.model.lookBackQueries.at(-1)).toEqual({ userId: expect.any(Number), conversationId: id, message: 'the washer broke' });
    const saved = ctx.db.prepare('SELECT content FROM messages WHERE conversation_id = ?').all(id) as { content: string }[];
    expect(saved.some((m) => m.content.includes('Priya'))).toBe(false);

    // The next turn: the block went with its turn.
    ctx.model.lookedBack = '';
    await say(ctx.app, cookie, id, 'anyway');
    expect(ctx.model.calls.at(-1)!.some((m) => m.content.includes('Priya'))).toBe(false);
  });

  it("isn't asked for in a chat with no summary, or in a private chat", async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await say(ctx.app, cookie, id, 'hello');
    const res = await call(ctx.app, cookie, 'POST', '/private/a1b2c3d4-private/messages', { messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    await res.text();
    expect(ctx.model.calls).toHaveLength(2);
    expect(ctx.model.lookBackQueries).toEqual([]);
  });
});
