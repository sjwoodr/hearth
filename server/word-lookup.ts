// The translation popup: what a tapped word or selected phrase means in its sentence. Nothing is
// stored. This runs on a small, fast model (HEARTH_WORD_MODEL), since the popup has to feel instant.
import type { Hono } from 'hono';
import { MAX_SENTENCE_CHARS } from '../shared/tapped-word.ts';
import { isPreempted } from './busy.ts';
import type { JsonFn } from './ollama.ts';
import type { SessionUser } from './sessions.ts';

type Env = { Variables: { user: SessionUser } };

export const MAX_TEXT_CHARS = 120;
const TIMEOUT_MS = 20_000;
const MAX_ANSWER_CHARS = 200;

export type WordMeaning = { translation: string; note: string };
export type LookupWord = (text: string, sentence: string) => Promise<WordMeaning>;

const SCHEMA = {
  type: 'object',
  properties: { translation: { type: 'string' }, note: { type: 'string' } },
  required: ['translation', 'note'],
};

// The examples matter: without them the small model translated the whole sentence about a third of the time.
const PROMPT =
  'You help an English speaker read French. You get a tapped word or selected phrase and its sentence. ' +
  'Give what it means in this sentence, in English.\n' +
  "translation: only its meaning, in a few words. Never translate the whole sentence unless it is what was selected. " +
  "If it is part of an idiom, give the idiom's meaning.\n" +
  'note: the dictionary form, or the idiom in French, or an empty string if it is already its dictionary form.\n' +
  'Example: Word: sent. Sentence: Le fromage sent bon. Reply: {"translation":"smells","note":"sentir"}\n' +
  'Example: Word: tombé dans les pommes. Sentence: Il est tombé dans les pommes. Reply: {"translation":"fainted","note":"tomber dans les pommes"}';

const clean = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, MAX_ANSWER_CHARS) : '');

export function makeWordLookup(json: JsonFn): LookupWord {
  return async (text, sentence) => {
    const reply = (await json(
      [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `Word: ${text}\nSentence: ${sentence}` },
      ],
      SCHEMA,
      AbortSignal.timeout(TIMEOUT_MS),
    )) as Partial<WordMeaning>;
    const translation = clean(reply.translation);
    if (!translation) throw new Error('The model gave no translation.');
    const note = clean(reply.note);
    // A note that just repeats the word says nothing.
    return { translation, note: note.toLowerCase() === text.toLowerCase() ? '' : note };
  };
}

export function registerWordRoutes(api: Hono<Env>, lookup: LookupWord | undefined): void {
  if (!lookup) return;
  api.post('/word', async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
    const sentence = typeof body?.sentence === 'string' ? body.sentence.replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length > MAX_TEXT_CHARS) return c.json({ error: `Select 1-${MAX_TEXT_CHARS} characters.` }, 400);
    if (sentence.length > MAX_SENTENCE_CHARS + MAX_TEXT_CHARS) return c.json({ error: 'That sentence is too long.' }, 400);
    try {
      return c.json(await lookup(text, sentence || text));
    } catch (err) {
      if (isPreempted(err)) return c.json({ error: 'Busy with a reply. Tap again in a moment.' }, 503);
      return c.json({ error: "Couldn't look that up." }, 502);
    }
  });
}
