// "[no extraction]" (shared/no-extraction.ts): a message and its reply stay in the chat but never reach
// memory extraction (either pass), the summary, titles or search. Every chat here is made up.
import { describe, expect, it } from 'vitest';
import type { DB } from './db.ts';
import { conversationsReadyForExtraction, extractMemories } from './extract.ts';
import type { ChatMessage, EmbedFn, JsonFn } from './ollama.ts';
import { retitle } from './retitle.ts';
import { summarizeIfLong } from './summarize.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';
import { parseNoExtraction } from '../shared/no-extraction.ts';

const SECRET = 'my sister Margaux is moving to Quebec';
const SECRET_REPLY = 'Quebec is a big move for Margaux';
const ORDINARY = 'I planted tomatoes in the garden today';

type Event = { type: string; noExtraction?: boolean; messageId?: number };
type Stored = {
  conversation: { title: string | null };
  messages: { id: number; role: string; content: string; no_extraction: boolean }[];
};

async function newChat(app: TestApp, cookie: string): Promise<number> {
  return ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
}

const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);

async function say(app: TestApp, cookie: string, id: number, content: string) {
  return events(await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content }));
}

const stored = async (app: TestApp, cookie: string, id: number) =>
  (await (await call(app, cookie, 'GET', `/conversations/${id}`)).json()) as Stored;

/** Makes every message old enough for the background jobs, which wait for a quiet chat. */
const age = (db: DB) => db.prepare("UPDATE messages SET created_at = datetime('now', '-30 minutes')").run();

/** A background model that records everything it is shown and learns nothing. */
function recording() {
  const shown: string[] = [];
  const json: JsonFn = async (messages: ChatMessage[]) => {
    shown.push(messages.map((m) => m.content).join('\n'));
    const system = messages[0]!.content;
    if (system.startsWith('You maintain')) return { add: [], update: [] };
    if (system.startsWith('You keep the character sheet')) return { facts: [] };
    return 'A summary.';
  };
  return { json, shown, all: () => shown.join('\n') };
}
const fakeEmbed: EmbedFn = async (texts) => texts.map(() => [1, 0]);

/** Two exchanges: an ordinary one, then one kept out. */
async function mixedChat(ctx: ReturnType<typeof setupApp>, cookie: string): Promise<number> {
  const id = await newChat(ctx.app, cookie);
  ctx.model.reply = ['Tomatoes like the sun.'];
  await say(ctx.app, cookie, id, ORDINARY);
  ctx.model.reply = [SECRET_REPLY, '.'];
  await say(ctx.app, cookie, id, `[no extraction] ${SECRET}`);
  return id;
}

describe('the marker', () => {
  it('is found only at the start, in any case and spelling of the gap', () => {
    for (const text of ['[no extraction] hi', '  [No Extraction]hi', '[no-extraction] hi', '[NOEXTRACTION] hi', '[ no_extraction ] hi']) {
      expect(parseNoExtraction(text)).toEqual({ content: 'hi', noExtraction: true });
    }
    for (const text of ['hi [no extraction]', '(no extraction) hi', '[no extractions] hi', 'no extraction: hi']) {
      expect(parseNoExtraction(text)).toEqual({ content: text, noExtraction: false });
    }
  });
});

describe('a message sent with it', () => {
  it('is saved without the marker, flagged with its reply, and the model never sees the marker', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    const sent = await say(ctx.app, cookie, id, `[no extraction] ${SECRET}`);
    expect(sent.find((e) => e.type === 'start')?.noExtraction).toBe(true);
    expect(JSON.stringify(ctx.model.calls)).not.toMatch(/no.?extraction/i);
    expect(ctx.model.calls[0]!.at(-1)!.content).toContain(SECRET);

    // The next message is an ordinary one.
    const next = await say(ctx.app, cookie, id, ORDINARY);
    expect(next.find((e) => e.type === 'start')?.noExtraction).toBeUndefined();
    const { messages } = await stored(ctx.app, cookie, id);
    expect(messages.map((m) => [m.role, m.content.startsWith(SECRET), m.no_extraction])).toEqual([
      ['user', true, true],
      ['assistant', false, true],
      ['user', false, false],
      ['assistant', false, false],
    ]);
    expect(messages[0]!.content).toBe(SECRET);
  });

  it('is refused when the marker is all there is', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    const res = await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: '[no extraction]  ' });
    expect(res.status).toBe(400);
  });

  it('keeps a retried reply flagged, and a reply that waited for a search card', async () => {
    const ctx = setupApp({ webSearch: true });
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await say(ctx.app, cookie, id, `[no extraction] ${SECRET}`);
    const retried = await events(await call(ctx.app, cookie, 'POST', `/conversations/${id}/retry`, {}));
    expect(retried.find((e) => e.type === 'start')?.noExtraction).toBe(true);
    expect((await stored(ctx.app, cookie, id)).messages.map((m) => m.no_extraction)).toEqual([true, true]);

    ctx.model.asks = ['flights to Quebec'];
    await say(ctx.app, cookie, id, '[no extraction] how long is the flight there?');
    const resumed = await events(await call(ctx.app, cookie, 'POST', `/conversations/${id}/search`, { approve: true }));
    expect(resumed.find((e) => e.type === 'start')?.noExtraction).toBe(true);
    expect((await stored(ctx.app, cookie, id)).messages.map((m) => m.no_extraction)).toEqual([true, true, true, true]);
  });

  it('is only stripped in a private chat, which stores nothing anyway', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const res = await call(ctx.app, cookie, 'POST', '/private/abcdef12/messages', {
      messages: [{ role: 'user', content: `[no extraction] ${SECRET}` }],
    });
    await events(res);
    expect(JSON.stringify(ctx.model.calls)).not.toMatch(/no.?extraction/i);
    expect(JSON.stringify(ctx.model.calls)).toContain(SECRET);
  });
});

describe('what skips it', () => {
  it('memory extraction: neither pass sees it or its reply, and the chat is still read past them', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await mixedChat(ctx, cookie);
    age(ctx.db);
    const background = recording();
    await extractMemories(ctx.db, id, background.json, fakeEmbed);
    expect(background.shown.length).toBeGreaterThanOrEqual(2); // the user's pass and the assistant's
    expect(background.all()).toContain(ORDINARY);
    expect(background.all()).not.toContain('Margaux');
    const last = (await stored(ctx.app, cookie, id)).messages.at(-1)!.id;
    expect(ctx.db.prepare('SELECT memory_through_message_id AS t FROM conversations WHERE id = ?').get(id)).toEqual({ t: last });
  });

  it('memory extraction: a chat with nothing else needs no model, and stops waiting to be read', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await say(ctx.app, cookie, id, `[no extraction] ${SECRET}`);
    age(ctx.db);
    expect(conversationsReadyForExtraction(ctx.db, 5)).toEqual([id]);
    const background = recording();
    await extractMemories(ctx.db, id, background.json, fakeEmbed);
    expect(background.shown).toEqual([]);
    expect(conversationsReadyForExtraction(ctx.db, 5)).toEqual([]);
  });

  it('the summary: folded out of the chat but never written into it', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.reply = ['Margaux will love the snow there. '.repeat(40)];
    await say(ctx.app, cookie, id, `[no extraction] ${SECRET} `.repeat(30));
    for (let i = 0; i < 30; i++) {
      ctx.model.reply = [`answer ${i} `.repeat(30)];
      await say(ctx.app, cookie, id, `question ${i} `.repeat(30));
    }
    const background = recording();
    expect(await summarizeIfLong(ctx.db, id, background.json, 2048)).toBe(true);
    expect(background.all()).toContain('question 0');
    expect(background.all()).not.toContain('Margaux');
    // Past the flagged pair: the chat no longer carries them.
    const through = (ctx.db.prepare('SELECT summary_through_message_id AS t FROM conversations WHERE id = ?').get(id) as { t: number }).t;
    const [secret, reply] = (await stored(ctx.app, cookie, id)).messages;
    expect(through).toBeGreaterThan(reply!.id);
    expect(secret!.no_extraction).toBe(true);
  });

  it('the summary: a fold of only flagged messages asks no model and keeps the summary as it was', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.reply = ['Margaux will love the snow there. '.repeat(400)];
    await say(ctx.app, cookie, id, `[no extraction] ${SECRET} `.repeat(200));
    ctx.model.reply = ['Sure.'];
    await say(ctx.app, cookie, id, 'ok');
    ctx.db.prepare("UPDATE conversations SET summary = 'Earlier notes.' WHERE id = ?").run(id);
    const background = recording();
    expect(await summarizeIfLong(ctx.db, id, background.json, 2048)).toBe(true);
    expect(background.shown).toEqual([]);
    expect(ctx.db.prepare('SELECT summary FROM conversations WHERE id = ?').get(id)).toEqual({ summary: 'Earlier notes.' });
    expect(ctx.db.prepare('SELECT count(*) AS n FROM summary_folds WHERE conversation_id = ?').get(id)).toEqual({ n: 1 });
  });

  it('search: neither it nor its reply is found, even after an image note or a delete', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await mixedChat(ctx, cookie);
    const found = async (q: string) =>
      ((await (await call(ctx.app, cookie, 'GET', `/search?q=${encodeURIComponent(q)}`)).json()) as unknown[]).length;
    expect(await found('tomatoes')).toBe(2);
    expect(await found('Margaux')).toBe(0);
    expect(await found('Quebec')).toBe(0);
    const indexed = (word: string) =>
      (ctx.db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(word) as { n: number }).n;
    expect(indexed('Margaux')).toBe(0);
    expect(indexed('tomatoes')).toBe(2);

    const [, , secret] = (await stored(ctx.app, cookie, id)).messages;
    ctx.db.prepare("UPDATE messages SET image_note = 'A photo of Margaux at the airport.' WHERE id = ?").run(secret!.id);
    expect(await found('airport')).toBe(0);
    expect(indexed('airport')).toBe(0);
    // The index stays sound: a delete is never sent for a row it never had.
    expect(() => ctx.db.prepare("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')").run()).not.toThrow();
    await call(ctx.app, cookie, 'DELETE', `/conversations/${id}`);
    expect(() => ctx.db.prepare("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')").run()).not.toThrow();
    expect(indexed('tomatoes')).toBe(0);
  });

  it('search: results leave them out even if the index is rebuilt from the messages table', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    await mixedChat(ctx, cookie);
    ctx.db.prepare("INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')").run();
    const hits = (await (await call(ctx.app, cookie, 'GET', '/search?q=Margaux')).json()) as unknown[];
    expect(hits).toEqual([]);
  });

  it("titles: a chat opening with it gets its title from the next message, and retitling doesn't see it", async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.title = 'Margaux Moves to Quebec';
    await say(ctx.app, cookie, id, `[no extraction] ${SECRET}`);
    expect((await stored(ctx.app, cookie, id)).conversation.title).toBeNull();

    ctx.model.title = 'Garden Tomatoes';
    await say(ctx.app, cookie, id, ORDINARY);
    expect((await stored(ctx.app, cookie, id)).conversation.title).toBe('Garden Tomatoes');

    await say(ctx.app, cookie, id, `[no extraction] Margaux found a flat in Montreal`);
    const seen: string[][] = [];
    await retitle(ctx.db, id, async (_title, said) => {
      seen.push(said);
      return undefined;
    });
    expect(seen).toEqual([[ORDINARY]]);
  });

  it("titles: retrying a chat's only flagged question writes no title", async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.title = 'Margaux Moves to Quebec';
    await say(ctx.app, cookie, id, `[no extraction] ${SECRET}`);
    await events(await call(ctx.app, cookie, 'POST', `/conversations/${id}/retry`, {}));
    expect((await stored(ctx.app, cookie, id)).conversation.title).toBeNull();
  });
});
