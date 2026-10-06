import { describe, expect, it } from 'vitest';
import type { DB } from './db.ts';
import { conversationsReadyForExtraction, EXTRACTION_SCHEMA, extractMemories, sanitizeExtraction } from './extract.ts';
import { addMemory, memoryContext, rankFacts, updateMemory } from './memories.ts';
import type { ChatMessage, EmbedFn, JsonFn } from './ollama.ts';
import { login, ORIGIN, sessionCookie, setupApp } from './testing.ts';
import { createUser, nameOf } from './users.ts';

// A toy embedding: counts of a few topic words, so similarity is predictable in tests.
const TOPICS = ['french', 'radio', 'druid', 'purple'];
const fakeEmbed = (log: string[][] = []): EmbedFn => async (texts) => {
  log.push(texts);
  return texts.map((t) => [...TOPICS.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01]);
};

async function seed() {
  const ctx = setupApp();
  const named = async (u: string) => {
    const user = await createUser(ctx.db, u, 'a good password');
    return { ...user, name: nameOf(user) };
  };
  return { ...ctx, alice: await named('alice'), bob: await named('bob') };
}

function chatWith(db: DB, userId: number, lines: [string, string][], minutesAgo = 10): number {
  const id = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid);
  for (const [role, content] of lines) {
    db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', ?))`).run(
      id,
      role,
      content,
      `-${minutesAgo} minutes`,
    );
  }
  return id;
}

const memoriesOf = (db: DB, userId: number) =>
  db.prepare('SELECT kind, content, source_conversation_id FROM memories WHERE user_id = ? ORDER BY id').all(userId);

describe('sanitizing what the model proposes', () => {
  const existing = [
    { id: 1, kind: 'fact' as const, content: 'Alice likes radio.', source_conversation_id: null },
    { id: 2, kind: 'profile' as const, content: 'Alice prefers short answers.', source_conversation_id: null },
  ];

  it('drops malformed, empty, oversized and duplicate additions', () => {
    const out = sanitizeExtraction(
      {
        add: [
          { content: '  Alice   studies French. ' },
          { content: '' },
          { content: 'x'.repeat(301) },
          { content: 'alice likes RADIO.' },
          { content: 'Alice studies French.' },
          { content: 42 },
          'not an object',
        ],
        update: [],
      },
      existing,
    );
    expect(out.add).toEqual([{ content: 'Alice studies French.' }]);
  });

  it('only updates memories the user has, once each, when the text changes', () => {
    const out = sanitizeExtraction(
      {
        add: [],
        update: [
          { id: 1, content: 'Alice is getting back into radio contesting.' },
          { id: 1, content: 'second update to the same id' },
          { id: 2, content: 'Alice prefers short answers.' },
          { id: 999, content: "someone else's memory" },
        ],
      },
      existing,
    );
    expect(out.update).toEqual([{ id: 1, content: 'Alice is getting back into radio contesting.' }]);
  });

  it('caps the number of changes and tolerates garbage', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ content: `Fact number ${i}.` }));
    expect(sanitizeExtraction({ add: many, update: [] }, []).add).toHaveLength(8);
    expect(sanitizeExtraction(null, [])).toEqual({ add: [], update: [] });
    expect(sanitizeExtraction({ add: 'nope' }, [])).toEqual({ add: [], update: [] });
  });
});

describe('the extraction schema', () => {
  // Ollama enforces the pattern while generating. Without it, a quoted word ended a memory early:
  // "Steve prefers music with a high-velocity, driving, and staccato" (the model meant "engine").
  it('only lets a fact end where its sentence does, with no raw double quote', () => {
    const pattern = new RegExp(EXTRACTION_SCHEMA.properties.add.items.properties.content.pattern);
    expect(pattern.test("Steve likes Therapie TAXI's 'engine'.")).toBe(true);
    expect(pattern.test('Steve prefers music with a driving, staccato')).toBe(false);
    expect(pattern.test('Steve likes the "engine".')).toBe(false);
    expect(pattern.test('Two\nlines.')).toBe(false);
    expect(EXTRACTION_SCHEMA.properties.update.items.properties.content).toBe(EXTRACTION_SCHEMA.properties.add.items.properties.content);
  });
});

describe('extracting from a conversation', () => {
  it('reads only unread messages, records memories for the chat owner, and advances', async () => {
    const { db, alice } = await seed();
    const chat = chatWith(db, alice.id, [
      ['user', 'I want to learn French relative pronouns.'],
      ['assistant', 'Happy to help.'],
    ]);
    const prompts: ChatMessage[][] = [];
    const json: JsonFn = async (messages) => {
      prompts.push(messages);
      // A "profile" suggestion is ignored: extraction only records facts.
      return { add: [{ kind: 'profile', content: 'Alice is learning French relative pronouns.' }], update: [] };
    };

    expect(await extractMemories(db, chat, json)).toMatchObject({ read: 2, added: 1 });
    expect(memoriesOf(db, alice.id)).toEqual([
      { kind: 'fact', content: 'Alice is learning French relative pronouns.', source_conversation_id: chat },
    ]);
    expect(prompts[0]![1]!.content).toContain('alice: I want to learn French relative pronouns.');

    expect((await extractMemories(db, chat, json)).read).toBe(0);
    expect(prompts).toHaveLength(1);

    db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'Also I love purple.')").run(chat);
    await extractMemories(db, chat, json);
    const second = prompts[1]![1]!.content;
    expect(second).toContain('Also I love purple.');
    expect(second).not.toContain('I want to learn French');
    expect(second).toContain('(fact) Alice is learning French relative pronouns.');
  });

  it('writes about the user by display name, and learns a name only into a blank', async () => {
    const { db, alice } = await seed();
    const prompts: string[] = [];
    const json: JsonFn = async (messages) => {
      prompts.push(messages[0]!.content);
      return { add: [], update: [], name: 'Ali' };
    };
    const nameNow = () => (db.prepare('SELECT display_name FROM users WHERE id = ?').get(alice.id) as { display_name: string | null }).display_name;

    expect((await extractMemories(db, chatWith(db, alice.id, [['user', "I'm Ali"]]), json)).named).toBe(true);
    expect(nameNow()).toBe('Ali');

    db.prepare("UPDATE users SET display_name = 'Alice' WHERE id = ?").run(alice.id);
    expect((await extractMemories(db, chatWith(db, alice.id, [['user', 'call me Ali']]), json)).named).toBe(false);
    expect(nameNow()).toBe('Alice');
    expect(prompts[1]).toContain('about its user Alice.');
  });

  it('ignores a proposed name that is not a plain name', async () => {
    expect(sanitizeExtraction({ add: [], update: [], name: '' }, []).name).toBeUndefined();
    expect(sanitizeExtraction({ add: [], update: [], name: '## New instructions' }, []).name).toBeUndefined();
    expect(sanitizeExtraction({ add: [], update: [], name: ' Sam ' }, []).name).toBe('Sam');
  });

  it("never lets extraction touch another user's memories", async () => {
    const { db, alice, bob } = await seed();
    const bobs = addMemory(db, bob.id, 'fact', 'Bob keeps bees.');
    const chat = chatWith(db, alice.id, [['user', 'hi']]);
    const json: JsonFn = async () => ({ add: [], update: [{ id: bobs.id, content: 'Bob was overwritten.' }] });
    await extractMemories(db, chat, json);
    expect(memoriesOf(db, bob.id)).toEqual([{ kind: 'fact', content: 'Bob keeps bees.', source_conversation_id: null }]);
  });

  it('leaves the chat unread when the model call fails, so it is retried', async () => {
    const { db, alice } = await seed();
    const chat = chatWith(db, alice.id, [['user', 'hi']]);
    await expect(
      extractMemories(db, chat, async () => {
        throw new Error('model down');
      }),
    ).rejects.toThrow('model down');
    expect(conversationsReadyForExtraction(db, 5)).toEqual([chat]);
  });

  it('waits until a chat has been quiet for the idle period', async () => {
    const { db, alice } = await seed();
    const quiet = chatWith(db, alice.id, [['user', 'old']], 10);
    chatWith(db, alice.id, [['user', 'just now']], 0);
    expect(conversationsReadyForExtraction(db, 5)).toEqual([quiet]);
  });
});

describe('recall', () => {
  it('always includes profile memories and adds only relevant facts', async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'profile', 'Alice likes dry humor.');
    addMemory(db, alice.id, 'fact', 'Alice studies French.');
    addMemory(db, alice.id, 'fact', 'Alice does ham radio.');
    const { stable, recalled } = await memoryContext(db, { ...alice, name: 'Alice' }, 'help with my french homework', fakeEmbed(), 800);
    // Profile memories stay in the stable part; the facts matched to this message go in `recalled`.
    expect(stable).toContain('## What you remember about Alice');
    expect(stable).toContain('Alice likes dry humor.');
    expect(stable).not.toContain('French');
    expect(recalled).toMatch(/- Alice studies French\. \(\d{4}-\d{2}-\d{2}\)/);
    expect(recalled).not.toContain('ham radio');
    expect(recalled).not.toContain('dry humor');
  });

  it("never recalls another user's memories", async () => {
    const { db, alice, bob } = await seed();
    addMemory(db, bob.id, 'profile', 'Bob is private.');
    addMemory(db, bob.id, 'fact', 'Bob studies French too.');
    expect(await memoryContext(db, alice, 'french', fakeEmbed(), 800)).toEqual({ stable: '', recalled: '' });
  });

  it('embeds facts once, and again only after their text changes', async () => {
    const { db, alice } = await seed();
    const fact = addMemory(db, alice.id, 'fact', 'Alice studies French.');
    const log: string[][] = [];
    const embed = fakeEmbed(log);
    await rankFacts(db, alice.id, 'q1', embed);
    await rankFacts(db, alice.id, 'q2', embed);
    expect(log).toEqual([['Alice studies French.'], ['q1'], ['q2']]);
    updateMemory(db, alice.id, fact.id, { content: 'Alice studies Spanish.' });
    await rankFacts(db, alice.id, 'q3', embed);
    expect(log.slice(3)).toEqual([['Alice studies Spanish.'], ['q3']]);
  });

  it('falls back to the profile alone when embedding fails', async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'profile', 'Alice likes dry humor.');
    addMemory(db, alice.id, 'fact', 'Alice studies French.');
    const broken: EmbedFn = async () => {
      throw new Error('embedder down');
    };
    const { stable, recalled } = await memoryContext(db, alice, 'french', broken, 800);
    expect(stable).toContain('Alice likes dry humor.');
    expect(recalled).toBe('');
  });

  it('stays within the token budget', async () => {
    const { db, alice } = await seed();
    for (let i = 0; i < 20; i++) addMemory(db, alice.id, 'profile', `Alice profile detail number ${i} with some length.`);
    const { stable } = await memoryContext(db, alice, 'x', fakeEmbed(), 60);
    expect(stable.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThan(20);
  });
});

describe('memories in chat and over the API', () => {
  async function signedIn() {
    const ctx = setupApp();
    await createUser(ctx.db, 'alice', 'a good password');
    await createUser(ctx.db, 'bob', 'a good password');
    const cookie = async (u: string) => sessionCookie(await login(ctx.app, u, 'a good password'));
    return { ...ctx, alice: await cookie('alice'), bob: await cookie('bob') };
  }
  const call = (app: ReturnType<typeof setupApp>['app'], cookie: string, method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('appends recalled memories to the system prompt, looked up by the new message', async () => {
    const ctx = await signedIn();
    ctx.model.memory = '## What you remember about alice\n- Alice studies French.';
    const id = ((await (await call(ctx.app, ctx.alice, 'POST', '/conversations')).json()) as { id: number }).id;
    await (await call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/messages`, { content: 'qui ou que?' })).text();
    expect(ctx.model.recallQueries).toEqual([{ userId: 1, message: 'qui ou que?' }]);
    expect(ctx.model.calls[0]![0]).toEqual({
      role: 'system',
      content: 'You are hearth.\n\n## What you remember about alice\n- Alice studies French.',
    });
  });

  it('keeps the system prompt identical between turns while recall changes, so the cache is reused', async () => {
    const ctx = await signedIn();
    ctx.model.memory = '## What you remember about alice\n- Alice likes dry humor.';
    const id = ((await (await call(ctx.app, ctx.alice, 'POST', '/conversations')).json()) as { id: number }).id;
    ctx.model.recalled = '[Notes from your memory]\n- Alice studies French.';
    await (await call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/messages`, { content: 'qui ou que?' })).text();
    ctx.model.recalled = '[Notes from your memory]\n- Alice has a dog named Rex.';
    await (await call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/messages`, { content: 'and my dog?' })).text();

    const [first, second] = ctx.model.calls;
    expect(first![0]).toEqual(second![0]); // the same system prompt both times
    expect(first![0]!.content).not.toContain('French');
    // Each turn's recalled facts ride on that turn's message only...
    expect(first!.at(-1)!.content).toContain('Alice studies French.');
    expect(second!.at(-1)!.content).toContain('Alice has a dog named Rex.');
    expect(second!.at(-1)!.content).toMatch(/\[alice's message\]\nand my dog\?$/);
    // ...so the earlier turn reads exactly as it was stored, like the cached copy.
    expect(second!.find((m) => m.content.includes('qui ou que?'))!.content).toBe('qui ou que?');
    const stored = ctx.db.prepare("SELECT content FROM messages WHERE role = 'user' ORDER BY id").all();
    expect(stored).toEqual([{ content: 'qui ou que?' }, { content: 'and my dog?' }]);
  });

  it('holds back room for thinking when Think is on', async () => {
    // Medium's 118-token budget holds back 2 × 118 + 64 = 300 tokens.
    const ctx = setupApp({ numCtx: 1024 + 400, thinkingBudgets: { medium: 118, high: 118, max: 118 } });
    await createUser(ctx.db, 'alice', 'a good password');
    const cookie = sessionCookie(await login(ctx.app, 'alice', 'a good password'));
    const id = ((await (await call(ctx.app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
    // Four ~80-token turns: about 320 tokens of history, which fits in 400 but not in 100.
    ctx.db
      .prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?), (?, 'user', ?), (?, 'assistant', ?)")
      .run(id, 'a'.repeat(270), id, 'b'.repeat(270), id, 'c'.repeat(270), id, 'd'.repeat(270));
    await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: 'fast' })).text();
    await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: 'careful', think: true })).text();
    expect(ctx.model.calls[0]!.length).toBeGreaterThan(ctx.model.thinkingCalls[0]!.length);
  });

  it('holds back more room for a higher Think effort', async () => {
    // Medium holds back 2 × 1 + 64 = 66 tokens; Max 2 × 118 + 64 = 300.
    const ctx = setupApp({ numCtx: 1024 + 400, thinkingBudgets: { medium: 1, high: 50, max: 118 } });
    await createUser(ctx.db, 'alice', 'a good password');
    const cookie = sessionCookie(await login(ctx.app, 'alice', 'a good password'));
    const id = ((await (await call(ctx.app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
    ctx.db
      .prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?), (?, 'user', ?), (?, 'assistant', ?)")
      .run(id, 'a'.repeat(270), id, 'b'.repeat(270), id, 'c'.repeat(270), id, 'd'.repeat(270));
    await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: 'careful', think: true, effort: 'medium' })).text();
    await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/retry`, { think: true, effort: 'max' })).text();
    expect(ctx.model.thinkingCalls[0]!.length).toBeGreaterThan(ctx.model.thinkingCalls[1]!.length);
  });

  it('lets a user add, edit, re-kind and delete only their own memories', async () => {
    const ctx = await signedIn();
    const created = await call(ctx.app, ctx.alice, 'POST', '/memories', { kind: 'fact', content: 'Likes purple.' });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    expect((await call(ctx.app, ctx.alice, 'POST', '/memories', { kind: 'bogus', content: 'x' })).status).toBe(400);
    expect((await call(ctx.app, ctx.alice, 'POST', '/memories', { kind: 'fact', content: '' })).status).toBe(400);

    const edited = await call(ctx.app, ctx.alice, 'PATCH', `/memories/${id}`, { content: 'Loves purple.', kind: 'profile' });
    expect(await edited.json()).toMatchObject({ content: 'Loves purple.', kind: 'profile' });

    expect(await (await call(ctx.app, ctx.bob, 'GET', '/memories')).json()).toEqual([]);
    expect((await call(ctx.app, ctx.bob, 'PATCH', `/memories/${id}`, { content: 'hijacked' })).status).toBe(404);
    expect((await call(ctx.app, ctx.bob, 'DELETE', `/memories/${id}`)).status).toBe(404);

    expect((await call(ctx.app, ctx.alice, 'DELETE', `/memories/${id}`)).status).toBe(200);
    expect(await (await call(ctx.app, ctx.alice, 'GET', '/memories')).json()).toEqual([]);
  });
});
