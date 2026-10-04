import { describe, expect, it } from 'vitest';
import { createModelScheduler, PreemptedError } from './busy.ts';
import { estimateTokens } from './context.ts';
import type { DB } from './db.ts';
import { conversationsReadyForExtraction, createSweep, extractMemories } from './extract.ts';
import { addMemory } from './memories.ts';
import type { ChatMessage, EmbedFn, JsonFn } from './ollama.ts';
import { searchMessages, toFtsQuery } from './search.ts';
import { KEEP_RECENT_TOKENS, SUMMARIZE_ABOVE_TOKENS, summarizeIfLong } from './summarize.ts';
import { login, ORIGIN, sessionCookie, setupApp, type TestApp } from './testing.ts';
import { cleanTitle } from './titles.ts';
import { createUser } from './users.ts';

async function signedIn() {
  const ctx = setupApp();
  await createUser(ctx.db, 'alice', 'a good password');
  await createUser(ctx.db, 'bob', 'a good password');
  const cookie = async (u: string) => sessionCookie(await login(ctx.app, u, 'a good password'));
  return { ...ctx, alice: await cookie('alice'), bob: await cookie('bob') };
}

function call(app: TestApp, cookie: string, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function events(res: Response) {
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; title?: string; error?: string });
}

const newChat = async (app: TestApp, cookie: string) =>
  ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
const say = async (app: TestApp, cookie: string, id: number, content: string) =>
  events(await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content }));
const chatOf = async (app: TestApp, cookie: string, id: number) =>
  (await (await call(app, cookie, 'GET', `/conversations/${id}`)).json()) as {
    conversation: { title: string };
    messages: { role: string; content: string }[];
  };

function seedMessages(db: DB, conversationId: number, count: number, size: number) {
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)');
  for (let i = 0; i < count; i++) insert.run(conversationId, i % 2 ? 'assistant' : 'user', `m${i} ${'x'.repeat(size)}`);
}

describe('model-written titles', () => {
  it('retitles a chat after its first reply and tells the client', async () => {
    const ctx = await signedIn();
    ctx.model.title = 'French relative pronouns';
    const id = await newChat(ctx.app, ctx.alice);
    const first = await say(ctx.app, ctx.alice, id, 'Explain qui vs que please, I keep mixing them up');
    expect(first.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done', 'title']);
    expect(first.at(-1)?.title).toBe('French relative pronouns');
    expect((await chatOf(ctx.app, ctx.alice, id)).conversation.title).toBe('French relative pronouns');

    ctx.model.title = 'Should not be used';
    expect((await say(ctx.app, ctx.alice, id, 'and ce que?')).map((e) => e.type)).not.toContain('title');
  });

  it("never retitles a chat the user renamed, and survives a failed title", async () => {
    const ctx = await signedIn();
    const renamed = await newChat(ctx.app, ctx.alice);
    await call(ctx.app, ctx.alice, 'PATCH', `/conversations/${renamed}`, { title: 'Mine' });
    ctx.model.title = 'Model title';
    expect((await say(ctx.app, ctx.alice, renamed, 'hi')).map((e) => e.type)).not.toContain('title');
    expect((await chatOf(ctx.app, ctx.alice, renamed)).conversation.title).toBe('Mine');

    const failing = await newChat(ctx.app, ctx.alice);
    ctx.model.title = new Error('model down');
    const evs = await say(ctx.app, ctx.alice, failing, 'hello there');
    expect(evs.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect((await chatOf(ctx.app, ctx.alice, failing)).conversation.title).toBe('hello there');
  });

  it('cleans model output into a usable title', () => {
    expect(cleanTitle('  "French  Pronouns."  ')).toBe('French Pronouns');
    expect(cleanTitle('**Ham radio**')).toBe('Ham radio');
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle('x'.repeat(61))).toBeUndefined();
    expect(cleanTitle(42)).toBeUndefined();
  });
});

describe('retry', () => {
  it('answers a question whose reply failed', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    ctx.model.reply = [new Error('boom')];
    await say(ctx.app, ctx.alice, id, 'Question?');
    expect((await chatOf(ctx.app, ctx.alice, id)).messages).toHaveLength(1);

    ctx.model.reply = ['Answer.'];
    const evs = await events(await call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/retry`));
    expect(evs.map((e) => e.type)).toContain('done');
    expect((await chatOf(ctx.app, ctx.alice, id)).messages.map((m) => m.content)).toEqual(['Question?', 'Answer.']);
    expect(ctx.model.calls.at(-1)!.at(-1)).toEqual({ role: 'user', content: 'Question?' });
  });

  it('replaces the last reply instead of adding a second one', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'Question?');
    ctx.model.reply = ['Better answer.'];
    await (await call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/retry`)).text();
    expect((await chatOf(ctx.app, ctx.alice, id)).messages.map((m) => m.content)).toEqual(['Question?', 'Better answer.']);
    // The regenerated prompt must not include the reply being replaced.
    expect(ctx.model.calls.at(-1)!.map((m) => m.content)).not.toContain('Hello there.');
  });

  it("refuses when there's nothing to retry, and never touches another user's chat", async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    expect((await call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/retry`)).status).toBe(400);
    await say(ctx.app, ctx.alice, id, 'Question?');
    expect((await call(ctx.app, ctx.bob, 'POST', `/conversations/${id}/retry`)).status).toBe(404);
    expect((await chatOf(ctx.app, ctx.alice, id)).messages).toHaveLength(2);
  });
});

/** Waits (briefly) until `ready` holds: for steps that happen inside a streaming request. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ready()).toBe(true);
}

/** A promise a test resolves by hand, to hold a model call open. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe('queued replies', () => {
  it('says "queued" when every slot holds a reply, and runs the reply once one frees', async () => {
    const ctx = await signedIn();
    const [a, b] = [await newChat(ctx.app, ctx.alice), await newChat(ctx.app, ctx.bob)];
    const held = gate();
    ctx.model.gate = held.promise;
    const first = say(ctx.app, ctx.alice, a, 'first');
    await until(() => ctx.model.calls.length === 1);
    const second = say(ctx.app, ctx.bob, b, 'second');
    await until(() => ctx.scheduler.stats().waitingReplies === 1);
    held.open();
    const [one, two] = await Promise.all([first, second]);
    expect(one.map((e) => e.type)).not.toContain('queued');
    expect(two.map((e) => e.type)).toContain('queued');
    expect((await chatOf(ctx.app, ctx.bob, b)).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('with two slots, two replies run at once and neither queues', async () => {
    const ctx = setupApp({ slots: 2 });
    await createUser(ctx.db, 'alice', 'a good password');
    const alice = sessionCookie(await login(ctx.app, 'alice', 'a good password'));
    const [a, b] = [await newChat(ctx.app, alice), await newChat(ctx.app, alice)];
    const held = gate();
    ctx.model.gate = held.promise;
    const first = say(ctx.app, alice, a, 'first');
    const second = say(ctx.app, alice, b, 'second');
    await until(() => ctx.model.calls.length === 2);
    held.open();
    for (const evs of await Promise.all([first, second])) expect(evs.map((e) => e.type)).not.toContain('queued');
  });

  it("doesn't let a client that stops reading hold the slot", async () => {
    const ctx = await signedIn();
    const [a, b] = [await newChat(ctx.app, ctx.alice), await newChat(ctx.app, ctx.bob)];
    // Alice's reply streams to a client that never reads it (a stalled phone, say).
    await call(ctx.app, ctx.alice, 'POST', `/conversations/${a}/messages`, { content: 'never read' });
    await until(() => ctx.model.calls.length === 1);
    // Bob still gets his reply: the slot was released when generation finished, not when read.
    const evs = await say(ctx.app, ctx.bob, b, 'my turn');
    expect(evs.at(-1)?.type).toBe('done');
    expect((await chatOf(ctx.app, ctx.alice, a)).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('preempts running background work so a reply goes first', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    const job = ctx.scheduler.background(
      (_m, _s, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))),
    )([], null);
    const evs = await say(ctx.app, ctx.alice, id, 'hello');
    await expect(job).rejects.toBeInstanceOf(PreemptedError);
    expect(evs.map((e) => e.type)).not.toContain('queued');
  });
});

describe('the model scheduler', () => {
  // A background call that runs until aborted, and a reply held open by a gate.
  const hang: JsonFn = (_m, _s, signal) =>
    new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted by fetch'))));
  const quick: JsonFn = async () => 'done';
  function heldReply(model: ReturnType<typeof createModelScheduler>, userId: number, onQueued?: (n: number) => void) {
    const held = gate();
    const started = { yes: false };
    const chat = model.chat(async function* () {
      started.yes = true;
      await held.promise;
      yield 'x';
    });
    const done = (async () => {
      const out: string[] = [];
      for await (const t of chat([], new AbortController().signal, { userId, onQueued })) out.push(t);
      return out;
    })();
    return { started, done, open: held.open };
  }

  it('preempts a running background call for a reply, and a real failure stays a failure', async () => {
    const model = createModelScheduler();
    const job = model.background(hang)([], null);
    expect(model.replyActive()).toBe(false);
    const reply = heldReply(model, 1);
    await expect(job).rejects.toBeInstanceOf(PreemptedError);
    await until(() => reply.started.yes);
    reply.open();
    await reply.done;

    await expect(model.background(async () => { throw new Error('real failure'); })([], null)).rejects.toThrow('real failure');
  });

  it('with two slots, a reply takes the free slot and leaves background work alone', async () => {
    const model = createModelScheduler({ slots: 2 });
    let preempted = false;
    const job = model.background(hang)([], null).catch((e) => (preempted = e instanceof PreemptedError));
    const reply = heldReply(model, 1);
    await until(() => reply.started.yes);
    expect(preempted).toBe(false);
    reply.open();
    await reply.done;
    expect(preempted).toBe(false);
    void job;
  });

  it('with both slots on background work, a reply preempts exactly one', async () => {
    const model = createModelScheduler({ slots: 2 });
    const outcomes: string[] = [];
    const jobs = [1, 2].map(() => model.background(hang)([], null).catch((e) => outcomes.push(e instanceof PreemptedError ? 'preempted' : 'other')));
    const reply = heldReply(model, 1);
    await until(() => reply.started.yes);
    expect(outcomes).toEqual(['preempted']);
    reply.open();
    await reply.done;
    void jobs;
  });

  it('queues a reply when every slot holds one, and says where it is', async () => {
    const model = createModelScheduler();
    const first = heldReply(model, 1);
    await until(() => first.started.yes);
    const positions: number[] = [];
    const second = heldReply(model, 2, (n) => positions.push(n));
    expect(positions).toEqual([1]);
    expect(second.started.yes).toBe(false);
    first.open();
    await until(() => second.started.yes);
    second.open();
    await Promise.all([first.done, second.done]);
  });

  it('serves a user with nothing running before one who already has a reply going', async () => {
    const model = createModelScheduler({ slots: 2 });
    const alice1 = heldReply(model, 1);
    const bob1 = heldReply(model, 2);
    await until(() => alice1.started.yes && bob1.started.yes);
    const alice2 = heldReply(model, 1); // queued first...
    const carol1 = heldReply(model, 3); // ...but Carol has nothing running
    alice1.open();
    await until(() => carol1.started.yes);
    expect(alice2.started.yes).toBe(false);
    bob1.open();
    await until(() => alice2.started.yes);
    carol1.open();
    alice2.open();
    await Promise.all([alice1.done, bob1.done, alice2.done, carol1.done]);
  });

  it('holds background work back while a reply runs or waits', async () => {
    const model = createModelScheduler();
    const reply = heldReply(model, 1);
    await until(() => reply.started.yes);
    let ran = false;
    const job = model.background(async () => ((ran = true), 'ok'))([], null);
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);
    expect(model.replyActive()).toBe(true);
    reply.open();
    await expect(job).resolves.toBe('ok');
  });

  it('lets background work that waited too long run next, unpreempted', async () => {
    let clock = 0;
    const model = createModelScheduler({ backgroundMaxWaitMs: 1000, now: () => clock });
    const first = heldReply(model, 1);
    await until(() => first.started.yes);
    const held = gate();
    let ran = false;
    const job = model.background(async (_m, _s, signal) => {
      ran = true;
      await held.promise;
      if (signal?.aborted) throw new Error('aborted');
      return 'written';
    })([], null);
    clock = 1000; // the memory job has now waited its limit
    const second = heldReply(model, 2); // a reply arrives meanwhile
    first.open();
    await until(() => ran);
    expect(second.started.yes).toBe(false); // the overdue job went first...
    held.open();
    await expect(job).resolves.toBe('written'); // ...and wasn't preempted by the waiting reply
    await until(() => second.started.yes);
    second.open();
    await Promise.all([first.done, second.done]);
  });

  it('drops a queued reply when the user stops it, without holding a slot', async () => {
    const model = createModelScheduler();
    const first = heldReply(model, 1);
    await until(() => first.started.yes);
    const stop = new AbortController();
    const queued = (async () => {
      for await (const _ of model.chat(async function* () { yield 'never'; })([], stop.signal, { userId: 2 })) void _;
    })();
    stop.abort(new Error('stopped'));
    await expect(queued).rejects.toThrow('stopped');
    first.open();
    await first.done;
    await expect(model.background(quick)([], null)).resolves.toBe('done'); // the slot is free
    expect(model.replyActive()).toBe(false);
  });

  it('counts replies while they stream, including failed ones', async () => {
    const model = createModelScheduler();
    const chat = model.chat(async function* () {
      yield 'x';
      throw new Error('boom');
    });
    const it = chat([], new AbortController().signal)[Symbol.asyncIterator]();
    await it.next();
    expect(model.replyActive()).toBe(true);
    await expect(it.next()).rejects.toThrow('boom');
    expect(model.replyActive()).toBe(false);
  });
});

describe('background work yields to chat', () => {
  async function quietChat() {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    const chat = Number(ctx.db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(alice.id).lastInsertRowid);
    ctx.db
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'I keep bees.', datetime('now', '-10 minutes'))")
      .run(chat);
    return { ...ctx, alice, chat };
  }
  const embed: EmbedFn = async (texts) => texts.map(() => [1, 0]);

  it('retries a preempted chat on the next pass, but backs off after a real failure', async () => {
    const { db, chat } = await quietChat();
    let calls = 0;
    let outcome: 'preempt' | 'fail' = 'preempt';
    const json: JsonFn = async () => {
      calls++;
      throw outcome === 'preempt' ? new PreemptedError() : new Error('model down');
    };
    const sweep = createSweep(db, json, embed, 5);
    await sweep();
    await sweep();
    expect(calls).toBe(2);
    outcome = 'fail';
    await sweep();
    await sweep();
    expect(calls).toBe(3);
    expect(conversationsReadyForExtraction(db, 5)).toEqual([chat]);
  });

  it('does not start while a reply is being generated', async () => {
    const { db } = await quietChat();
    let calls = 0;
    const sweep = createSweep(db, async () => ((calls++), { add: [], update: [], name: '' }), embed, 5, { paused: () => true });
    await sweep();
    expect(calls).toBe(0);
  });

  it('abandons a whole extraction when a duplicate check is preempted, writing nothing', async () => {
    const { db, alice, chat } = await quietChat();
    addMemory(db, alice.id, 'fact', 'Alice keeps bees.');
    const json: JsonFn = async (_m, schema) => {
      if ('same' in (schema as { properties: object }).properties) throw new PreemptedError();
      return { add: [{ content: 'Alice is a beekeeper.' }, { content: 'Alice likes honey.' }], update: [], name: '' };
    };
    await expect(extractMemories(db, chat, json, embed)).rejects.toBeInstanceOf(PreemptedError);
    expect((db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n).toBe(1);
    expect(conversationsReadyForExtraction(db, 5)).toEqual([chat]);
  });
});

describe('summarizing long chats', () => {
  it('does nothing while a chat fits', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    seedMessages(ctx.db, id, 4, 200);
    const json: JsonFn = async () => {
      throw new Error('should not be called');
    };
    expect(await summarizeIfLong(ctx.db, id, json)).toBe(false);
  });

  it('folds the oldest messages into a summary and keeps the recent ones verbatim', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    seedMessages(ctx.db, id, 30, 1400); // ~30 × 400 tokens, well past the threshold
    const prompts: ChatMessage[][] = [];
    const json: JsonFn = async (messages) => {
      prompts.push(messages);
      return 'Alice and hearth talked about many x characters.';
    };
    // More than one window's half to fold: it takes two passes, each fitting the window.
    expect(await summarizeIfLong(ctx.db, id, json)).toBe(true);
    expect(await summarizeIfLong(ctx.db, id, json)).toBe(true);
    expect(await summarizeIfLong(ctx.db, id, json)).toBe(false);
    for (const prompt of prompts) expect(estimateTokens(prompt[1]!.content)).toBeLessThanOrEqual(SUMMARIZE_ABOVE_TOKENS + 100);

    const state = ctx.db
      .prepare('SELECT summary, summary_through_message_id AS through FROM conversations WHERE id = ?')
      .get(id) as { summary: string; through: number };
    expect(state.summary).toContain('many x characters');
    const remaining = ctx.db
      .prepare('SELECT content FROM messages WHERE conversation_id = ? AND id > ?')
      .all(id, state.through) as { content: string }[];
    const keptTokens = remaining.reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(keptTokens).toBeLessThanOrEqual(SUMMARIZE_ABOVE_TOKENS);
    expect(keptTokens).toBeGreaterThanOrEqual(KEEP_RECENT_TOKENS - 500);
    expect(remaining.length).toBeGreaterThan(0);
    expect(prompts[0]![1]!.content).toContain('m0 ');

    // The next reply sends the summary in place of the folded messages.
    await say(ctx.app, ctx.alice, id, 'what were we saying?');
    const sent = ctx.model.calls.at(-1)!;
    expect(sent[0]!.content).toContain('## Earlier in this conversation\n\nAlice and hearth talked about many x characters.');
    expect(sent.some((m) => m.content.startsWith('m0 '))).toBe(false);
    expect(ctx.model.afterReply).toContain(id);
  });

  it('leaves summarized messages out even when they would fit', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'the old question');
    const through = (ctx.db.prepare('SELECT max(id) AS id FROM messages').get() as { id: number }).id;
    ctx.db
      .prepare("UPDATE conversations SET summary = 'They discussed an old question.', summary_through_message_id = ? WHERE id = ?")
      .run(through, id);
    await say(ctx.app, ctx.alice, id, 'a new question');
    const sent = ctx.model.calls.at(-1)!.map((m) => m.content);
    expect(sent).not.toContain('the old question');
    expect(sent.at(-1)).toBe('a new question');
    expect(sent[0]).toContain('They discussed an old question.');
  });

  it('scales its thresholds with the context window', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    seedMessages(ctx.db, id, 20, 1400); // ~8k tokens: past half of 8k, under half of 32k
    const json: JsonFn = async () => 'A summary.';
    expect(await summarizeIfLong(ctx.db, id, json, 32768)).toBe(false);
    expect(await summarizeIfLong(ctx.db, id, json, 8192)).toBe(true);
  });

  it('builds on the previous summary next time', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    seedMessages(ctx.db, id, 20, 1400);
    await summarizeIfLong(ctx.db, id, async () => 'First summary.');
    seedMessages(ctx.db, id, 20, 1400);
    const prompts: ChatMessage[][] = [];
    await summarizeIfLong(ctx.db, id, async (m) => {
      prompts.push(m);
      return 'Second summary.';
    });
    expect(prompts[0]![1]!.content).toContain('Previous summary:\nFirst summary.');
  });

  it('rejects an empty summary and leaves the chat as it was', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    seedMessages(ctx.db, id, 20, 1400);
    await expect(summarizeIfLong(ctx.db, id, async () => '  ')).rejects.toThrow(/empty/);
    const state = ctx.db.prepare('SELECT summary_through_message_id AS t FROM conversations WHERE id = ?').get(id) as {
      t: number;
    };
    expect(state.t).toBe(0);
    expect(SUMMARIZE_ABOVE_TOKENS).toBeGreaterThan(KEEP_RECENT_TOKENS);
  });
});

describe('near-duplicate memories', () => {
  // Vectors chosen by hand: "purple" facts point the same way, "orange" nearly the same way.
  const VECTORS: Record<string, number[]> = {
    'Alice likes purple.': [1, 0, 0],
    'Alice loves the color purple.': [0.98, 0.2, 0],
    'Alice dislikes orange.': [0.9, 0.43, 0],
    'Alice keeps bees.': [0, 0, 1],
  };
  const embed: EmbedFn = async (texts) => texts.map((t) => VECTORS[t] ?? [0, 1, 0]);

  async function extractWith(adds: string[], judge: (existing: string, candidate: string) => boolean | Error) {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    addMemory(ctx.db, alice.id, 'fact', 'Alice likes purple.');
    const chat = Number(ctx.db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(alice.id).lastInsertRowid);
    ctx.db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'stuff')").run(chat);
    const judged: string[] = [];
    const json: JsonFn = async (messages, schema) => {
      if ('same' in (schema as { properties: object }).properties) {
        const [, existing, candidate] = /EXISTING: (.*)\nNEW: (.*)/.exec(messages[1]!.content)!;
        judged.push(candidate!);
        const verdict = judge(existing!, candidate!);
        if (verdict instanceof Error) throw verdict;
        return { same: verdict };
      }
      return { add: adds.map((content) => ({ content })), update: [], name: '' };
    };
    const result = await extractMemories(ctx.db, chat, json, embed);
    const stored = (ctx.db.prepare('SELECT content FROM memories ORDER BY id').all() as { content: string }[]).map(
      (m) => m.content,
    );
    return { result, stored, judged };
  }

  it('drops a rewording the model confirms, and asks only about close candidates', async () => {
    const { result, stored, judged } = await extractWith(['Alice loves the color purple.', 'Alice keeps bees.'], () => true);
    expect(stored).toEqual(['Alice likes purple.', 'Alice keeps bees.']);
    expect(result).toMatchObject({ added: 1, duplicates: 1 });
    expect(judged).toEqual(['Alice loves the color purple.']);
  });

  it('keeps a similar-sounding but different fact when the model says so', async () => {
    const { stored } = await extractWith(['Alice dislikes orange.'], () => false);
    expect(stored).toEqual(['Alice likes purple.', 'Alice dislikes orange.']);
  });

  it('keeps the memory when the judgement fails', async () => {
    const { stored } = await extractWith(['Alice loves the color purple.'], () => new Error('model down'));
    expect(stored).toContain('Alice loves the color purple.');
  });

  it('catches a duplicate within the same batch', async () => {
    const { stored } = await extractWith(['Alice keeps bees.', 'Alice keeps bees.'], () => true);
    expect(stored.filter((c) => c === 'Alice keeps bees.')).toHaveLength(1);
  });
});

describe('search', () => {
  it('quotes every word so user input is never FTS syntax', () => {
    expect(toFtsQuery('qui que')).toBe('"qui" "que"*');
    expect(toFtsQuery('"); DROP TABLE messages; --')).toBe('"DROP" "TABLE" "messages"*');
    expect(toFtsQuery('NOT OR AND NEAR*')).toBe('"NOT" "OR" "AND" "NEAR"*');
    expect(toFtsQuery('  ...  ')).toBeUndefined();
  });

  it("finds word forms and prefixes in the user's own chats only", async () => {
    const ctx = await signedIn();
    const aliceChat = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, aliceChat, 'I am getting back into contesting this winter');
    const bobChat = await newChat(ctx.app, ctx.bob);
    await say(ctx.app, ctx.bob, bobChat, 'I love contests too');

    const hits = (await (await call(ctx.app, ctx.alice, 'GET', '/search?q=contest')).json()) as {
      conversationId: number;
      snippet: string;
    }[];
    expect(hits.map((h) => h.conversationId)).toEqual([aliceChat]);
    expect(hits[0]!.snippet).toContain('\u0002contesting\u0003');
    expect(await (await call(ctx.app, ctx.alice, 'GET', '/search?q=win')).json()).toHaveLength(1);
    expect(await (await call(ctx.app, ctx.alice, 'GET', '/search?q=%22%29%3B')).json()).toEqual([]);
  });

  it('stays in step with edits and deletions', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'purple druid');
    const alice = ctx.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number };
    const msg = ctx.db.prepare("SELECT id FROM messages WHERE content = 'purple druid'").get() as { id: number };

    ctx.db.prepare("UPDATE messages SET content = 'green paladin' WHERE id = ?").run(msg.id);
    expect(searchMessages(ctx.db, alice.id, 'druid')).toEqual([]);
    expect(searchMessages(ctx.db, alice.id, 'paladin')).toHaveLength(1);

    await call(ctx.app, ctx.alice, 'DELETE', `/conversations/${id}`);
    expect(searchMessages(ctx.db, alice.id, 'paladin')).toEqual([]);
  });
});
