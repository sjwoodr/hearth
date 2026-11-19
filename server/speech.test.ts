import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEECH_CHARS } from '../shared/speech.ts';
import { createModelScheduler, PreemptedError } from './busy.ts';
import type { SpeakFn } from './ollama.ts';
import { cachedVoices, savedVoice, type SpeechDeps } from './speech.ts';
import { call, ORIGIN, setupApp, signIn } from './testing.ts';

const VOICES = ['default', 'female-french', 'male-french', 'female-american-english'];
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

const bytesOf = (...parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });

function setup(opts: { voices?: string[] | undefined; defaultVoice?: string; speak?: SpeakFn } = {}) {
  const spoken: { text: string; voice: string; userId?: number }[] = [];
  const speech: SpeechDeps = {
    speak:
      opts.speak ??
      (async (text, voice, o) => {
        spoken.push({ text, voice, userId: o?.userId });
        return bytesOf(AUDIO.subarray(0, 4), AUDIO.subarray(4));
      }),
    voices: async () => ('voices' in opts ? opts.voices : VOICES),
    defaultVoice: opts.defaultVoice ?? 'female-french',
  };
  const ctx = setupApp({ speech });
  return { ctx, spoken };
}

afterEach(() => vi.restoreAllMocks());

describe('GET /api/voices', () => {
  it("lists the model's voices, with the default until the user picks one", async () => {
    const { ctx } = setup();
    const alice = await signIn(ctx, 'alice');
    const res = await call(ctx.app, alice, 'GET', '/voices');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voices: VOICES, voice: 'female-french', defaultVoice: 'female-french' });
  });

  it("falls back to the model's first voice when the default isn't one of them", async () => {
    const { ctx } = setup({ defaultVoice: 'female-klingon' });
    const alice = await signIn(ctx, 'alice');
    expect(await (await call(ctx.app, alice, 'GET', '/voices')).json()).toMatchObject({ voice: 'default', defaultVoice: 'default' });
  });

  it("says unavailable when the model can't speak", async () => {
    const { ctx } = setup({ voices: undefined });
    const alice = await signIn(ctx, 'alice');
    const res = await call(ctx.app, alice, 'GET', '/voices');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/isn't available/);
  });
});

describe('PUT /api/voice', () => {
  it("saves each user's own voice, and only theirs", async () => {
    const { ctx } = setup();
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    const res = await call(ctx.app, alice, 'PUT', '/voice', { voice: 'male-french' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voice: 'male-french' });
    expect((await (await call(ctx.app, alice, 'GET', '/voices')).json()).voice).toBe('male-french');
    expect((await (await call(ctx.app, bob, 'GET', '/voices')).json()).voice).toBe('female-french');
  });

  it("refuses a voice the model doesn't have, saving nothing", async () => {
    const { ctx } = setup();
    const alice = await signIn(ctx, 'alice');
    for (const body of [{ voice: 'female-klingon' }, { voice: 5 }, {}]) {
      expect((await call(ctx.app, alice, 'PUT', '/voice', body)).status).toBe(400);
    }
    expect((await (await call(ctx.app, alice, 'GET', '/voices')).json()).voice).toBe('female-french');
  });

  it("refuses while the model can't be asked which voices it has", async () => {
    const { ctx } = setup({ voices: undefined });
    const alice = await signIn(ctx, 'alice');
    expect((await call(ctx.app, alice, 'PUT', '/voice', { voice: 'male-french' })).status).toBe(503);
  });
});

describe('POST /api/speech', () => {
  it('streams the audio back as the model sent it, uncached, in the voice asked for', async () => {
    const { ctx, spoken } = setup();
    const alice = await signIn(ctx, 'alice');
    const res = await call(ctx.app, alice, 'POST', '/speech', { text: '  Bonjour, ça va ?  ', voice: 'male-french' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(AUDIO);
    const [user] = ctx.db.prepare("SELECT id FROM users WHERE username = 'alice'").all() as { id: number }[];
    expect(spoken).toEqual([{ text: 'Bonjour, ça va ?', voice: 'male-french', userId: user!.id }]);
  });

  it("uses the user's saved voice when none is given, and the default for a voice the model lost", async () => {
    const { ctx, spoken } = setup();
    const alice = await signIn(ctx, 'alice');
    await call(ctx.app, alice, 'PUT', '/voice', { voice: 'female-american-english' });
    await (await call(ctx.app, alice, 'POST', '/speech', { text: 'Hello.' })).arrayBuffer();
    ctx.db.prepare("UPDATE users SET voice = 'female-retired' WHERE username = 'alice'").run();
    await (await call(ctx.app, alice, 'POST', '/speech', { text: 'Hello.' })).arrayBuffer();
    expect(spoken.map((s) => s.voice)).toEqual(['female-american-english', 'female-french']);
  });

  it('refuses empty, wordless, oversized or unknown-voice requests without calling the model', async () => {
    const { ctx, spoken } = setup();
    const alice = await signIn(ctx, 'alice');
    for (const body of [
      {},
      { text: '   ' },
      { text: '… — !' },
      { text: 7 },
      { text: 'a'.repeat(MAX_SPEECH_CHARS + 1) },
      { text: 'Oui.', voice: 'female-klingon' },
      { text: 'Oui.', voice: null },
    ]) {
      expect((await call(ctx.app, alice, 'POST', '/speech', body)).status).toBe(400);
    }
    expect((await call(ctx.app, alice, 'POST', '/speech', { text: 'a'.repeat(MAX_SPEECH_CHARS) })).status).toBe(200);
    expect(spoken).toHaveLength(1);
  });

  it("fails plainly, logging neither the text nor the model's answer", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx } = setup({
      speak: async () => {
        throw new Error('Ollama returned 500: boom');
      },
    });
    const alice = await signIn(ctx, 'alice');
    const res = await call(ctx.app, alice, 'POST', '/speech', { text: 'Mon secret.' });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('boom');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Mon secret');
  });

  it('needs a session, and is gone without a speech model', async () => {
    const { ctx } = setup();
    const res = await ctx.app.request('/api/speech', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Oui.' }),
    });
    expect(res.status).toBe(401);
    const bare = setupApp();
    const alice = await signIn(bare, 'alice');
    for (const [method, path] of [['GET', '/voices'], ['PUT', '/voice'], ['POST', '/speech']] as const) {
      expect((await call(bare.app, alice, method, path, method === 'GET' ? undefined : { text: 'Oui.', voice: 'default' })).status).toBe(404);
    }
  });

  it('keeps nothing but the voice', async () => {
    const { ctx } = setup();
    const alice = await signIn(ctx, 'alice');
    const tables = () =>
      (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(({ name }) =>
        JSON.stringify(ctx.db.prepare(`SELECT * FROM "${name}"`).all()),
      );
    const before = tables();
    await (await call(ctx.app, alice, 'POST', '/speech', { text: 'Un mot privé.' })).arrayBuffer();
    expect(tables()).toEqual(before);
    expect(savedVoice(ctx.db, 1)).toBeNull();
  });
});

describe('cachedVoices', () => {
  it('asks once per 10 minutes, one question shared by callers at the same time', async () => {
    let now = 0;
    let asked = 0;
    const voices = cachedVoices(async () => (asked++, VOICES), () => now);
    await Promise.all([voices(), voices(), voices()]);
    now += 9 * 60 * 1000;
    expect(await voices()).toEqual(VOICES);
    expect(asked).toBe(1);
    now += 2 * 60 * 1000;
    await voices();
    expect(asked).toBe(2);
  });

  it('asks again 30 seconds after a failure, so a model pulled later shows up', async () => {
    let now = 0;
    const answers: (string[] | undefined | Error)[] = [undefined, new Error('down'), VOICES];
    const voices = cachedVoices(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }, () => now);
    expect(await voices()).toBeUndefined();
    now += 29_000;
    expect(await voices()).toBeUndefined();
    now += 2_000;
    expect(await voices()).toBeUndefined(); // the thrown one
    now += 31_000;
    expect(await voices()).toEqual(VOICES);
    expect(answers).toEqual([]);
  });
});

describe('scheduled speech', () => {
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(ready()).toBe(true);
  };

  /** A speech call whose audio streams until the test ends it; `ready` is audio there from the start. */
  function heldSpeech(ready?: Uint8Array) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const speak: SpeakFn = async () =>
      new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          if (ready) c.enqueue(ready);
        },
        cancel: () => void (cancelled = true),
      });
    return { speak, end: () => controller.close(), fail: () => controller.error(new Error('lost')), cancelled: () => cancelled };
  }

  it('holds a reply slot until the last byte is through, not just until it starts', async () => {
    const scheduler = createModelScheduler({ slots: 1 });
    const held = heldSpeech();
    const audio = await scheduler.speech(held.speak)('Bonjour.', 'female-french', { userId: 1 });
    expect(scheduler.stats()).toMatchObject({ runningReplies: 1 });
    const reader = audio.getReader();
    held.end();
    expect((await reader.read()).done).toBe(true);
    expect(scheduler.stats()).toMatchObject({ runningReplies: 0 });
  });

  it('preempts background work like a reply', async () => {
    const scheduler = createModelScheduler({ slots: 1 });
    let preempted = false;
    const background = scheduler.background(
      (_m, _s, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
    )([], null).catch((err) => (preempted = err instanceof PreemptedError));
    await until(() => scheduler.stats().runningBackground === 1);
    const held = heldSpeech();
    const audio = await scheduler.speech(held.speak)('Bonjour.', 'female-french');
    await background;
    expect(preempted).toBe(true);
    await audio.cancel();
  });

  it('frees the slot when the listener goes away mid-stream, or the audio breaks off, or never starts', async () => {
    const scheduler = createModelScheduler({ slots: 1 });
    const gone = heldSpeech();
    const audio = await scheduler.speech(gone.speak)('Bonjour.', 'female-french');
    await audio.cancel();
    expect(gone.cancelled()).toBe(true);
    expect(scheduler.stats()).toMatchObject({ runningReplies: 0 });

    const broken = heldSpeech();
    const reader = (await scheduler.speech(broken.speak)('Bonjour.', 'female-french')).getReader();
    broken.fail();
    await expect(reader.read()).rejects.toThrow('lost');
    expect(scheduler.stats()).toMatchObject({ runningReplies: 0 });

    // Gone with audio waiting unread, so nothing was mid-read to notice: the cancel itself frees the slot.
    const unread = heldSpeech(new Uint8Array([1, 2]));
    const waiting = await scheduler.speech(unread.speak)('Bonjour.', 'female-french');
    await new Promise((r) => setTimeout(r, 0));
    await waiting.cancel();
    expect(unread.cancelled()).toBe(true);
    expect(scheduler.stats()).toMatchObject({ runningReplies: 0 });

    const refused = scheduler.speech(async () => {
      throw new Error('Ollama returned 404');
    });
    await expect(refused('Bonjour.', 'female-french')).rejects.toThrow('404');
    expect(scheduler.stats()).toMatchObject({ runningReplies: 0 });
  });
});
