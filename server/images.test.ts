import { describe, expect, it, vi } from 'vitest';
import { PreemptedError } from './busy.ts';
import { fitHistory } from './context.ts';
import { IMAGE_TOKENS, MAX_IMAGE_BYTES, MAX_IMAGES, parseImages, PendingImages, withImageText } from './images.ts';
import { summarizeIfLong } from './summarize.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';

const b64 = (bytes: number[], padding = 32) => Buffer.from([...bytes, ...Array(padding).fill(7)]).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = b64([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]);
const OTHER_PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 40);

async function newChat(app: TestApp, cookie: string): Promise<number> {
  return ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
}

async function post(app: TestApp, cookie: string, path: string, body: object) {
  const res = await call(app, cookie, 'POST', path, body);
  const events = res.ok
    ? (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; reason?: string })
    : [];
  return { res, events };
}

type StoredMessage = { role: string; content: string; image_count: number; image_note: string | null };
const stored = async (app: TestApp, cookie: string, id: number) =>
  ((await (await call(app, cookie, 'GET', `/conversations/${id}`)).json()) as { messages: StoredMessage[] }).messages;

/** Every text and blob value in every table, to prove an image never reaches the database. */
function everythingStored(db: ReturnType<typeof setupApp>['db']): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables
    .flatMap(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
    .flatMap((row) => Object.values(row))
    .map((v) => (Buffer.isBuffer(v) ? v.toString('base64') : String(v)))
    .join('\n');
}

describe('checking pasted images', () => {
  it('accepts PNG, JPEG and WebP, as base64 or data URLs', () => {
    expect(parseImages(undefined)).toEqual({ images: [] });
    expect(parseImages([PNG, JPEG, `data:image/webp;base64,${WEBP}`])).toEqual({ images: [PNG, JPEG, WEBP] });
  });

  it('judges the format by the bytes, whatever the data URL claims', () => {
    const gif = b64([...Buffer.from('GIF89a')]);
    expect(parseImages([`data:image/png;base64,${gif}`])).toEqual({ error: 'Images must be PNG, JPEG or WebP.' });
    expect(parseImages([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')])).toHaveProperty('error');
  });

  it('refuses too many, too large, malformed or non-text images', () => {
    expect(parseImages(Array(MAX_IMAGES + 1).fill(PNG))).toHaveProperty('error');
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 7);
    huge.set([0xff, 0xd8, 0xff]);
    expect(parseImages([huge.toString('base64')])).toHaveProperty('error');
    expect(parseImages(['not base64!'])).toHaveProperty('error');
    expect(parseImages([42])).toHaveProperty('error');
    expect(parseImages(PNG)).toHaveProperty('error');
  });

  it('counts each image toward the context window', () => {
    const history = [
      { role: 'user' as const, content: 'old', images: [PNG] },
      { role: 'user' as const, content: 'new' },
    ];
    expect(fitHistory('sys', history, IMAGE_TOKENS + 30)).toHaveLength(3);
    expect(fitHistory('sys', history, IMAGE_TOKENS - 10)).toHaveLength(2);
  });

  it('stands in for images in text, described or not', () => {
    expect(withImageText('hi', 0, null)).toBe('hi');
    expect(withImageText('Check this', 1, 'A note.')).toBe('[Attached an image, described:\nA note.]\n\nCheck this');
    expect(withImageText('', 2, null)).toBe('[Attached 2 images, no longer available]');
  });
});

describe('images in a chat', () => {
  it('shows the model the image, describes it after the reply, and never stores the image', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);

    const { res } = await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'What does this say?', images: [PNG] });
    expect(res.status).toBe(200);
    expect(ctx.model.calls[0]!.at(-1)).toEqual({ role: 'user', content: 'What does this say?', images: [PNG] });

    // Described as a continuation of the prompt just answered, so Ollama can reuse its cache.
    await vi.waitFor(() => expect(ctx.model.describeCalls).toHaveLength(1));
    const describeCall = ctx.model.describeCalls[0]!;
    expect(describeCall.slice(0, -2)).toEqual(ctx.model.calls[0]);
    expect(describeCall.at(-2)).toEqual({ role: 'assistant', content: 'Hello there.' });
    expect(describeCall.at(-1)!.content).toMatch(/transcribe/i);

    await vi.waitFor(async () =>
      expect((await stored(ctx.app, cookie, id))[0]).toMatchObject({ image_count: 1, image_note: 'A page of French homework.' }),
    );
    expect(everythingStored(ctx.db)).not.toContain(PNG.slice(0, 20));

    // The next message sends the description in the image's place.
    await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'And the second line?' });
    const history = ctx.model.calls[1]!;
    expect(history.some((m) => m.images)).toBe(false);
    expect(history[1]!.content).toBe('[Attached an image, described:\nA page of French homework.]\n\nWhat does this say?');
    expect(ctx.model.describeCalls).toHaveLength(1);
  });

  it('lets a retry see the image again until the chat moves on', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'Check my homework', images: [PNG] });
    await vi.waitFor(() => expect(ctx.model.describeCalls).toHaveLength(1));

    await post(ctx.app, cookie, `/conversations/${id}/retry`, { think: true });
    expect(ctx.model.thinkingCalls[0]!.at(-1)!.images).toEqual([PNG]);
    expect(ctx.model.describeCalls).toHaveLength(1);
  });

  it('accepts an image with no words, and refuses a message with neither', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);

    expect((await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: ' ' })).res.status).toBe(400);
    expect((await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: '', images: [] })).res.status).toBe(400);
    const { res } = await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: '', images: [PNG, JPEG] });
    expect(res.status).toBe(200);
    expect(ctx.model.calls[0]!.at(-1)).toEqual({ role: 'user', content: '', images: [PNG, JPEG] });
    expect(ctx.model.recallQueries.at(-1)!.message).toBe('');
  });

  it('refuses a bad image without saving the message or calling the model', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    const bad = Buffer.from('#!/bin/sh\necho hi').toString('base64');
    const { res } = await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'look', images: [bad] });
    expect(res.status).toBe(400);
    expect(await stored(ctx.app, cookie, id)).toEqual([]);
    expect(ctx.model.calls).toEqual([]);
  });

  it('keeps sending a preempted image until it is described, then describes it on its own', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.description = new PreemptedError();
    await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'first', images: [PNG] });
    await vi.waitFor(() => expect(ctx.model.describeCalls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    ctx.model.description = 'Described later.';
    await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'second', images: [OTHER_PNG] });
    expect(ctx.model.calls[1]![1]).toEqual({ role: 'user', content: 'first', images: [PNG] });

    // The leftover is described alone; the one just answered continues the prompt.
    await vi.waitFor(() => expect(ctx.model.describeCalls).toHaveLength(3));
    expect(ctx.model.describeCalls[1]).toEqual([expect.objectContaining({ role: 'user', images: [PNG] })]);
    expect(ctx.model.describeCalls[2]!.slice(0, -2)).toEqual(ctx.model.calls[1]);
    await vi.waitFor(async () =>
      expect((await stored(ctx.app, cookie, id)).map((m) => m.image_note)).toEqual([
        'Described later.',
        null,
        'Described later.',
        null,
      ]),
    );
  });

  it('gives up after repeated failures and says the image is gone', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.description = new Error('model down');
    await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'look', images: [PNG] });
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(ctx.model.describeCalls).toHaveLength(i + 1));
      await new Promise((r) => setTimeout(r, 0));
      await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: `again ${i}` });
    }
    expect(ctx.model.calls.at(-1)![1]!.content).toBe('[Attached an image, no longer available]\n\nlook');
    expect(ctx.model.describeCalls).toHaveLength(3);
  });

  it('thinks first on Auto when asked to check the French in an image', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    const { events } = await post(ctx.app, cookie, `/conversations/${id}/messages`, {
      content: 'Can you check my homework?',
      images: [PNG],
      think: 'auto',
    });
    expect(events[0]).toMatchObject({ type: 'start', think: true, reason: 'checking the French in an image' });

    const { events: plain } = await post(ctx.app, cookie, `/conversations/${id}/messages`, {
      content: 'Can you check my homework?',
      think: 'auto',
    });
    expect(plain[0]).toMatchObject({ type: 'start', think: false });
  });

  it('finds descriptions in search, for their owner only', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    const id = await newChat(ctx.app, alice);
    ctx.model.description = 'A boulangerie menu listing croissants.';
    await post(ctx.app, alice, `/conversations/${id}/messages`, { content: 'look', images: [PNG] });
    await vi.waitFor(async () => expect((await stored(ctx.app, alice, id))[0]!.image_note).not.toBeNull());

    const hits = (await (await call(ctx.app, alice, 'GET', '/search?q=croissants')).json()) as { snippet: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('\u0002croissants\u0003');
    expect(await (await call(ctx.app, bob, 'GET', '/search?q=croissants')).json()).toEqual([]);
    expect((await call(ctx.app, bob, 'GET', `/conversations/${id}`)).status).toBe(404);
  });
});

describe('images held in memory', () => {
  it('drops described images when the chat moves on, and everything when it is deleted', () => {
    const pending = new PendingImages();
    pending.add(1, 10, [PNG]);
    pending.add(2, 10, [JPEG]);
    pending.add(3, 20, [WEBP]);
    pending.get(1)!.described = true;
    pending.moveOn(10);
    expect([1, 2, 3].map((id) => pending.get(id) !== undefined)).toEqual([false, true, true]);
    pending.forget(10);
    expect(pending.get(2)).toBeUndefined();
    expect(pending.waiting(20).map(([id]) => id)).toEqual([3]);
  });

  it('holds at most 8 messages, dropping described ones first', () => {
    const pending = new PendingImages();
    for (let id = 1; id <= 8; id++) pending.add(id, 10, [PNG]);
    pending.get(5)!.described = true;
    pending.add(9, 10, [PNG]);
    expect(pending.get(5)).toBeUndefined();
    pending.add(10, 10, [PNG]);
    expect(pending.get(1)).toBeUndefined();
    expect(pending.get(2)).toBeDefined();
  });
});

describe('background readers', () => {
  it('fold image descriptions into the summary transcript', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.description = 'A photo of a café terrace.';
    await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'look', images: [PNG] });
    await vi.waitFor(async () => expect((await stored(ctx.app, cookie, id))[0]!.image_note).not.toBeNull());
    for (let i = 0; i < 4; i++) await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'x'.repeat(300) });

    const seen: string[] = [];
    await summarizeIfLong(
      ctx.db,
      id,
      async (messages) => {
        seen.push(messages.at(-1)!.content);
        return { summary: 'ok' };
      },
      512,
    );
    expect(seen[0]).toContain('alice: [Attached an image, described:\nA photo of a café terrace.]\n\nlook');
  });
});
