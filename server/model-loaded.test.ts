// ollamaModelLoaded against a fake Ollama /api/ps: what Ollama lists, tags, the gateway's token,
// and saying nothing when it can't tell.
import { Hono, type Context } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { ollamaModelLoaded } from './ollama.ts';
import { listen } from './testing.ts';

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeOllama(handler: (c: Context) => Response | Promise<Response>) {
  return listen(new Hono().get('/api/ps', handler), servers);
}

const ps = (...names: string[]) => ({ models: names.map((name) => ({ name, model: name })) });

describe('whether Ollama has the model in memory', () => {
  it('is true when /api/ps lists it, false when it lists others or nothing', async () => {
    const url = await fakeOllama((c) => c.json(ps('gemma4:26b-a4b-it-qat', 'embeddinggemma:300m-qat-q8_0')));
    const loaded = ollamaModelLoaded(url);
    expect(await loaded('gemma4:26b-a4b-it-qat')).toBe(true);
    expect(await loaded('qwen3:14b')).toBe(false);
    const empty = await fakeOllama((c) => c.json({ models: [] }));
    expect(await ollamaModelLoaded(empty)('gemma4:26b-a4b-it-qat')).toBe(false);
  });

  it('treats a name without a tag as :latest, as Ollama does', async () => {
    const url = await fakeOllama((c) => c.json(ps('mistral:latest')));
    expect(await ollamaModelLoaded(url)('mistral')).toBe(true);
  });

  it('sends the gateway token', async () => {
    let auth: string | undefined;
    const url = await fakeOllama((c) => {
      auth = c.req.header('authorization');
      return c.json(ps('m:1'));
    });
    await ollamaModelLoaded({ url, token: 'tok' })('m:1');
    expect(auth).toBe('Bearer tok');
  });

  it("can't tell (undefined) when Ollama errors, is unreachable, or doesn't answer within a second", async () => {
    const failing = await fakeOllama((c) => c.json({ error: 'boom' }, 500));
    expect(await ollamaModelLoaded(failing)('m:1')).toBeUndefined();
    expect(await ollamaModelLoaded('http://127.0.0.1:1')('m:1')).toBeUndefined();
    const slow = await fakeOllama(() => new Promise<Response>((r) => setTimeout(() => r(Response.json(ps('m:1'))), 3000)));
    const started = Date.now();
    expect(await ollamaModelLoaded(slow)('m:1')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
