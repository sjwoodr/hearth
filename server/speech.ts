// Reading aloud (README "Listen"): a reply, or a word from the lookup popup, spoken by a small speech
// model (HEARTH_SPEECH_MODEL) in the voices each user picks, one for English and one for French. The
// audio streams to the browser as the model makes it and is never stored; the only thing kept is the
// user's choice of voices.
import type { Hono } from 'hono';
import { MAX_SPEECH_CHARS, SPEECH_LANGUAGES, speechLanguage, type SpeechLanguage } from '../shared/speech.ts';
import type { DB } from './db.ts';
import type { SpeakFn } from './ollama.ts';
import type { SessionUser } from './sessions.ts';

type Env = { Variables: { user: SessionUser } };

export type SpeechDeps = {
  speak: SpeakFn;
  /** The speech model's voices, or undefined if it can't speak (not pulled, Ollama unreachable). */
  voices: () => Promise<string[] | undefined>;
  /** Each language's voice until a user picks one (HEARTH_SPEECH_VOICE_ENGLISH, _FRENCH). */
  defaultVoices: Voices;
};

type Voices = Record<SpeechLanguage, string>;

const VOICES_KEPT_MS = 10 * 60 * 1000;
const NO_VOICES_KEPT_MS = 30 * 1000;

/**
 * `load` asked at most once per 10 minutes (every page load asks for the voices), and a failure
 * retried after 30 seconds, so a speech model pulled later shows up without a restart.
 */
export function cachedVoices(load: () => Promise<string[] | undefined>, now = Date.now): () => Promise<string[] | undefined> {
  let kept: { voices: string[] | undefined; until: number } | undefined;
  let asking: Promise<string[] | undefined> | undefined;
  return async () => {
    if (kept && now() < kept.until) return kept.voices;
    asking ??= load()
      .catch(() => undefined)
      .then((voices) => {
        kept = { voices, until: now() + (voices ? VOICES_KEPT_MS : NO_VOICES_KEPT_MS) };
        asking = undefined;
        return voices;
      });
    return asking;
  };
}

export function savedVoices(db: DB, userId: number): Record<SpeechLanguage, string | null> {
  const row = db.prepare('SELECT english_voice, french_voice FROM users WHERE id = ?').get(userId) as
    | { english_voice: string | null; french_voice: string | null }
    | undefined;
  return { english: row?.english_voice ?? null, french: row?.french_voice ?? null };
}

// Fixed column names, so nothing from a request is ever put into the SQL.
const COLUMN: Record<SpeechLanguage, string> = { english: 'english_voice', french: 'french_voice' };

export function saveVoice(db: DB, userId: number, language: SpeechLanguage, voice: string): void {
  db.prepare(`UPDATE users SET ${COLUMN[language]} = ? WHERE id = ?`).run(voice, userId);
}

const isLanguage = (value: unknown): value is SpeechLanguage => SPEECH_LANGUAGES.some((l) => l === value);

const NOT_AVAILABLE = "Reading aloud isn't available right now: the speech model didn't answer.";

export function registerSpeechRoutes(api: Hono<Env>, db: DB, deps: SpeechDeps | undefined): void {
  if (!deps) return;
  // A default the model doesn't have falls back to its first voice, and a saved voice it no longer has
  // (it was swapped for another) to the default.
  const defaultsFor = (voices: string[]): Voices => {
    const usable = (voice: string) => (voices.includes(voice) ? voice : voices[0]!);
    return { english: usable(deps.defaultVoices.english), french: usable(deps.defaultVoices.french) };
  };
  const chosenFor = (userId: number, voices: string[]): Voices => {
    const saved = savedVoices(db, userId);
    const defaults = defaultsFor(voices);
    const usable = (language: SpeechLanguage) => {
      const voice = saved[language];
      return voice && voices.includes(voice) ? voice : defaults[language];
    };
    return { english: usable('english'), french: usable('french') };
  };

  api.get('/voices', async (c) => {
    const voices = await deps.voices();
    if (!voices) return c.json({ error: NOT_AVAILABLE }, 503);
    return c.json({ voices, chosen: chosenFor(c.get('user').id, voices), defaults: defaultsFor(voices) });
  });

  api.put('/voice', async (c) => {
    const body = await c.req.json().catch(() => null);
    const voices = await deps.voices();
    if (!voices) return c.json({ error: NOT_AVAILABLE }, 503);
    if (!isLanguage(body?.language)) return c.json({ error: 'Pick a voice for English or for French.' }, 400);
    if (typeof body.voice !== 'string' || !voices.includes(body.voice)) return c.json({ error: 'Pick one of the voices listed.' }, 400);
    saveVoice(db, c.get('user').id, body.language, body.voice);
    return c.json({ language: body.language, voice: body.voice });
  });

  // The text never goes in a log: it is a reply, or a word from one.
  api.post('/speech', async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!/[\p{L}\p{N}]/u.test(text) || text.length > MAX_SPEECH_CHARS) {
      return c.json({ error: `Send 1-${MAX_SPEECH_CHARS} characters of text.` }, 400);
    }
    const voices = await deps.voices();
    if (!voices) return c.json({ error: NOT_AVAILABLE }, 503);
    const user = c.get('user');
    // Without a voice, the user's for the text's language (the client sends one per piece).
    const voice = body.voice === undefined ? chosenFor(user.id, voices)[speechLanguage(text) ?? 'english'] : body.voice;
    if (typeof voice !== 'string' || !voices.includes(voice)) return c.json({ error: 'Pick one of the voices listed.' }, 400);
    try {
      const audio = await deps.speak(text, voice, { userId: user.id, signal: c.req.raw.signal });
      return c.body(audio, 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    } catch (err) {
      if (!c.req.raw.signal.aborted) console.error('speech: reading aloud failed:', err instanceof Error ? err.message : err);
      return c.json({ error: "Couldn't read that aloud." }, 502);
    }
  });
}
