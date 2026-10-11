import { describe, expect, it } from 'vitest';
import { plainSymbols } from '../shared/plain-symbols.ts';
import { call, setupApp, signIn } from './testing.ts';

describe('plain symbols', () => {
  it('turns LaTeX symbol markup into characters', () => {
    expect(plainSymbols('(User $\\rightarrow$ Me $\\rightarrow$ Search)')).toBe('(User → Me → Search)');
    expect(plainSymbols('3 $\\times$ 4 $\\neq$ 13, and \\(\\leq\\) too')).toBe('3 × 4 ≠ 13, and ≤ too');
    expect(plainSymbols('20$^\\circ$C')).toBe('20°C');
  });

  it('leaves dollar amounts, real math and code alone', () => {
    const untouched = [
      'It costs $5 and the deluxe is $10.',
      'The integral $\\int_0^1 x\\,dx$ is one half.',
      'Write `$\\rightarrow$` in LaTeX for an arrow.',
      '```\n$\\rightarrow$\n```',
      'A plain reply with no markup.',
    ];
    for (const text of untouched) expect(plainSymbols(text)).toBe(text);
  });

  it("drops gpt-oss's citation marks, and only those", () => {
    expect(plainSymbols('the primary QB through the 2026 season 【5†source】.')).toBe('the primary QB through the 2026 season.');
    expect(plainSymbols('Two facts【1†L10-L20】 and more【3†source】!')).toBe('Two facts and more!');
    const untouched = ['【重要】 ordinary brackets stay', 'Code keeps it: `【5†source】`', '```\n【1†source】\n```'];
    for (const text of untouched) expect(plainSymbols(text)).toBe(text);
  });
});

describe('saving replies', () => {
  it('stores a reply with its symbols in plain characters', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = ((await (await call(ctx.app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
    ctx.model.reply = ['User $\\right', 'arrow$ Me'];
    await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: 'hi' })).text();
    const { messages } = (await (await call(ctx.app, cookie, 'GET', `/conversations/${id}`)).json()) as {
      messages: { content: string }[];
    };
    expect(messages.at(-1)!.content).toBe('User → Me');
  });
});
