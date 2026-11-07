import { describe, expect, it } from 'vitest';
import { MAX_SENTENCE_CHARS, sentenceAt, wordAt } from '../shared/tapped-word.ts';
import { PreemptedError } from './busy.ts';
import type { ChatMessage, JsonFn } from './ollama.ts';
import { call, ORIGIN, setupApp, signIn } from './testing.ts';
import { makeWordLookup, MAX_TEXT_CHARS, type LookupWord } from './word-lookup.ts';

describe('wordAt', () => {
  const at = (text: string, offset: number) => wordAt(text, offset)?.word;

  it('finds the word under an offset, accents and all', () => {
    expect(at('Le fromage sent bon', 4)).toBe('fromage');
    expect(at('Il a goûté', 7)).toBe('goûté');
    expect(wordAt('Le fromage', 4)).toEqual({ word: 'fromage', start: 3, end: 10 });
  });

  it('keeps elisions and hyphens in one word, straight or curly', () => {
    expect(at("Elle a peur de l'ombre", 18)).toBe("l'ombre");
    expect(at('de l’ombre', 6)).toBe('l’ombre');
    expect(at('un tire-bouchon', 12)).toBe('tire-bouchon');
    expect(at("aujourd'hui", 0)).toBe("aujourd'hui");
  });

  it('finds nothing on a space, punctuation or a number', () => {
    expect(at('Le vin, ici', 2)).toBeUndefined();
    expect(at('Le vin, ici', 6)).toBeUndefined();
    expect(at('en 1984', 4)).toBeUndefined();
    expect(at('', 0)).toBeUndefined();
  });
});

describe('sentenceAt', () => {
  const text = 'Il pleut. Le maire est mort ! Personne ne sait pourquoi ?\nLa cave est fermée.';

  it('returns the sentence holding the offset', () => {
    expect(sentenceAt(text, 2)).toBe('Il pleut.');
    expect(sentenceAt(text, 14)).toBe('Le maire est mort !');
    expect(sentenceAt(text, 32)).toBe('Personne ne sait pourquoi ?');
    expect(sentenceAt(text, text.length - 3)).toBe('La cave est fermée.');
  });

  it('cuts a very long sentence around the offset', () => {
    const long = `${'a '.repeat(600)}mot ${'b '.repeat(600)}`;
    const cut = sentenceAt(long, 1201);
    expect(cut.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    expect(cut).toContain('mot');
  });
});

describe('makeWordLookup', () => {
  const fake = (reply: unknown, calls: ChatMessage[][] = []): JsonFn =>
    (async (messages: ChatMessage[]) => {
      calls.push(messages);
      return reply;
    }) as JsonFn;

  it('asks about the word in its sentence, and returns the meaning', async () => {
    const calls: ChatMessage[][] = [];
    const lookup = makeWordLookup(fake({ translation: ' smells ', note: 'sentir' }, calls));
    expect(await lookup('sent', 'Le fromage sent bon.')).toEqual({ translation: 'smells', note: 'sentir' });
    expect(calls[0]?.[1]?.content).toBe('Word: sent\nSentence: Le fromage sent bon.');
  });

  it('drops a note that only repeats the word', async () => {
    expect(await makeWordLookup(fake({ translation: 'key', note: 'Clé' }))('clé', 'La clé.')).toEqual({ translation: 'key', note: '' });
  });

  it('treats an empty translation as a failure', async () => {
    await expect(makeWordLookup(fake({ translation: '  ', note: 'x' }))('a', 'b')).rejects.toThrow('no translation');
    await expect(makeWordLookup(fake({}))('a', 'b')).rejects.toThrow('no translation');
  });
});

describe('POST /api/word', () => {
  const setup = async (lookupWord: LookupWord | undefined) => {
    const ctx = setupApp({ lookupWord });
    return { ctx, cookie: await signIn(ctx, 'alice') };
  };
  const meaning = { translation: 'smells', note: 'sentir' };

  it('answers with the meaning, passing a phrase and sentence with spaces tidied', async () => {
    const seen: string[][] = [];
    const { ctx, cookie } = await setup(async (text, sentence) => {
      seen.push([text, sentence]);
      return meaning;
    });
    const res = await call(ctx.app, cookie, 'POST', '/word', { text: ' vendu\n la  mèche ', sentence: 'Il a  vendu la mèche.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(meaning);
    expect(seen).toEqual([['vendu la mèche', 'Il a vendu la mèche.']]);
  });

  it('uses the text as its own sentence when there is none', async () => {
    const seen: string[] = [];
    const { ctx, cookie } = await setup(async (_text, sentence) => {
      seen.push(sentence);
      return meaning;
    });
    await call(ctx.app, cookie, 'POST', '/word', { text: 'sent' });
    expect(seen).toEqual(['sent']);
  });

  it('refuses empty or oversized input without calling the model', async () => {
    let called = 0;
    const { ctx, cookie } = await setup(async () => {
      called += 1;
      return meaning;
    });
    for (const body of [{}, { text: '   ' }, { text: 5 }, { text: 'a'.repeat(MAX_TEXT_CHARS + 1) }, { text: 'a', sentence: 'b'.repeat(MAX_SENTENCE_CHARS + MAX_TEXT_CHARS + 1) }]) {
      expect((await call(ctx.app, cookie, 'POST', '/word', body)).status).toBe(400);
    }
    expect(called).toBe(0);
  });

  it('says busy when a reply preempts it, and fails plainly otherwise', async () => {
    const busy = await setup(async () => {
      throw new PreemptedError();
    });
    const preempted = await call(busy.ctx.app, busy.cookie, 'POST', '/word', { text: 'sent' });
    expect(preempted.status).toBe(503);
    expect((await preempted.json()).error).toMatch(/Busy/);
    const broken = await setup(async () => {
      throw new Error('secret detail from Ollama');
    });
    const failed = await call(broken.ctx.app, broken.cookie, 'POST', '/word', { text: 'sent' });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret detail');
  });

  it('needs a session', async () => {
    const { ctx } = await setup(async () => meaning);
    const res = await ctx.app.request('/api/word', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'sent' }),
    });
    expect(res.status).toBe(401);
  });

  it("doesn't exist without a lookup", async () => {
    const { ctx, cookie } = await setup(undefined);
    expect((await call(ctx.app, cookie, 'POST', '/word', { text: 'sent' })).status).toBe(404);
  });
});
