import { describe, expect, it } from 'vitest';
import { PreemptedError } from './busy.ts';
import type { DB } from './db.ts';
import { createSweep, EXTRACTION_SCHEMA, extractMemories, sanitizeExtraction } from './extract.ts';
import { rewriteEnded } from './for-now.ts';
import { addMemory, memoryContext } from './memories.ts';
import type { ChatMessage, EmbedFn, JsonFn } from './ollama.ts';
import { login, ORIGIN, sessionCookie, setupApp } from './testing.ts';
import { createUser, nameOf } from './users.ts';
import { updateMemoryKind } from './cli/admin.ts';
import { addDays, calendarDay, dayLabel, dayWithWeekday, isForNow, localDay, monthYear } from '../shared/for-now.ts';

const TODAY = '2026-11-25'; // a Wednesday

// A toy embedding: counts of a few topic words, so similarity is predictable.
const TOPICS = ['cruise', 'french', 'radio'];
const fakeEmbed: EmbedFn = async (texts) => texts.map((t) => [...TOPICS.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01]);

async function seed() {
  const ctx = setupApp();
  const named = async (u: string) => {
    const user = await createUser(ctx.db, u, 'a good password');
    return { ...user, name: nameOf(user) };
  };
  return { ...ctx, alice: await named('alice'), bob: await named('bob') };
}

function chatWith(db: DB, userId: number, lines: [string, string][]): number {
  const id = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid);
  for (const [role, content] of lines)
    db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', '-10 minutes'))`).run(id, role, content);
  return id;
}

const rows = (db: DB, userId: number) =>
  db.prepare('SELECT id, kind, subject, content, until FROM memories WHERE user_id = ? ORDER BY id').all(userId) as {
    id: number;
    kind: string;
    subject: string;
    content: string;
    until: string | null;
  }[];
const lastMessage = (messages: ChatMessage[]) => messages.at(-1)!.content;
const isLastingCheck = (messages: ChatMessage[]) => messages[0]!.content.includes('lasting=true');
const isStatedCheck = (messages: ChatMessage[]) => messages[0]!.content.includes('Answer stated=true');
const isTemporaryCheck = (messages: ChatMessage[]) => messages[0]!.content.includes('temporary=true');

describe('calendar days', () => {
  it('accepts only real days written YYYY-MM-DD', () => {
    expect(calendarDay('2026-11-29')).toBe('2026-11-29');
    expect(calendarDay('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-11-29T00:00', 'next week', '20261129', 20261129, null, undefined])
      expect(calendarDay(bad)).toBeUndefined();
  });

  it('adds days across months, years and a DST change', () => {
    expect(addDays('2026-11-25', 7)).toBe('2026-12-02');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDays('2026-11-25', -1)).toBe('2026-11-24');
  });

  it('holds through its last day', () => {
    expect(isForNow('2026-11-26', TODAY)).toBe(true);
    expect(isForNow(TODAY, TODAY)).toBe(true);
    expect(isForNow('2026-11-24', TODAY)).toBe(false);
    expect(isForNow(null, TODAY)).toBe(false);
  });

  it('labels days for people and prompts', () => {
    expect(dayLabel('2026-11-29', TODAY)).toBe('Nov 29');
    expect(dayLabel('2027-01-04', TODAY)).toBe('Jan 4, 2027');
    expect(dayWithWeekday(TODAY)).toBe('Wednesday 2026-11-25');
    expect(monthYear('2026-11-29')).toBe('November 2026');
    expect(localDay(new Date(2026, 10, 25, 23, 30))).toBe('2026-11-25');
  });
});

describe('end dates the extractor proposes', () => {
  const existing = [
    { id: 1, kind: 'fact' as const, content: 'Alice is on a cruise this week.', until: '2026-11-29' },
    { id: 2, kind: 'fact' as const, content: 'Alice keeps bees.', until: null },
  ];
  const add = (until: unknown) => sanitizeExtraction({ add: [{ content: 'Alice has her sister visiting.', until }], update: [] }, existing, TODAY).add;

  it('keeps a real day from the day after tomorrow', () => {
    expect(add('2026-11-27')).toEqual([{ content: 'Alice has her sister visiting.', until: '2026-11-27' }]);
    expect(add('2027-01-24')).toEqual([{ content: 'Alice has her sister visiting.', until: '2027-01-24' }]);
  });

  it('drops an addition that ends tomorrow or earlier: it was only about the day', () => {
    expect(add('2026-11-26')).toEqual([]);
    expect(add(TODAY)).toEqual([]);
    expect(add('2026-11-01')).toEqual([]);
  });

  it('judges one too far out, or with a malformed date, as a lasting memory', () => {
    expect(add('2027-01-25')).toEqual([{ content: 'Alice has her sister visiting.' }]);
    expect(add('2026-02-30')).toEqual([{ content: 'Alice has her sister visiting.' }]);
    expect(add('Sunday')).toEqual([{ content: 'Alice has her sister visiting.' }]);
    expect(add(undefined)).toEqual([{ content: 'Alice has her sister visiting.' }]);
  });

  it('moves the end of a memory that is already for now, even with the same words', () => {
    const update = (content: string, until: unknown) => sanitizeExtraction({ add: [], update: [{ id: 1, content, until }] }, existing, TODAY).update;
    expect(update('Alice is on a cruise until Tuesday.', '2026-12-01')).toEqual([{ id: 1, content: 'Alice is on a cruise until Tuesday.', until: '2026-12-01' }]);
    expect(update('Alice is on a cruise this week.', '2026-12-01')).toEqual([{ id: 1, content: 'Alice is on a cruise this week.', until: '2026-12-01' }]);
    // The same end, or one that isn't ahead, changes nothing about the date.
    expect(update('Alice is on a cruise this week.', '2026-11-29')).toEqual([]);
    expect(update('Alice is on a cruise this week.', TODAY)).toEqual([]);
    // Cut short to tomorrow is still a move: only a new memory must end two days out.
    expect(update('Alice is on a cruise, back tomorrow.', '2026-11-26')).toEqual([{ id: 1, content: 'Alice is on a cruise, back tomorrow.', until: '2026-11-26' }]);
    expect(update('Alice is on a cruise, loving it.', TODAY)).toEqual([{ id: 1, content: 'Alice is on a cruise, loving it.' }]);
  });

  it('takes the latest day named in the words when an update leaves "until" out', () => {
    const update = (content: string) => sanitizeExtraction({ add: [], update: [{ id: 1, content }] }, existing, TODAY).update;
    expect(update('Alice is on a cruise from 2026-11-22, now extended until 2026-12-02.')).toEqual([
      { id: 1, content: 'Alice is on a cruise from 2026-11-22, now extended until 2026-12-02.', until: '2026-12-02' },
    ]);
    // Not a real day, or one that isn't ahead: the end stays.
    expect(update('Alice is on a cruise until 2026-11-31.')[0]).not.toHaveProperty('until');
    expect(update('Alice is on a cruise that started 2026-11-20.')[0]).not.toHaveProperty('until');
    // Never for a lasting memory.
    const lasting = sanitizeExtraction({ add: [], update: [{ id: 2, content: 'Alice has kept bees since 2026-12-01.' }] }, existing, TODAY).update;
    expect(lasting[0]).not.toHaveProperty('until');
  });

  it('never gives a lasting memory an end date', () => {
    const { update } = sanitizeExtraction({ add: [], update: [{ id: 2, content: 'Alice keeps bees on her boat.', until: '2026-11-29' }] }, existing, TODAY);
    expect(update).toEqual([{ id: 2, content: 'Alice keeps bees on her boat.' }]);
  });

  it('lets the schema carry the date, and only as YYYY-MM-DD', () => {
    const until = (EXTRACTION_SCHEMA.properties.add.items.properties as Record<string, { pattern?: string }>).until!;
    expect(new RegExp(until.pattern!).test('2026-11-29')).toBe(true);
    expect(new RegExp(until.pattern!).test('Sunday')).toBe(false);
    expect(EXTRACTION_SCHEMA.properties.add.items.required).toEqual(['content']);
  });
});

describe('extracting a situation that lasts a while', () => {
  async function extract(proposal: object, opts: { lasting?: boolean; stated?: boolean; temporary?: boolean | Error } = {}) {
    const { db, alice } = await seed();
    const cruise = addMemory(db, alice.id, 'fact', 'Alice is on a cruise this week.', null, 'user', '2026-11-29');
    const bees = addMemory(db, alice.id, 'fact', 'Alice keeps bees.');
    const chat = chatWith(db, alice.id, [['user', 'Back on the ship. The piano bar is my favourite spot so far. Also: my sister arrives Friday for a week.']]);
    const asked: string[] = [];
    let prompt: ChatMessage[] = [];
    const json: JsonFn = async (messages, schema) => {
      if (schema === EXTRACTION_SCHEMA) {
        prompt = messages;
        return typeof proposal === 'function' ? proposal(cruise.id, bees.id) : proposal;
      }
      if (isTemporaryCheck(messages)) {
        asked.push(`temporary: ${lastMessage(messages)}`);
        if (opts.temporary instanceof Error) throw opts.temporary;
        return { temporary: opts.temporary ?? true };
      }
      if (isLastingCheck(messages)) {
        asked.push(`lasting: ${lastMessage(messages)}`);
        return { lasting: opts.lasting ?? true };
      }
      if (isStatedCheck(messages)) {
        asked.push(`stated: ${/MEMORY: (.*)$/m.exec(lastMessage(messages))?.[1] ?? ''}`);
        return { stated: opts.stated ?? true };
      }
      return { facts: [] };
    };
    const result = await extractMemories(db, chat, json, undefined, 'hearth', TODAY);
    return { db, alice, cruise, bees, result, asked, prompt, stored: rows(db, alice.id) };
  }

  it('tells the model today, the default end, and which memories are already for now', async () => {
    const { prompt } = await extract({ add: [], update: [] });
    expect(prompt[0]!.content).toContain('today is Wednesday 2026-11-25; then Thursday 2026-11-26, Friday 2026-11-27,');
    expect(prompt[0]!.content).toContain('Monday 2026-11-30, Tuesday 2026-12-01, Wednesday 2026-12-02, Thursday 2026-12-03,');
    expect(prompt[0]!.content).toMatch(/Wednesday 2026-12-09\.\n/);
    expect(prompt[0]!.content).toMatch(/doesn't say when it ends, use\s+2026-12-02\./);
    expect(prompt[1]!.content).toMatch(/\[\d+\] \(fact, until 2026-11-29\) Alice is on a cruise this week\./);
    expect(prompt[1]!.content).toMatch(/\[\d+\] \(fact\) Alice keeps bees\./);
  });

  it('saves a for-now memory with its end date, skipping the next-month check but not the stated one', async () => {
    const { stored, asked, result } = await extract(
      { add: [{ content: 'Alice has her sister visiting for a week.', until: '2026-12-04' }], update: [] },
      { lasting: false },
    );
    expect(stored.at(-1)).toMatchObject({ content: 'Alice has her sister visiting for a week.', until: '2026-12-04', kind: 'fact', subject: 'user' });
    expect(asked).toEqual(['temporary: MEMORY: Alice has her sister visiting for a week.', 'stated: Alice has her sister visiting for a week.']);
    expect(result).toMatchObject({ added: 1, forNow: 1, fleeting: 0 });
  });

  for (const [what, temporary] of [
    ['is an ongoing part of their life', false],
    ['the check fails', new Error('model down')],
  ] as const) {
    it(`saves a "for now" proposal as lasting when it ${what}, after the next-month check`, async () => {
      const { stored, asked, result } = await extract({ add: [{ content: 'Alice is learning the ukulele.', until: '2026-12-02' }], update: [] }, { temporary });
      expect(stored.at(-1)).toMatchObject({ content: 'Alice is learning the ukulele.', until: null });
      expect(asked).toEqual([
        'temporary: MEMORY: Alice is learning the ukulele.',
        'lasting: MEMORY: Alice is learning the ukulele.',
        'stated: Alice is learning the ukulele.',
      ]);
      expect(result).toMatchObject({ added: 1, forNow: 0 });
    });
  }

  it('writes nothing when a reply preempts the temporary check', async () => {
    await expect(extract({ add: [{ content: 'Alice is in Rome.', until: '2026-12-02' }], update: [] }, { temporary: new PreemptedError() })).rejects.toBeInstanceOf(
      PreemptedError,
    );
  });

  it('still drops a for-now memory the user never said', async () => {
    const { stored, result } = await extract({ add: [{ content: 'Alice is visiting Rome.', until: '2026-12-04' }], update: [] }, { stated: false });
    expect(stored).toHaveLength(2);
    expect(result).toMatchObject({ added: 0, unstated: 1 });
  });

  it('still asks a lasting memory whether it lasts', async () => {
    const { stored, asked, result } = await extract(
      { add: [{ content: 'Alice is at the piano bar right now.' }], update: [] },
      { lasting: false },
    );
    expect(stored).toHaveLength(2);
    expect(asked).toEqual(['lasting: MEMORY: Alice is at the piano bar right now.']);
    expect(result).toMatchObject({ added: 0, forNow: 0, fleeting: 1 });
  });

  it('updates the trip with what the user likes on it, moving its end, with no next-month check', async () => {
    const { stored, asked } = await extract(
      (cruise: number) => ({
        add: [],
        update: [{ id: cruise, content: 'Alice is on a cruise; her favourite spot aboard is the piano bar.', until: '2026-11-30' }],
      }),
      { lasting: false },
    );
    expect(stored[0]).toMatchObject({ content: 'Alice is on a cruise; her favourite spot aboard is the piano bar.', until: '2026-11-30' });
    expect(asked).toEqual([]);
  });

  it('keeps the end of a for-now memory updated without one', async () => {
    const { stored } = await extract((cruise: number) => ({ add: [], update: [{ id: cruise, content: 'Alice is on a cruise to Nassau.' }] }));
    expect(stored[0]).toMatchObject({ content: 'Alice is on a cruise to Nassau.', until: '2026-11-29' });
  });

  it('checks an update to a lasting memory, and never gives it an end date', async () => {
    const { stored, asked } = await extract((_: number, bees: number) => ({
      add: [],
      update: [{ id: bees, content: 'Alice keeps bees on the ship.', until: '2026-11-29' }],
    }));
    expect(stored[1]).toMatchObject({ content: 'Alice keeps bees on the ship.', until: null });
    expect(asked).toEqual(['lasting: MEMORY: Alice keeps bees on the ship.']);
  });
});

describe('for-now memories in replies', () => {
  const at = (db: DB, id: number, minutesAgo: number) =>
    db.prepare(`UPDATE memories SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${minutesAgo} minutes`, id);

  it('ride on every reply, whatever the message, through their last day', async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'fact', 'Alice is on a cruise this week.', null, 'user', TODAY);
    addMemory(db, alice.id, 'fact', 'Alice does ham radio.');
    const { stable, recalled, remembered } = await memoryContext(db, alice, 'good evening!', fakeEmbed, 800, undefined, TODAY);
    expect(recalled).toContain("[Going on in alice's life for now, from your memory, until the date shown. alice didn't write this.]");
    expect(recalled).toContain(`- Alice is on a cruise this week. (until ${TODAY})`);
    expect(recalled).not.toContain('ham radio');
    // Never in the system prompt (a new one would make the chat reread), never on the "Remembered" line.
    expect(stable).not.toContain('cruise');
    expect(remembered).toEqual([]);
  });

  it('stop riding after their last day, and are recalled like any memory', async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'fact', 'Alice was on a cruise.', null, 'user', '2026-11-24');
    const unrelated = await memoryContext(db, alice, 'good evening!', fakeEmbed, 800, undefined, TODAY);
    expect(unrelated.recalled).toBe('');
    const related = await memoryContext(db, alice, 'how was the cruise?', fakeEmbed, 800, undefined, TODAY);
    expect(related.recalled).toContain('[From your memory of alice');
    expect(related.recalled).toMatch(/- Alice was on a cruise\. \(\d{4}-\d{2}-\d{2}\)/);
    expect(related.remembered.map((m) => m.content)).toEqual(['Alice was on a cruise.']);
  });

  it('are listed once, as for now, even when the message is about them', async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'fact', 'Alice is on a cruise this week.', null, 'user', '2026-11-29');
    addMemory(db, alice.id, 'fact', 'Alice does ham radio.');
    const { recalled, remembered } = await memoryContext(db, alice, 'any cruise tips?', fakeEmbed, 800, undefined, TODAY);
    expect(recalled.match(/Alice is on a cruise/g)).toHaveLength(1);
    expect(recalled).not.toContain('[From your memory of alice');
    expect(remembered).toEqual([]);
  });

  it('ride at most five at a time, the most recently changed', async () => {
    const { db, alice } = await seed();
    for (let i = 1; i <= 6; i++) at(db, addMemory(db, alice.id, 'fact', `Alice has plan ${i}.`, null, 'user', '2026-11-29').id, 60 - i);
    // A message about something else, so the sixth isn't recalled as an ordinary fact instead.
    const { recalled } = await memoryContext(db, alice, 'a french lesson', fakeEmbed, 800, undefined, TODAY);
    expect(recalled).not.toContain('plan 1.');
    for (let i = 2; i <= 6; i++) expect(recalled).toContain(`plan ${i}.`);
  });

  it('come after always-remembered memories in the budget', async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'profile', 'Alice likes dry humor and long walks on the beach.');
    addMemory(db, alice.id, 'fact', 'Alice is on a long cruise around the Mediterranean with her sister this month.', null, 'user', '2026-11-29');
    // Room for either one alone (~15 and ~23 tokens), not both: the always-remembered one wins.
    const { stable, recalled } = await memoryContext(db, alice, 'hello', fakeEmbed, 30, undefined, TODAY);
    expect(stable).toContain('dry humor');
    expect(recalled).toBe('');
  });

  it("are only ever the user's own facts about themselves", async () => {
    const { db, alice, bob } = await seed();
    addMemory(db, bob.id, 'fact', 'Bob is on a cruise.', null, 'user', '2026-11-29');
    const self = addMemory(db, alice.id, 'fact', 'hearth is on holiday.', null, 'assistant');
    db.prepare('UPDATE memories SET until = ? WHERE id = ?').run('2026-11-29', self.id);
    const { recalled } = await memoryContext(db, alice, 'hello', fakeEmbed, 800, undefined, TODAY);
    expect(recalled).not.toContain('Going on');
    expect(recalled).not.toContain('Bob');
  });
});

describe('which memories can be for now', () => {
  it("only the user's own facts keep an end date", async () => {
    const { db, alice } = await seed();
    addMemory(db, alice.id, 'profile', 'Alice is on a cruise.', null, 'user', '2026-11-29');
    addMemory(db, alice.id, 'fact', 'hearth is on holiday.', null, 'assistant', '2026-11-29');
    addMemory(db, alice.id, 'fact', 'Alice is in Rome.', null, 'user', '2026-11-29');
    expect(rows(db, alice.id).map((m) => m.until)).toEqual([null, null, '2026-11-29']);
  });
});

describe('when a for-now memory ends', () => {
  async function ended(answer: (messages: ChatMessage[]) => unknown) {
    const { db, alice, bob } = await seed();
    db.prepare("UPDATE users SET display_name = 'Alice' WHERE id = ?").run(alice.id);
    const trip = addMemory(db, alice.id, 'fact', 'Alice is on a cruise; her favourite spot aboard is the piano bar.', null, 'user', '2026-11-24');
    const visit = addMemory(db, alice.id, 'fact', 'Alice has her sister visiting.', null, 'user', TODAY);
    const bees = addMemory(db, alice.id, 'fact', 'Alice keeps bees.');
    db.prepare("UPDATE memories SET embedding = x'00', updated_at = '2026-11-20 10:00:00' WHERE id = ?").run(trip.id);
    const prompts: ChatMessage[][] = [];
    const json: JsonFn = async (messages) => {
      prompts.push(messages);
      return answer(messages);
    };
    return { db, alice, bob, trip, visit, bees, json, prompts };
  }
  const memory = (db: DB, id: number) =>
    db.prepare('SELECT content, until, embedding, updated_at FROM memories WHERE id = ?').get(id) as {
      content: string;
      until: string | null;
      embedding: Buffer | null;
      updated_at: string;
    };

  it('is rewritten once as something that happened, and becomes an ordinary memory', async () => {
    const { db, trip, visit, bees, json, prompts } = await ended(() => 'Alice went on a cruise in November 2026; her favourite spot aboard was the piano bar.');
    expect(await rewriteEnded(db, json, TODAY)).toBe(1);
    const after = memory(db, trip.id);
    expect(after).toMatchObject({ content: 'Alice went on a cruise in November 2026; her favourite spot aboard was the piano bar.', until: null, embedding: null });
    expect(after.updated_at > '2026-11-20 10:00:00').toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]![0]!.content).toContain('a chat companion keeps about Alice');
    expect(prompts[0]![0]!.content).toContain('it lasted until 2026-11-24');
    expect(prompts[0]![0]!.content).toContain('"in November 2026"');
    expect(prompts[0]![1]!.content).toBe('MEMORY: Alice is on a cruise; her favourite spot aboard is the piano bar.');
    // Still running through today, and lasting memories, are left alone.
    expect(memory(db, visit.id).until).toBe(TODAY);
    expect(memory(db, bees.id).content).toBe('Alice keeps bees.');
    expect(await rewriteEnded(db, json, TODAY)).toBe(0);
    expect(prompts).toHaveLength(1);
  });

  for (const [what, answer] of [
    ['an empty answer', () => ''],
    ['the same words', () => 'Alice is on a cruise; her favourite spot aboard is the piano bar.'],
    ['no closing punctuation', () => 'Alice went on a cruise in November 2026'],
    ['an essay', () => `${'Alice went on a cruise. '.repeat(30)}`],
    ['a model failure', () => Promise.reject(new Error('model down'))],
  ] as const) {
    it(`stays as written, no longer for now, after ${what}`, async () => {
      const { db, trip, json } = await ended(answer);
      expect(await rewriteEnded(db, json, TODAY)).toBe(0);
      expect(memory(db, trip.id)).toMatchObject({ content: 'Alice is on a cruise; her favourite spot aboard is the piano bar.', until: null });
      expect(memory(db, trip.id).updated_at).toBe('2026-11-20 10:00:00');
    });
  }

  it('tidies quotes and a repeated label off the answer', async () => {
    const { db, trip, json } = await ended(() => '  MEMORY: "Alice went on a cruise in November 2026."\n');
    await rewriteEnded(db, json, TODAY);
    expect(memory(db, trip.id).content).toBe('Alice went on a cruise in November 2026.');
  });

  it('writes nothing when a reply preempts it, so it is tried again', async () => {
    const { db, trip, json } = await ended(() => Promise.reject(new PreemptedError()));
    await expect(rewriteEnded(db, json, TODAY)).rejects.toBeInstanceOf(PreemptedError);
    expect(memory(db, trip.id).until).toBe('2026-11-24');
  });

  it("leaves it alone if the user moved its end date while it was being rewritten", async () => {
    let db!: DB;
    let id = 0;
    const ctx = await ended(() => {
      db.prepare("UPDATE memories SET until = '2026-12-01' WHERE id = ?").run(id);
      return 'Alice went on a cruise in November 2026.';
    });
    db = ctx.db;
    id = ctx.trip.id;
    expect(await rewriteEnded(db, ctx.json, TODAY)).toBe(0);
    expect(memory(db, id)).toMatchObject({ content: 'Alice is on a cruise; her favourite spot aboard is the piano bar.', until: '2026-12-01' });
  });

  it("rewrites every user's, a few per pass", async () => {
    const { db, alice, bob, json } = await ended(() => 'It happened in November 2026.');
    for (let i = 0; i < 5; i++) addMemory(db, i % 2 ? bob.id : alice.id, 'fact', `Plan ${i} is on.`, null, 'user', '2026-11-20');
    expect(await rewriteEnded(db, json, TODAY)).toBe(5);
    expect(await rewriteEnded(db, json, TODAY)).toBe(1);
    const left = db.prepare("SELECT count(*) AS n FROM memories WHERE until IS NOT NULL AND until < ?").get(TODAY) as { n: number };
    expect(left.n).toBe(0);
    expect(rows(db, bob.id).every((m) => m.content === 'It happened in November 2026.')).toBe(true);
  });

  it('happens in the memory sweep, before any chat is read, and a preemption ends the pass', async () => {
    const { db, alice, trip, visit } = await ended(() => '');
    chatWith(db, alice.id, [['user', 'I keep bees.']]);
    // The sweep goes by the real date (in CI's time zone too), so these are relative to it.
    db.prepare('UPDATE memories SET until = ? WHERE id = ?').run(addDays(localDay(), -1), trip.id);
    db.prepare('UPDATE memories SET until = ? WHERE id = ?').run(addDays(localDay(), 3), visit.id);
    const calls: string[] = [];
    const preempting: JsonFn = async (messages) => {
      calls.push(messages[0]!.content.slice(0, 20));
      throw new PreemptedError();
    };
    await createSweep(db, preempting, fakeEmbed, 0)();
    expect(calls).toEqual(['You rewrite one memo']);
    const done: JsonFn = async (messages, schema) => {
      calls.push(messages[0]!.content.slice(0, 20));
      if (schema === EXTRACTION_SCHEMA) return { add: [], update: [] };
      if (schema === null) return 'Alice went on a cruise in November 2026.';
      return { facts: [] };
    };
    await createSweep(db, done, fakeEmbed, 0)();
    expect(memory(db, trip.id)).toMatchObject({ content: 'Alice went on a cruise in November 2026.', until: null });
    expect(calls.slice(1, 3)).toEqual(['You rewrite one memo', 'You maintain the lon']);
  });
});

describe('for-now memories over the API', () => {
  async function signedIn() {
    const ctx = setupApp();
    await createUser(ctx.db, 'alice', 'a good password');
    await createUser(ctx.db, 'bob', 'a good password');
    const cookie = async (u: string) => sessionCookie(await login(ctx.app, u, 'a good password'));
    return { ...ctx, alice: await cookie('alice'), bob: await cookie('bob') };
  }
  const call = (app: ReturnType<typeof setupApp>['app'], cookie: string, method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const today = localDay();

  it('adds one for now, with a date from today to a year ahead', async () => {
    const ctx = await signedIn();
    const post = (body: object) => call(ctx.app, ctx.alice, 'POST', '/memories', { kind: 'fact', content: 'On a cruise.', ...body });
    const ok = await post({ until: addDays(today, 7) });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ content: 'On a cruise.', until: addDays(today, 7) });
    expect(await (await post({ until: today })).json()).toMatchObject({ until: today });
    expect(await (await post({ until: null })).json()).toMatchObject({ until: null });
    expect(await (await post({})).json()).toMatchObject({ until: null });
    for (const until of [addDays(today, -1), addDays(today, 366), '2026-02-30', 'Sunday', 7])
      expect((await post({ until })).status).toBe(400);
    expect((await post({ kind: 'profile', until: addDays(today, 7) })).status).toBe(400);
    expect((await post({ subject: 'assistant', until: addDays(today, 7) })).status).toBe(400);
  });

  it('moves, clears and ends the date, only on the owner’s facts about themselves', async () => {
    const ctx = await signedIn();
    const create = async () =>
      ((await (await call(ctx.app, ctx.alice, 'POST', '/memories', { kind: 'fact', content: 'On a cruise.', until: addDays(today, 7) })).json()) as { id: number }).id;
    const patch = (id: number, body: object, who = ctx.alice) => call(ctx.app, who, 'PATCH', `/memories/${id}`, body);
    const id = await create();

    expect(await (await patch(id, { until: addDays(today, 3) })).json()).toMatchObject({ until: addDays(today, 3) });
    expect(await (await patch(id, { content: 'On a long cruise.' })).json()).toMatchObject({ content: 'On a long cruise.', until: addDays(today, 3) });
    expect((await patch(id, { until: addDays(today, -1) })).status).toBe(400);
    expect(await (await patch(id, { until: null })).json()).toMatchObject({ until: null });

    // Bob can't touch it.
    expect((await patch(id, { until: addDays(today, 2) }, ctx.bob)).status).toBe(404);

    // Promoting it, or filing it under the assistant, ends "for now".
    await patch(id, { until: addDays(today, 3) });
    expect(await (await patch(id, { kind: 'profile' })).json()).toMatchObject({ kind: 'profile', until: null });
    expect((await patch(id, { until: addDays(today, 3) })).status).toBe(400);
    expect((await patch(id, { kind: 'fact', until: addDays(today, 3) })).status).toBe(200);
    expect(await (await patch(id, { subject: 'assistant' })).json()).toMatchObject({ subject: 'assistant', until: null });
    expect((await patch(id, { kind: 'profile', subject: 'user', until: addDays(today, 3) })).status).toBe(400);

    const second = await create();
    expect((await patch(second, { subject: 'assistant', until: addDays(today, 3) })).status).toBe(400);
    const listed = (await (await call(ctx.app, ctx.alice, 'GET', '/memories')).json()) as { id: number; until: string | null }[];
    expect(listed.find((m) => m.id === second)!.until).toBe(addDays(today, 7));
  });

  it('ends when promoted from the admin console too', async () => {
    const { db, alice } = await seed();
    const m = addMemory(db, alice.id, 'fact', 'On a cruise.', null, 'user', '2026-11-29');
    updateMemoryKind(db, m.id, 'fact');
    expect(rows(db, alice.id)[0]!.until).toBe('2026-11-29');
    updateMemoryKind(db, m.id, 'profile');
    expect(rows(db, alice.id)[0]!.until).toBeNull();
  });
});
