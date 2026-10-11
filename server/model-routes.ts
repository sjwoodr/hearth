// The admin's model switch: list the chat models Ollama has, switch every user to one, or go back to
// the default. Admin only (users.role, granted by the admin console); see active-model.ts.
import type { Context, Hono, Next } from 'hono';
import type { ChatDeps } from './chat.ts';
import type { SessionUser } from './sessions.ts';

type Env = { Variables: { user: SessionUser } };

/** 403 for anyone who isn't an admin. */
export async function requireAdmin(c: Context<Env>, next: Next) {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Only an admin can do that.' }, 403);
  await next();
}

export function registerModelRoutes(api: Hono<Env>, deps: Pick<ChatDeps, 'modelChoice' | 'modelCatalog'>): void {
  const { modelChoice: choice, modelCatalog: catalog } = deps;

  api.get('/models', requireAdmin, async (c) => {
    if (!choice || !catalog) return c.json({ error: 'Model switching is not available here.' }, 404);
    try {
      return c.json({ active: choice.info(), models: await catalog.list() });
    } catch (err) {
      return c.json({ error: `Couldn't list Ollama's models: ${err instanceof Error ? err.message : err}` }, 502);
    }
  });

  api.put('/model', requireAdmin, async (c) => {
    if (!choice || !catalog) return c.json({ error: 'Model switching is not available here.' }, 404);
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.model === 'string' ? body.model.trim() : '';
    let models;
    try {
      models = await catalog.list();
    } catch (err) {
      return c.json({ error: `Couldn't list Ollama's models: ${err instanceof Error ? err.message : err}` }, 502);
    }
    // Only a chat model Ollama actually has: never an embedding model, never an arbitrary name.
    if (!models.some((m) => m.name === name)) return c.json({ error: `"${name}" isn't one of Ollama's chat models.` }, 400);
    choice.set(name, c.get('user').username);
    console.log(`model: ${c.get('user').username} switched everyone to ${name}`);
    return c.json({ active: choice.info() });
  });

  api.delete('/model', requireAdmin, (c) => {
    if (!choice) return c.json({ error: 'Model switching is not available here.' }, 404);
    choice.reset();
    console.log(`model: ${c.get('user').username} switched back to the default`);
    return c.json({ active: choice.info() });
  });
}
