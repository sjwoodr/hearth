import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, setupApp, signIn, type TestApp } from './testing.ts';
import { DECLINED, MAX_SEARCHES_PER_TURN, resultsForModel, searchQuery, searxngSearch } from './web-search.ts';

type Event = { type: string; query?: string; messageId?: number; sources?: { title: string; url: string }[] };

async function newChat(app: TestApp, cookie: string): Promise<number> {
  return ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
}

async function post(app: TestApp, cookie: string, path: string, body: object) {
  const res = await call(app, cookie, 'POST', path, body);
  const events = res.ok
    ? (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event)
    : [];
  return { res, events };
}

type Stored = { role: string; content: string; sources: { title: string; url: string }[] | null };
async function chat(app: TestApp, cookie: string, id: number) {
  return (await (await call(app, cookie, 'GET', `/conversations/${id}`)).json()) as {
    messages: Stored[];
    pendingSearch: { query: string } | null;
  };
}

async function setup() {
  const ctx = setupApp({ webSearch: true });
  const cookie = await signIn(ctx, 'steve');
  const id = await newChat(ctx.app, cookie);
  return { ...ctx, cookie, id };
}

describe('asking to search', () => {
  it('runs nothing: the request waits for the user, and no reply is saved yet', async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('Fishbach tour dates 2026');
    const { events } = await post(app, cookie, `/conversations/${id}/messages`, { content: 'When is Fishbach touring?' });

    expect(events.at(-1)).toEqual({ type: 'search', query: 'Fishbach tour dates 2026' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(model.searched).toEqual([]);
    const after = await chat(app, cookie, id);
    expect(after.messages.map((m) => m.role)).toEqual(['user']);
    // Survives a reload, so the card comes back.
    expect(after.pendingSearch).toEqual({ query: 'Fishbach tour dates 2026' });
  });

  it('tells the model the date and offers the tool on every reply', async () => {
    const { app, model, cookie, id } = await setup();
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'Salut !' });
    expect(model.toolsOffered).toEqual([true]);
    expect(model.calls[0]![0]!.content).toContain('Today is Friday, 2 October 2026.');
  });

  it('is never offered without a search engine, and there is nothing to approve', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'steve');
    const id = await newChat(ctx.app, cookie);
    ctx.model.asks.push('anything');
    const { events } = await post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    expect(ctx.model.toolsOffered).toEqual([false]);
    expect(ctx.model.calls[0]![0]!.content).not.toContain('web_search');
    expect(events.at(-1)?.type).toBe('done');
    expect((await post(ctx.app, cookie, `/conversations/${id}/search`, { approve: true })).res.status).toBe(409);
  });
});

describe('answering the card', () => {
  it('approve: searches for exactly the asked query, then answers from the results and keeps the links', async () => {
    const { app, model, db, cookie, id } = await setup();
    model.asks.push('Fishbach tour dates 2026');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'When is Fishbach touring?' });
    model.reply = ['She plays Le Havre on 16 October (example.com).'];
    const { events } = await post(app, cookie, `/conversations/${id}/search`, { approve: true });

    expect(model.searched).toEqual(['Fishbach tour dates 2026']);
    expect(events.map((e) => e.type)).toEqual(['start', 'searching', 'delta', 'done']);
    const sources = [{ title: 'Fishbach tour', url: 'https://example.com/tour' }];
    expect(events.at(-1)?.sources).toEqual(sources);

    const prompt = model.calls.at(-1)!;
    expect(prompt.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: 'web_search' } }] });
    expect(prompt.at(-1)).toEqual({ role: 'tool', tool_name: 'web_search', content: resultsForModel('Fishbach tour dates 2026', model.results as never) });
    expect(prompt.at(-1)!.content).toContain('untrusted');

    const after = await chat(app, cookie, id);
    expect(after.pendingSearch).toBeNull();
    expect(after.messages.at(-1)).toMatchObject({ role: 'assistant', sources });
    // The results themselves are never stored, only the links.
    const everything = JSON.stringify(db.prepare('SELECT * FROM messages').all());
    expect(everything).not.toContain('Le Havre, 16 October.');
  });

  it('decline: searches nothing and tells the model to answer without it', async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('Ligue 1 results');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'Who won yesterday?' });
    const { events } = await post(app, cookie, `/conversations/${id}/search`, { approve: false });

    expect(model.searched).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(model.calls.at(-1)!.at(-1)).toEqual({ role: 'tool', tool_name: 'web_search', content: DECLINED });
    expect((await chat(app, cookie, id)).messages.at(-1)).toMatchObject({ role: 'assistant', sources: null });
  });

  it('runs a search once, however many times the card is answered', async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('q');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    expect((await post(app, cookie, `/conversations/${id}/search`, { approve: true })).res.status).toBe(200);
    expect((await post(app, cookie, `/conversations/${id}/search`, { approve: true })).res.status).toBe(409);
    expect(model.searched).toEqual(['q']);
  });

  it('wants an explicit yes or no', async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('q');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    for (const approve of [undefined, 'yes', 1]) {
      expect((await post(app, cookie, `/conversations/${id}/search`, { approve })).res.status).toBe(400);
    }
    expect(model.searched).toEqual([]);
    expect((await chat(app, cookie, id)).pendingSearch).toEqual({ query: 'q' });
  });

  it("can't be seen or answered by another user", async () => {
    const ctx = await setup();
    ctx.model.asks.push('private query');
    await post(ctx.app, ctx.cookie, `/conversations/${ctx.id}/messages`, { content: 'News?' });
    const other = await signIn(ctx, 'mallory');

    expect((await call(ctx.app, other, 'GET', `/conversations/${ctx.id}`)).status).toBe(404);
    expect((await post(ctx.app, other, `/conversations/${ctx.id}/search`, { approve: true })).res.status).toBe(404);
    expect(ctx.model.searched).toEqual([]);
    expect((await chat(ctx.app, ctx.cookie, ctx.id)).pendingSearch).toEqual({ query: 'private query' });
  });

  it('is dropped when the user sends something else or retries', async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('first');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'Never mind.' });
    expect((await chat(app, cookie, id)).pendingSearch).toBeNull();

    model.asks.push('second');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News again?' });
    await post(app, cookie, `/conversations/${id}/retry`, {});
    expect((await chat(app, cookie, id)).pendingSearch).toBeNull();
    expect((await post(app, cookie, `/conversations/${id}/search`, { approve: true })).res.status).toBe(409);
    expect(model.searched).toEqual([]);
  });

  it('answers without results when the search fails', async () => {
    const { app, model, cookie, id } = await setup();
    model.results = new Error('SearXNG returned 502');
    model.asks.push('q');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    const { events } = await post(app, cookie, `/conversations/${id}/search`, { approve: true });
    expect(events.at(-1)?.type).toBe('done');
    expect(model.calls.at(-1)!.at(-1)!.content).toContain('The search failed (SearXNG returned 502)');
    expect((await chat(app, cookie, id)).messages.at(-1)?.sources).toBeNull();
  });

  it(`stops offering the tool after ${MAX_SEARCHES_PER_TURN} searches for one message`, async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('one', 'two', 'three');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    const second = await post(app, cookie, `/conversations/${id}/search`, { approve: true });
    expect(second.events.at(-1)).toEqual({ type: 'search', query: 'two' });
    const third = await post(app, cookie, `/conversations/${id}/search`, { approve: true });
    expect(third.events.at(-1)?.type).toBe('done');
    expect(model.toolsOffered).toEqual([true, true, false]);
    // Both searches' links are kept.
    expect(third.events.at(-1)?.sources).toHaveLength(2);
  });

  it('shows later turns where a reply came from', async () => {
    const { app, model, cookie, id } = await setup();
    model.asks.push('q');
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'News?' });
    await post(app, cookie, `/conversations/${id}/search`, { approve: true });
    await post(app, cookie, `/conversations/${id}/messages`, { content: 'Where did you read that?' });
    const reply = model.calls.at(-1)!.findLast((m) => m.role === 'assistant')!;
    expect(reply.content).toContain('[Sources: https://example.com/tour]');
  });

  it('titles a new chat after the final reply, not at the card', async () => {
    const { app, model, cookie, id } = await setup();
    model.title = 'Fishbach on tour';
    model.asks.push('q');
    const first = await post(app, cookie, `/conversations/${id}/messages`, { content: 'When is Fishbach touring?' });
    expect(first.events.some((e) => e.type === 'title')).toBe(false);
    const { events } = await post(app, cookie, `/conversations/${id}/search`, { approve: true });
    expect(events.at(-1)?.type).toBe('title');
  });
});

describe('the search engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps five web links, clipped, and drops anything that is not http(s)', async () => {
    const results = [
      { title: 'Bad', url: 'javascript:alert(1)', content: 'x' },
      { title: 'File', url: 'file:///etc/passwd', content: 'x' },
      ...Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, url: `https://site${i}.example/`, content: 'word '.repeat(200) })),
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results })));
    vi.stubGlobal('fetch', fetchMock);
    const found = await searxngSearch('http://127.0.0.1:8888')('café & croissants');

    expect(found.map((r) => r.url)).toEqual([0, 1, 2, 3, 4].map((i) => `https://site${i}.example/`));
    expect(found[0]!.snippet.length).toBeLessThanOrEqual(300);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('q')).toBe('café & croissants');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('reports a failed search', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));
    await expect(searxngSearch('http://127.0.0.1:8888')('q')).rejects.toThrow('502');
  });

  it('only takes a usable query from a web_search call', () => {
    expect(searchQuery({ function: { name: 'web_search', arguments: { query: '  Louvre hours ' } } })).toBe('Louvre hours');
    expect(searchQuery({ function: { name: 'web_search', arguments: { query: '' } } })).toBeUndefined();
    expect(searchQuery({ function: { name: 'web_search', arguments: {} } })).toBeUndefined();
    expect(searchQuery({ function: { name: 'run_shell', arguments: { query: 'rm -rf /' } } })).toBeUndefined();
    expect(searchQuery({ function: { name: 'web_search', arguments: { query: 'x'.repeat(500) } } })!.length).toBeLessThanOrEqual(200);
  });
});
