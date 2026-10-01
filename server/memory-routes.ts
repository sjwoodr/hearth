import type { Hono } from 'hono';
import type { DB } from './db.ts';
import {
  addMemory,
  deleteMemory,
  getMemory,
  isMemoryKind,
  listMemories,
  MAX_MEMORY_CHARS,
  updateMemory,
} from './memories.ts';
import type { SessionUser } from './sessions.ts';

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

export function registerMemoryRoutes(api: Hono<Env>, db: DB): void {
  const notFound = { error: 'Memory not found.' };

  api.get('/memories', (c) => c.json(listMemories(db, c.get('user').id)));

  api.post('/memories', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isMemoryKind(body?.kind)) return c.json({ error: 'Kind must be "profile" or "fact".' }, 400);
    const content = cleanContent(body?.content);
    if (typeof content !== 'string') return c.json(content, 400);
    return c.json(addMemory(db, c.get('user').id, body.kind, content), 201);
  });

  api.patch('/memories/:id', async (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    if (!id || !getMemory(db, userId, id)) return c.json(notFound, 404);
    const body = await c.req.json().catch(() => null);
    const change: Parameters<typeof updateMemory>[3] = {};
    if (body?.kind !== undefined) {
      if (!isMemoryKind(body.kind)) return c.json({ error: 'Kind must be "profile" or "fact".' }, 400);
      change.kind = body.kind;
    }
    if (body?.content !== undefined) {
      const content = cleanContent(body.content);
      if (typeof content !== 'string') return c.json(content, 400);
      change.content = content;
    }
    updateMemory(db, userId, id, change);
    return c.json(getMemory(db, userId, id));
  });

  api.delete('/memories/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (!id || !deleteMemory(db, c.get('user').id, id)) return c.json(notFound, 404);
    return c.json({ ok: true });
  });
}
