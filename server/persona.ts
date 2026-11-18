// Who the assistant is to each user: the name it answers to and a description the user writes on the
// Memories page (voice, backstory, how it relates to them). It sits beside what the model learned about
// itself in chats (memories with subject 'assistant', memories.ts) in the system prompt's "Who you are"
// section. The measured behaviour (French, symbols, questions, the app) stays in prompts/system.md for
// everyone: a persona adds to it, it can't replace it.
//
// Empty fields mean the server's defaults, so nothing changes for anyone until they write one.
import type { DB } from './db.ts';

export const MAX_PERSONA_NAME_CHARS = 40;
export const MAX_PERSONA_ABOUT_CHARS = 2000;
/** Versions kept per user; older ones are dropped as new ones are saved. */
export const MAX_PERSONA_HISTORY = 20;

export type Persona = { name: string; about: string; updated_at: string | null };
export type PersonaVersion = { id: number; name: string; about: string; saved_at: string };

/** A user's persona; empty fields (and no date) when they never wrote one. */
export function getPersona(db: DB, userId: number): Persona {
  const row = db.prepare('SELECT name, about, updated_at FROM personas WHERE user_id = ?').get(userId) as Persona | undefined;
  return row ?? { name: '', about: '', updated_at: null };
}

/** The name the user's assistant answers to: theirs if they gave it one, else the server's. */
export function assistantNameFor(db: DB, userId: number, fallback: string): string {
  return getPersona(db, userId).name || fallback;
}

/** One line, no stray spacing; '' is allowed (the default name). */
export function cleanPersonaName(value: unknown): string | { error: string } {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (name.length > MAX_PERSONA_NAME_CHARS) return { error: `A name must be at most ${MAX_PERSONA_NAME_CHARS} characters.` };
  return name;
}

/** Paragraphs kept, trailing spaces trimmed; '' is allowed (no description). */
export function cleanPersonaAbout(value: unknown): string | { error: string } {
  const about = typeof value === 'string' ? value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  if (about.length > MAX_PERSONA_ABOUT_CHARS) return { error: `The description must be at most ${MAX_PERSONA_ABOUT_CHARS} characters.` };
  return about;
}

/** Saves a persona, keeping the one it replaces in the history. No change, no new version. */
export function savePersona(db: DB, userId: number, name: string, about: string): Persona {
  const current = getPersona(db, userId);
  if (current.name === name && current.about === about) return current;
  db.transaction(() => {
    if (current.updated_at !== null) {
      db.prepare('INSERT INTO persona_history (user_id, name, about) VALUES (?, ?, ?)').run(userId, current.name, current.about);
      db.prepare(
        `DELETE FROM persona_history WHERE user_id = ? AND id NOT IN
           (SELECT id FROM persona_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      ).run(userId, userId, MAX_PERSONA_HISTORY);
    }
    db.prepare(
      `INSERT INTO personas (user_id, name, about) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, about = excluded.about, updated_at = datetime('now')`,
    ).run(userId, name, about);
  })();
  return getPersona(db, userId);
}

/** Earlier versions, newest first: only the user's own. */
export function personaHistory(db: DB, userId: number): PersonaVersion[] {
  return db
    .prepare('SELECT id, name, about, saved_at FROM persona_history WHERE user_id = ? ORDER BY id DESC')
    .all(userId) as PersonaVersion[];
}

/** Brings back an earlier version (the current one goes into the history); undefined if it isn't the user's. */
export function restorePersona(db: DB, userId: number, versionId: number): Persona | undefined {
  const version = db
    .prepare('SELECT name, about FROM persona_history WHERE id = ? AND user_id = ?')
    .get(versionId, userId) as { name: string; about: string } | undefined;
  return version ? savePersona(db, userId, version.name, version.about) : undefined;
}
