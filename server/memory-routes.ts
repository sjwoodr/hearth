import type { Hono } from 'hono';
import type { DB } from './db.ts';
import {
  addMemory,
  deleteMemory,
  getMemory,
  isMemoryKind,
  isMemorySubject,
  listMemories,
  MAX_MEMORY_CHARS,
  updateMemory,
} from './memories.ts';
import {
  cleanPersonaAbout,
  cleanPersonaName,
  forgetPersonaVersion,
  getPersona,
  personaHistory,
  restorePersona,
  savePersona,
} from './persona.ts';
import type { SessionUser } from './sessions.ts';
import { addDays, calendarDay, localDay, MAX_FOR_NOW_DAYS_BY_HAND } from '../shared/for-now.ts';

type Env = { Variables: { user: SessionUser } };

const parseId = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function cleanContent(value: unknown): string | { error: string } {
  const content = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!content || content.length > MAX_MEMORY_CHARS) return { error: `A memory must be 1-${MAX_MEMORY_CHARS} characters.` };
  return content;
}

const BAD_SUBJECT = { error: 'Subject must be "user" or "assistant".' };
const NOT_FOR_NOW = { error: 'Only memories about you that are recalled when relevant can be "for now".' };

/** A "for now" end date from a request: null (lasting), or a real day from today to a year ahead. */
function cleanUntil(value: unknown, today: string): string | null | { error: string } {
  if (value === null) return null;
  const day = calendarDay(value);
  if (!day || day < today || day > addDays(today, MAX_FOR_NOW_DAYS_BY_HAND))
    return { error: `"until" must be a date (YYYY-MM-DD) from today to ${MAX_FOR_NOW_DAYS_BY_HAND} days ahead, or null.` };
  return day;
}

/**
 * `defaultName` is the server's assistant name, shown when the user hasn't given theirs one;
 * `systemPrompt` is hearth's own instructions, shown read-only beside the persona.
 */
export function registerMemoryRoutes(
  api: Hono<Env>,
  db: DB,
  defaultName = 'hearth',
  systemPrompt: (name: string) => string = () => '',
): void {
  const notFound = { error: 'Memory not found.' };

  api.get('/memories', (c) => c.json(listMemories(db, c.get('user').id)));

  api.post('/memories', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isMemoryKind(body?.kind)) return c.json({ error: 'Kind must be "profile" or "fact".' }, 400);
    const subject = body?.subject ?? 'user';
    if (!isMemorySubject(subject)) return c.json(BAD_SUBJECT, 400);
    const content = cleanContent(body?.content);
    if (typeof content !== 'string') return c.json(content, 400);
    const until = body?.until === undefined ? null : cleanUntil(body.until, localDay());
    if (until !== null && typeof until === 'object') return c.json(until, 400);
    if (until && (body.kind !== 'fact' || subject !== 'user')) return c.json(NOT_FOR_NOW, 400);
    return c.json(addMemory(db, c.get('user').id, body.kind, content, null, subject, until), 201);
  });

  api.patch('/memories/:id', async (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    const current = id ? getMemory(db, userId, id) : undefined;
    if (!id || !current) return c.json(notFound, 404);
    const body = await c.req.json().catch(() => null);
    const change: Parameters<typeof updateMemory>[3] = {};
    if (body?.kind !== undefined) {
      if (!isMemoryKind(body.kind)) return c.json({ error: 'Kind must be "profile" or "fact".' }, 400);
      change.kind = body.kind;
    }
    if (body?.subject !== undefined) {
      if (!isMemorySubject(body.subject)) return c.json(BAD_SUBJECT, 400);
      change.subject = body.subject;
    }
    if (body?.content !== undefined) {
      const content = cleanContent(body.content);
      if (typeof content !== 'string') return c.json(content, 400);
      change.content = content;
    }
    // Kept from under "Ended": the only value it takes is null (for-now.ts sets it).
    if (body?.ended_on !== undefined) {
      if (body.ended_on !== null) return c.json({ error: '"ended_on" can only be cleared (null).' }, 400);
      change.ended_on = null;
    }
    // Promoting to always-remembered or filing under the assistant ends "for now" (updateMemory).
    if (body?.until !== undefined) {
      const until = cleanUntil(body.until, localDay());
      if (until !== null && typeof until === 'object') return c.json(until, 400);
      if (until && ((change.kind ?? current.kind) !== 'fact' || (change.subject ?? current.subject) !== 'user')) return c.json(NOT_FOR_NOW, 400);
      change.until = until;
    }
    updateMemory(db, userId, id, change);
    return c.json(getMemory(db, userId, id));
  });

  api.delete('/memories/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (!id || !deleteMemory(db, c.get('user').id, id)) return c.json(notFound, 404);
    return c.json({ ok: true });
  });

  // Who the assistant is to this user (persona.ts): the name it answers to and their description of it.
  const personaView = (userId: number) => {
    const persona = getPersona(db, userId);
    // The fixed part, as this user's assistant reads it: a persona adds to it and can't change it.
    return { ...persona, defaultName, history: personaHistory(db, userId), instructions: systemPrompt(persona.name || defaultName) };
  };

  api.get('/persona', (c) => c.json(personaView(c.get('user').id)));

  api.put('/persona', async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = cleanPersonaName(body?.name);
    if (typeof name !== 'string') return c.json(name, 400);
    const about = cleanPersonaAbout(body?.about);
    if (typeof about !== 'string') return c.json(about, 400);
    const userId = c.get('user').id;
    savePersona(db, userId, name, about);
    return c.json(personaView(userId));
  });

  api.post('/persona/restore', async (c) => {
    const body = await c.req.json().catch(() => null);
    const userId = c.get('user').id;
    const id = typeof body?.id === 'number' ? body.id : undefined;
    if (!id || !restorePersona(db, userId, id)) return c.json({ error: 'That version is gone.' }, 404);
    return c.json(personaView(userId));
  });

  api.delete('/persona/history/:id', (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    if (!id || !forgetPersonaVersion(db, userId, id)) return c.json({ error: 'That version is gone.' }, 404);
    return c.json(personaView(userId));
  });
}
