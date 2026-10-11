import { describe, expect, it } from 'vitest';
import { createModelChoice, revertIfIdle, REVERT_IDLE_MS } from './active-model.ts';
import { openDb } from './db.ts';
import type { ModelInfo } from './ollama.ts';
import { call, setupApp, signIn, type TestApp } from './testing.ts';
import { setRole } from './users.ts';

const DEFAULT = 'gemma4:26b-a4b-it-qat';
const MODELS: ModelInfo[] = [
  { name: DEFAULT, size: 15e9, capabilities: ['completion', 'vision', 'thinking', 'tools'] },
  { name: 'gpt-oss:20b', size: 13e9, capabilities: ['completion', 'thinking', 'tools'] },
  { name: 'plain:7b', size: 4e9, capabilities: ['completion'] },
];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(32).fill(7)]).toString('base64');

async function setup() {
  const db = openDb(':memory:');
  const choice = createModelChoice(db, DEFAULT);
  const ctx = setupApp({ db, modelChoice: choice, models: MODELS, thinkingBudgets: { medium: 50, high: 100, max: 200 }, webSearch: true });
  const admin = await signIn(ctx, 'alice');
  setRole(db, 'alice', 'admin');
  const user = await signIn(ctx, 'bob');
  return { ...ctx, choice, admin, user };
}

async function send(app: TestApp, cookie: string, body: object) {
  const id = ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
  const res = await call(app, cookie, 'POST', `/conversations/${id}/messages`, body);
  const events = res.ok
    ? (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; model?: string; think?: boolean })
    : [];
  return { res, events };
}

describe('roles', () => {
  it('starts everyone as a user, and only accepts known roles', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'carol');
    expect(await (await call(ctx.app, cookie, 'GET', '/me')).json()).toMatchObject({ role: 'user', isAdmin: false });
    expect(() => setRole(ctx.db, 'carol', 'boss')).toThrow(/role/);
    setRole(ctx.db, 'carol', 'admin');
    expect(await (await call(ctx.app, cookie, 'GET', '/me')).json()).toMatchObject({ role: 'admin', isAdmin: true });
  });

  it('refuses every model-switch route to a non-admin', async () => {
    const { app, user, choice } = await setup();
    expect((await call(app, user, 'GET', '/models')).status).toBe(403);
    expect((await call(app, user, 'PUT', '/model', { model: 'gpt-oss:20b' })).status).toBe(403);
    expect((await call(app, user, 'DELETE', '/model')).status).toBe(403);
    expect(choice.current()).toBe(DEFAULT);
  });
});

describe('switching the model', () => {
  it('lets an admin list and switch, and tells every user on their next request', async () => {
    const { app, admin, user } = await setup();
    const list = (await (await call(app, admin, 'GET', '/models')).json()) as { models: ModelInfo[]; active: { isDefault: boolean } };
    expect(list.models.map((m) => m.name)).toEqual(MODELS.map((m) => m.name));
    expect(list.active.isDefault).toBe(true);

    expect((await call(app, admin, 'PUT', '/model', { model: 'gpt-oss:20b' })).status).toBe(200);
    const res = await call(app, user, 'GET', '/me');
    expect(res.headers.get('X-Hearth-Model')).toBe('gpt-oss:20b');
    expect(res.headers.get('X-Hearth-Model-Default')).toBe('0');
    expect((await send(app, user, { content: 'hi' })).events[0]).toMatchObject({ type: 'start', model: 'gpt-oss:20b' });

    expect((await call(app, admin, 'DELETE', '/model')).status).toBe(200);
    expect((await call(app, user, 'GET', '/me')).headers.get('X-Hearth-Model')).toBe(DEFAULT);
  });

  it("refuses a model Ollama doesn't list (an embedding model, or any made-up name)", async () => {
    const { app, admin, choice } = await setup();
    expect((await call(app, admin, 'PUT', '/model', { model: 'embeddinggemma:300m-qat-q8_0' })).status).toBe(400);
    expect((await call(app, admin, 'PUT', '/model', { model: '../../etc' })).status).toBe(400);
    expect(choice.current()).toBe(DEFAULT);
  });
});

describe("what the switched model can't do", () => {
  it('refuses images when the model has no vision', async () => {
    const { app, admin, user, choice } = await setup();
    expect((await send(app, user, { content: 'what is this?', images: [PNG] })).res.ok).toBe(true);
    choice.set('gpt-oss:20b', 'alice');
    const { res } = await send(app, admin, { content: 'what is this?', images: [PNG] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/can't read images/);
  });

  it('answers fast when the model has no thinking, whatever the Think setting', async () => {
    const { app, user, choice, model } = await setup();
    expect((await send(app, user, { content: 'hi', think: true })).events[0]).toMatchObject({ think: true });
    choice.set('plain:7b', 'alice');
    expect((await send(app, user, { content: 'hi', think: true })).events[0]).toMatchObject({ think: false });
    expect(model.thinkingCalls).toHaveLength(1);
  });

  it("doesn't offer web search when the model can't call tools", async () => {
    const { app, user, choice, model } = await setup();
    await send(app, user, { content: 'hi' });
    choice.set('plain:7b', 'alice');
    await send(app, user, { content: 'hi' });
    expect(model.toolsOffered).toEqual([true, false]);
  });
});

describe('the active model across processes', () => {
  it('reaches another process sharing the database once its short cache expires', () => {
    const db = openDb(':memory:');
    let t = 1_000_000;
    const api = createModelChoice(db, DEFAULT, { now: () => t });
    const worker = createModelChoice(db, DEFAULT, { now: () => t });
    expect(worker.isDefault()).toBe(true);
    api.set('gpt-oss:20b', 'alice');
    t += 5000;
    expect(worker.current()).toBe('gpt-oss:20b');
    expect(worker.isDefault()).toBe(false);
    api.set(DEFAULT, 'alice');
    t += 5000;
    expect(worker.isDefault()).toBe(true);
  });
});

describe('reverting an idle switch', () => {
  const at = (iso: string) => Date.parse(iso);
  const switched = () => {
    const db = openDb(':memory:');
    const choice = createModelChoice(db, DEFAULT, { now: () => at('2026-10-11T10:00:00Z') });
    choice.set('gpt-oss:20b', 'alice');
    return choice;
  };
  const later = at('2026-10-11T10:00:00Z') + REVERT_IDLE_MS + 1000;

  it('reverts only once Ollama has unloaded it and it has gone unused', async () => {
    const choice = switched();
    expect(await revertIfIdle(choice, async () => false, at('2026-10-11T10:01:00Z'))).toBeUndefined();
    expect(await revertIfIdle(choice, async () => true, later)).toBeUndefined();
    expect(await revertIfIdle(choice, async () => undefined, later)).toBeUndefined();
    expect(choice.isDefault()).toBe(false);
    expect(await revertIfIdle(choice, async () => false, later)).toBe('gpt-oss:20b');
    expect(choice.isDefault()).toBe(true);
  });
});
