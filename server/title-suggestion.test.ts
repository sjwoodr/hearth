// Suggest in the rename box (POST /conversations/:id/title-suggestion) and the rename that keeps the
// suggestion as it was (PATCH with `auto`), which hands the title back to the retitler.
import { describe, expect, it } from 'vitest';
import { PreemptedError } from './busy.ts';
import type { DB } from './db.ts';
import { chatsToRetitle, RETITLE_AFTER } from './retitle.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';

async function signedIn() {
  const ctx = setupApp();
  return { ...ctx, alice: await signIn(ctx, 'alice'), bob: await signIn(ctx, 'bob') };
}

const newChat = async (app: TestApp, cookie: string) =>
  ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
const say = async (app: TestApp, cookie: string, id: number, content: string) =>
  (await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content })).text();
const suggest = (app: TestApp, cookie: string, id: number) => call(app, cookie, 'POST', `/conversations/${id}/title-suggestion`);
const rename = (app: TestApp, cookie: string, id: number, body: unknown) => call(app, cookie, 'PATCH', `/conversations/${id}`, body);

const row = (db: DB, id: number) =>
  db.prepare('SELECT title, title_is_auto, title_checked_through_message_id AS checked FROM conversations WHERE id = ?').get(id) as {
    title: string | null;
    title_is_auto: number;
    checked: number;
  };
const lastMessageId = (db: DB, id: number) =>
  (db.prepare('SELECT max(id) AS id FROM messages WHERE conversation_id = ?').get(id) as { id: number }).id;

describe('suggesting a title', () => {
  it("answers the model's title from the user's side of the chat, oldest first, and saves nothing", async () => {
    const ctx = await signedIn();
    ctx.model.title = 'Hello';
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'hi');
    await say(ctx.app, ctx.alice, id, 'I want a raised garden bed');
    const before = row(ctx.db, id);

    const res = await suggest(ctx.app, ctx.alice, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Raised Garden Beds' });
    expect(ctx.model.suggestCalls).toEqual([['hi', 'I want a raised garden bed']]);
    // The request's own signal: closing the box (or the connection) frees the model slot.
    expect(ctx.model.suggestSignals[0]).toBeInstanceOf(AbortSignal);
    expect(row(ctx.db, id)).toEqual(before);
  });

  it("is never asked for another user's chat, or one that doesn't exist", async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'my garden plans');
    expect((await suggest(ctx.app, ctx.bob, id)).status).toBe(404);
    expect((await suggest(ctx.app, ctx.alice, id + 100)).status).toBe(404);
    expect((await suggest(ctx.app, ctx.alice, 0)).status).toBe(404);
    expect(ctx.model.suggestCalls).toEqual([]);
  });

  it('has nothing to name in an empty chat, without asking the model', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    const res = await suggest(ctx.app, ctx.alice, id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Nothing to name/);
    expect(ctx.model.suggestCalls).toEqual([]);
  });

  it('says so when the model fails, gives nothing usable, or is preempted by a reply', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'my garden plans');
    const before = row(ctx.db, id);

    ctx.model.suggestion = new Error('model down');
    const failed = await suggest(ctx.app, ctx.alice, id);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toMatch(/Try again/);

    ctx.model.suggestion = undefined;
    expect((await suggest(ctx.app, ctx.alice, id)).status).toBe(502);

    ctx.model.suggestion = new PreemptedError();
    const busy = await suggest(ctx.app, ctx.alice, id);
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { error: string }).error).toMatch(/Busy with a reply/);
    expect(row(ctx.db, id)).toEqual(before);
  });
});

describe('suggesting another title', () => {
  it('passes on the titles to avoid: strings only, short ones, the newest five, spaces tidied', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'my garden plans');
    const post = (body: unknown) => call(ctx.app, ctx.alice, 'POST', `/conversations/${id}/title-suggestion`, body);
    await post({ avoid: ['Garden  Plans', 42, '', '  ', 'x'.repeat(121), null, 'Raised Beds'] });
    await post({ avoid: ['a', 'b', 'c', 'd', 'e', 'f'] });
    await post({ avoid: 'Garden Plans' });
    await post(undefined);
    expect(ctx.model.suggestAvoid).toEqual([['Garden Plans', 'Raised Beds'], ['b', 'c', 'd', 'e', 'f'], [], []]);
  });
});

describe('keeping a suggestion hands the title back to hearth', () => {
  it('a typed title is the user\'s; the suggestion kept as it was lets hearth retitle again, after RETITLE_AFTER more messages', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'hi');
    await say(ctx.app, ctx.alice, id, 'a raised bed');
    expect(chatsToRetitle(ctx.db, 0)).toEqual([id]);

    expect((await rename(ctx.app, ctx.alice, id, { title: 'Mine' })).status).toBe(200);
    expect(row(ctx.db, id)).toMatchObject({ title: 'Mine', title_is_auto: 0 });
    expect(chatsToRetitle(ctx.db, 0)).toEqual([]);

    expect((await rename(ctx.app, ctx.alice, id, { title: 'Raised Garden Beds', auto: true })).status).toBe(200);
    expect(row(ctx.db, id)).toEqual({ title: 'Raised Garden Beds', title_is_auto: 1, checked: lastMessageId(ctx.db, id) });
    // Checked as of now: not looked at again until the chat has moved on.
    expect(chatsToRetitle(ctx.db, 0)).toEqual([]);
    for (let i = 0; i < RETITLE_AFTER / 2 - 1; i++) await say(ctx.app, ctx.alice, id, `more ${i}`);
    expect(chatsToRetitle(ctx.db, 0)).toEqual([]);
    await say(ctx.app, ctx.alice, id, 'and more');
    expect(chatsToRetitle(ctx.db, 0)).toEqual([id]);

    // Typing over it makes it the user's again.
    await rename(ctx.app, ctx.alice, id, { title: 'My Garden' });
    expect(row(ctx.db, id)).toMatchObject({ title: 'My Garden', title_is_auto: 0 });
    expect(chatsToRetitle(ctx.db, 0)).toEqual([]);
  });

  it('only a literal true counts, and an empty chat is checked from the start', async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'hi');
    for (const auto of ['true', 1, 'yes', null]) {
      await rename(ctx.app, ctx.alice, id, { title: 'Kept', auto });
      expect(row(ctx.db, id).title_is_auto).toBe(0);
    }
    const empty = await newChat(ctx.app, ctx.alice);
    await rename(ctx.app, ctx.alice, empty, { title: 'Later', auto: true });
    expect(row(ctx.db, empty)).toEqual({ title: 'Later', title_is_auto: 1, checked: 0 });
  });

  it("can't touch another user's chat", async () => {
    const ctx = await signedIn();
    const id = await newChat(ctx.app, ctx.alice);
    await say(ctx.app, ctx.alice, id, 'hi');
    await rename(ctx.app, ctx.alice, id, { title: 'Mine' });
    expect((await rename(ctx.app, ctx.bob, id, { title: 'Bob was here', auto: true })).status).toBe(404);
    expect(row(ctx.db, id)).toMatchObject({ title: 'Mine', title_is_auto: 0 });
  });
});
