import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ollamaThinkingChat } from './ollama.ts';
import { login, ORIGIN, sessionCookie, setupApp, THINKING_TOKENS } from './testing.ts';
import { createUser } from './users.ts';

describe('the Think toggle', () => {
  async function chatWith(think: boolean | undefined, path = 'messages') {
    const ctx = setupApp();
    await createUser(ctx.db, 'alice', 'a good password');
    const cookie = sessionCookie(await login(ctx.app, 'alice', 'a good password'));
    const call = (p: string, body?: unknown) =>
      ctx.app.request(`/api${p}`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    const id = ((await (await call('/conversations')).json()) as { id: number }).id;
    let res = await call(`/conversations/${id}/messages`, { content: 'Is « je suis allé » right?', think: path === 'messages' ? think : undefined });
    if (path === 'retry') res = await call(`/conversations/${id}/retry`, { think });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; tokens?: number; text?: string });
    return { ctx, events };
  }

  it('uses the fast model unless thinking is asked for', async () => {
    const { ctx, events } = await chatWith(undefined);
    expect(ctx.model.calls).toHaveLength(1);
    expect(ctx.model.thinkingCalls).toHaveLength(0);
    expect(events.some((e) => e.type === 'thinking')).toBe(false);
  });

  it('uses the thinking model when asked, and reports progress sparingly', async () => {
    const { ctx, events } = await chatWith(true);
    expect(ctx.model.calls).toHaveLength(0);
    expect(ctx.model.thinkingCalls).toHaveLength(1);
    const progress = events.filter((e) => e.type === 'thinking').map((e) => e.tokens);
    expect(progress).toEqual([1, 11, 21]); // the first token, then every 10, not all 25
    expect(progress.length).toBeLessThan(THINKING_TOKENS);
    expect(events.findIndex((e) => e.type === 'thinking')).toBeLessThan(events.findIndex((e) => e.type === 'delta'));
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('Considered answer.');
  });

  it('honours the toggle on retry too', async () => {
    const { ctx } = await chatWith(true, 'retry');
    expect(ctx.model.thinkingCalls).toHaveLength(1);
  });
});

describe('Think: Auto', () => {
  async function session() {
    const ctx = setupApp();
    await createUser(ctx.db, 'alice', 'a good password');
    const cookie = sessionCookie(await login(ctx.app, 'alice', 'a good password'));
    const post = (p: string, body: unknown) =>
      ctx.app.request(`/api${p}`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const id = ((await (await post('/conversations', {})).json()) as { id: number }).id;
    const say = async (content: string, think: unknown = 'auto') =>
      (await (await post(`/conversations/${id}/messages`, { content, think })).text())
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; think?: boolean; reason?: string; selfCorrected?: boolean });
    return { ctx, say };
  }

  it('thinks for a French check and says why', async () => {
    const { ctx, say } = await session();
    const events = await say('Is « La fille que chante est ma sœur » correct?');
    expect(events[0]).toMatchObject({ type: 'start', think: true, reason: 'checking your French' });
    expect(ctx.model.thinkingCalls).toHaveLength(1);
  });

  it('stays fast for ordinary chat', async () => {
    const { ctx, say } = await session();
    const events = await say('Tell me about Thomas Paine.');
    expect(events[0]).toMatchObject({ type: 'start', think: false });
    expect(events[0]!.reason).toBeUndefined();
    expect(ctx.model.calls).toHaveLength(1);
  });

  it('grades answers to a quiz hearth just gave', async () => {
    const { ctx, say } = await session();
    ctx.model.reply = ['1. La fille ___ chante. 2. Le livre ___ je lis. Give me your answers!'];
    await say('Quiz me on qui vs que', false);
    const events = await say('1) qui 2) que');
    expect(events[0]).toMatchObject({ think: true, reason: 'grading quiz answers' });
  });

  it('On and Off override the rules', async () => {
    const { ctx, say } = await session();
    await say('Tell me about Thomas Paine.', true);
    await say('Is « Je suis allé » correct?', false);
    expect(ctx.model.thinkingCalls).toHaveLength(1);
    expect(ctx.model.calls).toHaveLength(1);
  });

  it('flags a fast reply that corrected itself, and never a thinking one', async () => {
    const { ctx, say } = await session();
    ctx.model.reply = ["L'homme qui j'ai vu... (Wait, no—that's wrong. That would be que.)"];
    expect((await say('Tell me about relative pronouns', false)).find((e) => e.type === 'done')?.selfCorrected).toBe(true);
    ctx.model.reply = ['A clean answer.'];
    expect((await say('And again?', false)).find((e) => e.type === 'done')?.selfCorrected).toBeUndefined();
  });
});

describe('budget-capped thinking against a fake Ollama', () => {
  let server: http.Server | undefined;
  afterEach(() => server?.close());

  /** A fake /api/chat: thinking requests stream `thoughts` tokens then `answer`; others stream `plain`. */
  async function fakeOllama(opts: { thoughts: number; answer?: string; plain?: string; errorAfter?: number }) {
    const requests: { think: boolean; messages: { role: string; content: string }[] }[] = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const body = JSON.parse(raw);
        requests.push({ think: body.think, messages: body.messages });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const line = (o: object) => res.write(`${JSON.stringify(o)}\n`);
        if (body.think) {
          for (let i = 0; i < opts.thoughts; i++) {
            if (opts.errorAfter === i) {
              line({ error: 'model crashed' });
              return res.end();
            }
            line({ message: { thinking: `t${i} ` } });
            await new Promise((r) => setImmediate(r));
          }
          if (opts.answer) line({ message: { content: opts.answer } });
        } else line({ message: { content: opts.plain ?? '' } });
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests };
  }

  const collect = async (it: AsyncIterable<string>) => {
    let out = '';
    for await (const t of it) out += t;
    return out;
  };
  const messages = [{ role: 'user' as const, content: 'Grade: « je suis allé »' }];

  it('answers directly when thinking finishes under the budget', async () => {
    const { url, requests } = await fakeOllama({ thoughts: 5, answer: 'Correct.' });
    let seen = 0;
    const out = await collect(ollamaThinkingChat(url, 'm', 8192, 10)(messages, new AbortController().signal, { onThinking: (t) => (seen = t) }));
    expect(out).toBe('Correct.');
    expect(seen).toBe(5);
    expect(requests).toHaveLength(1);
  });

  it('stops at the budget and asks for the answer with the reasoning as notes', async () => {
    const { url, requests } = await fakeOllama({ thoughts: 500, answer: 'never reached', plain: 'Correct, with notes.' });
    const out = await collect(ollamaThinkingChat(url, 'm', 8192, 10)(messages, new AbortController().signal));
    expect(out).toBe('Correct, with notes.');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.think).toBe(false);
    const notes = requests[1]!.messages.at(-1)!.content;
    expect(notes).toContain('t0 ');
    expect(notes).toContain('t9 ');
    expect(notes).not.toContain('t10 ');
    expect(notes).toContain('Thinking time is up');
  });

  it('surfaces a real error that happens before the budget', async () => {
    const { url } = await fakeOllama({ thoughts: 50, errorAfter: 3 });
    await expect(collect(ollamaThinkingChat(url, 'm', 8192, 10)(messages, new AbortController().signal))).rejects.toThrow('model crashed');
  });
});
