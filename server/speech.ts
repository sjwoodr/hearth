// Reading aloud (README "Listen"): a reply, or a word from the lookup popup, spoken by a small speech
// model (HEARTH_SPEECH_MODEL) in the voice each user picks. The audio streams to the browser as the
// model makes it and is never stored; the only thing kept is the user's choice of voice.
import type { Hono } from 'hono';
import { MAX_SPEECH_CHARS } from '../shared/speech.ts';
import type { DB } from './db.ts';
import type { SpeakFn } from './ollama.ts';
import type { SessionUser } from './sessions.ts';

type Env = { Variables: { user: SessionUser } };

export type SpeechDeps = {
  speak: SpeakFn;
  /** The speech model's voices, or undefined if it can't speak (not pulled, Ollama unreachable). */
  voices: () => Promise<string[] | undefined>;
  /** The voice until a user picks one (HEARTH_SPEECH_VOICE). */
  defaultVoice: string;
};

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

export function savedVoice(db: DB, userId: number): string | null {
  const row = db.prepare('SELECT voice FROM users WHERE id = ?').get(userId) as { voice: string | null } | undefined;
  return row?.voice ?? null;
}

export function saveVoice(db: DB, userId: number, voice: string): void {
  db.prepare('UPDATE users SET voice = ? WHERE id = ?').run(voice, userId);
}

const NOT_AVAILABLE = "Reading aloud isn't available right now: the speech model didn't answer.";

export function registerSpeechRoutes(api: Hono<Env>, db: DB, deps: SpeechDeps | undefined): void {
  if (!deps) return;
  // A saved voice the model no longer has (it was swapped for another) falls back to the default.
  const voiceFor = (userId: number, voices: string[]) => {
    const saved = savedVoice(db, userId);
    if (saved && voices.includes(saved)) return saved;
    return voices.includes(deps.defaultVoice) ? deps.defaultVoice : voices[0]!;
  };

  api.get('/voices', async (c) => {
    const voices = await deps.voices();
    if (!voices) return c.json({ error: NOT_AVAILABLE }, 503);
    const defaultVoice = voices.includes(deps.defaultVoice) ? deps.defaultVoice : voices[0]!;
    return c.json({ voices, voice: voiceFor(c.get('user').id, voices), defaultVoice });
  });

  api.put('/voice', async (c) => {
    const body = await c.req.json().catch(() => null);
    const voices = await deps.voices();
    if (!voices) return c.json({ error: NOT_AVAILABLE }, 503);
    if (typeof body?.voice !== 'string' || !voices.includes(body.voice)) return c.json({ error: 'Pick one of the voices listed.' }, 400);
    saveVoice(db, c.get('user').id, body.voice);
    return c.json({ voice: body.voice });
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
    const voice = body.voice === undefined ? voiceFor(user.id, voices) : body.voice;
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
