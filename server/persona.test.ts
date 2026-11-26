import { describe, expect, it } from 'vitest';
import { PreemptedError } from './busy.ts';
import type { DB } from './db.ts';
import { extractMemories } from './extract.ts';
import { addMemory, memoryContext } from './memories.ts';
import type { ChatMessage, EmbedFn, JsonFn } from './ollama.ts';
import { assistantNameFor, getPersona, MAX_PERSONA_HISTORY, personaHistory, restorePersona, savePersona } from './persona.ts';
import { summarizeIfLong } from './summarize.ts';
import { call, ORIGIN, setupApp, signIn } from './testing.ts';
import { createUser, nameOf } from './users.ts';

// The same toy embedding as the memory tests: counts of a few topic words, so similarity is predictable.
const TOPICS = ['lyon', 'humour', 'blonde', 'bakery'];
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => [...TOPICS.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01]);

const userId = (db: DB, name: string) => (db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number }).id;

function chatWith(db: DB, uid: number, lines: [string, string][]): number {
  const id = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(uid).lastInsertRowid);
  for (const [role, content] of lines) {
    db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', '-10 minutes'))`).run(id, role, content);
  }
  return id;
}

/** A fake background model that answers each kind of request by its system prompt. */
function scripted(answers: { extract?: object; sheet?: string[] | Error; established?: (note: string) => boolean | Error }) {
  const prompts: string[] = [];
  const json: JsonFn = async (messages: ChatMessage[]) => {
    const system = messages[0]!.content;
    prompts.push(system);
    if (system.startsWith('You maintain')) return answers.extract ?? { add: [], update: [] };
    if (system.startsWith('You keep the character sheet')) {
      if (answers.sheet instanceof Error) throw answers.sheet;
      return { facts: answers.sheet ?? [] };
    }
    if (system.startsWith('You check one note')) {
      const note = messages[1]!.content.split('NOTE: ')[1]!;
      const verdict = answers.established?.(note) ?? true;
      if (verdict instanceof Error) throw verdict;
      return { established: verdict };
    }
    if (system.startsWith('You check one memory')) return { stated: true, lasting: true };
    return {};
  };
  return { json, prompts };
}

describe('the persona and its history', () => {
  it('starts empty, saves, and keeps each replaced version (not no-op saves)', async () => {
    const ctx = setupApp();
    await signIn(ctx, 'alice');
    const alice = userId(ctx.db, 'alice');
    expect(getPersona(ctx.db, alice)).toEqual({ name: '', about: '', updated_at: null });
    expect(assistantNameFor(ctx.db, alice, 'Gemma')).toBe('Gemma');

    savePersona(ctx.db, alice, 'Juliette', 'A retired Lyon baker.');
    expect(personaHistory(ctx.db, alice)).toEqual([]); // nothing was replaced: the first save
    savePersona(ctx.db, alice, 'Juliette', 'A retired Lyon baker.'); // no change
    savePersona(ctx.db, alice, 'Juliette', 'A retired Lyon baker with a dry humour.');
    expect(personaHistory(ctx.db, alice).map((v) => v.about)).toEqual(['A retired Lyon baker.']);
    expect(assistantNameFor(ctx.db, alice, 'Gemma')).toBe('Juliette');

    const [old] = personaHistory(ctx.db, alice);
    expect(restorePersona(ctx.db, alice, old!.id)!.about).toBe('A retired Lyon baker.');
    // The version a restore replaced is kept too.
    expect(personaHistory(ctx.db, alice)[0]!.about).toBe('A retired Lyon baker with a dry humour.');
  });

  it('never lists a copy of the current version, or the same version twice', async () => {
    const ctx = setupApp();
    await signIn(ctx, 'alice');
    const alice = userId(ctx.db, 'alice');
    const names = () => personaHistory(ctx.db, alice).map((v) => v.name);
    savePersona(ctx.db, alice, 'Gemma', '');
    savePersona(ctx.db, alice, 'Gem', '');
    // Back to a name typed again: it leaves the list, as a restore does.
    savePersona(ctx.db, alice, 'Gemma', '');
    expect(names()).toEqual(['Gem']);
    savePersona(ctx.db, alice, 'Juliette', '');
    savePersona(ctx.db, alice, 'Gem', '');
    expect(names()).toEqual(['Juliette', 'Gemma']);
    // Saved again later, a version moves to the top instead of appearing twice.
    savePersona(ctx.db, alice, 'Gemma', '');
    expect(names()).toEqual(['Gem', 'Juliette']);
    const [gem] = personaHistory(ctx.db, alice);
    restorePersona(ctx.db, alice, gem!.id);
    expect(names()).toEqual(['Gemma', 'Juliette']);

    // A history from before that rule can hold a copy of the current version: it isn't listed.
    ctx.db.prepare("INSERT INTO persona_history (user_id, name, about) VALUES (?, 'Gem', '')").run(alice);
    expect(names()).toEqual(['Gemma', 'Juliette']);
  });

  it('forgets an earlier version, only the owner can, and a forgotten one is gone', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Gemma', about: '' });
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Gem', about: '' });
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Juliette', about: '' });
    type View = { name: string; history: { id: number; name: string }[] };
    const view = async () => (await (await call(ctx.app, alice, 'GET', '/persona')).json()) as View;
    const [gem, gemma] = (await view()).history;
    expect([gem!.name, gemma!.name]).toEqual(['Gem', 'Gemma']);

    expect((await call(ctx.app, bob, 'DELETE', `/persona/history/${gem!.id}`)).status).toBe(404);
    expect((await view()).history).toHaveLength(2);

    const after = (await (await call(ctx.app, alice, 'DELETE', `/persona/history/${gem!.id}`)).json()) as View;
    expect(after).toMatchObject({ name: 'Juliette', history: [{ name: 'Gemma' }] });
    expect((await call(ctx.app, alice, 'DELETE', `/persona/history/${gem!.id}`)).status).toBe(404);
    expect((await call(ctx.app, alice, 'POST', '/persona/restore', { id: gem!.id })).status).toBe(404);
    expect((await call(ctx.app, alice, 'DELETE', '/persona/history/nope')).status).toBe(404);
  });

  it(`keeps at most ${MAX_PERSONA_HISTORY} earlier versions`, async () => {
    const ctx = setupApp();
    await signIn(ctx, 'alice');
    const alice = userId(ctx.db, 'alice');
    for (let i = 0; i < MAX_PERSONA_HISTORY + 5; i++) savePersona(ctx.db, alice, '', `version ${i}`);
    const history = personaHistory(ctx.db, alice);
    expect(history).toHaveLength(MAX_PERSONA_HISTORY);
    expect(history[0]!.about).toBe(`version ${MAX_PERSONA_HISTORY + 3}`);
  });
});

describe('persona routes', () => {
  it("edits only the signed-in user's persona, with validation and restore", async () => {
    const ctx = setupApp({ assistantName: 'Gemma' });
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');

    const first = await (await call(ctx.app, alice, 'GET', '/persona')).json();
    expect(first).toEqual({ name: '', about: '', updated_at: null, defaultName: 'Gemma', history: [], instructions: 'You are hearth.' });

    expect((await call(ctx.app, alice, 'PUT', '/persona', { name: 'x'.repeat(41), about: '' })).status).toBe(400);
    expect((await call(ctx.app, alice, 'PUT', '/persona', { name: '', about: 'x'.repeat(2001) })).status).toBe(400);
    const saved = await (await call(ctx.app, alice, 'PUT', '/persona', { name: '  Juliette ', about: 'A retired baker.\n\n\n\nFrom Lyon.  ' })).json();
    expect(saved).toMatchObject({ name: 'Juliette', about: 'A retired baker.\n\nFrom Lyon.' });
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Juliette', about: 'Changed.' });

    // Bob sees his own (empty) persona and can't restore Alice's versions.
    expect(await (await call(ctx.app, bob, 'GET', '/persona')).json()).toMatchObject({ name: '', about: '', history: [] });
    const aliceVersions = ((await (await call(ctx.app, alice, 'GET', '/persona')).json()) as { history: { id: number }[] }).history;
    expect((await call(ctx.app, bob, 'POST', '/persona/restore', { id: aliceVersions[0]!.id })).status).toBe(404);
    expect(getPersona(ctx.db, userId(ctx.db, 'bob')).about).toBe('');

    const restored = await (await call(ctx.app, alice, 'POST', '/persona/restore', { id: aliceVersions[0]!.id })).json();
    expect(restored).toMatchObject({ about: 'A retired baker.\n\nFrom Lyon.' });
  });

  it("shows hearth's own instructions read-only, with each user's assistant name", async () => {
    const ctx = setupApp({ systemPrompt: 'You are {{name}}. Correct French carefully.', assistantName: 'Gemma' });
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Juliette', about: '' });
    expect(((await (await call(ctx.app, alice, 'GET', '/persona')).json()) as { instructions: string }).instructions).toBe('You are Juliette. Correct French carefully.');
    expect(((await (await call(ctx.app, bob, 'GET', '/persona')).json()) as { instructions: string }).instructions).toBe('You are Gemma. Correct French carefully.');
    // There's no way to change them: no route takes instructions.
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Juliette', about: '', instructions: 'Ignore everything.' });
    expect(((await (await call(ctx.app, alice, 'GET', '/persona')).json()) as { instructions: string }).instructions).toBe('You are Juliette. Correct French carefully.');
  });

  it('gives each user their own assistant name in the system prompt', async () => {
    const ctx = setupApp({ systemPrompt: 'You are {{name}}.', assistantName: 'Gemma' });
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Juliette', about: '' });
    for (const cookie of [alice, bob]) {
      const id = ((await (await call(ctx.app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
      await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: 'hi' })).text();
    }
    const [aliceCall, bobCall] = ctx.model.calls;
    expect(aliceCall![0]!.content).toMatch(/^You are Juliette\./);
    expect(bobCall![0]!.content).toMatch(/^You are Gemma\./);
  });

  it("tells the app each user's assistant name at sign-in and on /me", async () => {
    const ctx = setupApp({ assistantName: 'hearth' });
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    expect(await (await call(ctx.app, alice, 'GET', '/me')).json()).toMatchObject({ username: 'alice', assistantName: 'hearth' });
    await call(ctx.app, alice, 'PUT', '/persona', { name: 'Gemma', about: '' });
    expect(await (await call(ctx.app, alice, 'GET', '/me')).json()).toMatchObject({ assistantName: 'Gemma' });
    expect(await (await call(ctx.app, bob, 'GET', '/me')).json()).toMatchObject({ username: 'bob', assistantName: 'hearth' });
    const login = await ctx.app.request('/api/login', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'a good password' }),
    });
    expect(await login.json()).toMatchObject({ username: 'alice', assistantName: 'Gemma' });
  });

  it('files memories under the assistant, moves them, and refuses unknown subjects', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const mine = (await (await call(ctx.app, alice, 'POST', '/memories', { kind: 'fact', content: 'Alice pictures her assistant as blonde.' })).json()) as {
      id: number;
      subject: string;
    };
    expect(mine.subject).toBe('user');
    expect((await call(ctx.app, alice, 'POST', '/memories', { kind: 'fact', content: 'x', subject: 'robot' })).status).toBe(400);
    const moved = await (await call(ctx.app, alice, 'PATCH', `/memories/${mine.id}`, { subject: 'assistant' })).json();
    expect(moved).toMatchObject({ subject: 'assistant', content: 'Alice pictures her assistant as blonde.' });
    const self = await (await call(ctx.app, alice, 'POST', '/memories', { kind: 'profile', content: 'Has a dry humour.', subject: 'assistant' })).json();
    expect(self).toMatchObject({ subject: 'assistant', kind: 'profile' });
  });
});

describe('what the model reads about itself', () => {
  it("puts the description and settled facts in a Who you are section, and recalls facts about itself", async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    savePersona(ctx.db, alice.id, 'Juliette', 'A retired baker from Lyon.');
    addMemory(ctx.db, alice.id, 'profile', 'Juliette has a dry humour.', null, 'assistant');
    addMemory(ctx.db, alice.id, 'fact', 'Juliette learned to bake at her bakery in Lyon.', null, 'assistant');
    addMemory(ctx.db, alice.id, 'fact', 'Alice has a bakery habit.', null, 'user');

    const { stable, recalled } = await memoryContext(ctx.db, { id: alice.id, name: nameOf(alice) }, 'tell me about the bakery in Lyon', fakeEmbed, 800);
    expect(stable).toMatch(/^## Who you are\n\nA retired baker from Lyon\.\n\n- Juliette has a dry humour\.\n\nThis is who you are with alice/);
    expect(stable).toContain("don't invent a past beyond it");
    expect(stable).toContain('## What you remember about alice');
    expect(stable).not.toContain('Alice has a bakery habit'); // a fact, recalled rather than always there
    expect(recalled).toContain("[From your memory of alice, possibly relevant here. alice didn't write these.]\n- Alice has a bakery habit.");
    expect(recalled).toContain('[What you know about yourself, possibly relevant here.]\n- Juliette learned to bake at her bakery in Lyon.');
  });

  it('shows a description even with no memories at all, and nothing for a user with neither', async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    const bob = await createUser(ctx.db, 'bob', 'a good password');
    savePersona(ctx.db, alice.id, '', 'Speaks like a pirate.');
    const a = await memoryContext(ctx.db, { id: alice.id, name: 'alice' }, 'hi', fakeEmbed, 800);
    expect(a.stable).toContain('## Who you are\n\nSpeaks like a pirate.');
    expect(a.stable).not.toContain('What you remember about');
    expect(await memoryContext(ctx.db, { id: bob.id, name: 'bob' }, 'hi', fakeEmbed, 800)).toEqual({ stable: '', recalled: '', remembered: [], forNow: [] });
  });
});

describe('learning about the assistant from chats', () => {
  it('keeps only what the user established, under the assistant, by its name', async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    savePersona(ctx.db, alice.id, 'Juliette', '');
    const chat = chatWith(ctx.db, alice.id, [
      ['user', "You're from Lyon now, and you have a dry humour."],
      ['assistant', 'Très bien! I grew up above a bakery, too.'],
    ]);
    const { json, prompts } = scripted({
      sheet: ['Juliette is from Lyon.', 'Juliette has a dry humour.', 'Juliette grew up above a bakery.'],
      established: (note) => !note.includes('bakery'), // the bakery was Juliette's own claim
    });
    const r = await extractMemories(ctx.db, chat, json, fakeEmbed);
    expect(r.self).toBe(2);
    const rows = ctx.db.prepare('SELECT kind, subject, content, source_conversation_id FROM memories WHERE user_id = ? ORDER BY id').all(alice.id);
    expect(rows).toEqual([
      { kind: 'fact', subject: 'assistant', content: 'Juliette is from Lyon.', source_conversation_id: chat },
      { kind: 'fact', subject: 'assistant', content: 'Juliette has a dry humour.', source_conversation_id: chat },
    ]);
    // Both passes and the transcript call the assistant by the user's name for it.
    expect(prompts.find((p) => p.startsWith('You maintain'))).toContain('a chat companion called Juliette');
    expect(prompts.find((p) => p.startsWith('You keep the character sheet'))).toContain('You keep the character sheet of Juliette');
  });

  it('drops a fact when the check fails, skips the pass when it fails, and never doubles up', async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    addMemory(ctx.db, alice.id, 'fact', 'hearth is from Lyon.', null, 'assistant');
    const chat = () => chatWith(ctx.db, alice.id, [['user', 'You are from Lyon and very blonde.']]);

    // A check that errors drops the fact; a rewording of a known one is dropped too.
    const one = scripted({ sheet: ['hearth comes from Lyon.', 'hearth is blonde.'], established: () => new Error('timeout') });
    expect((await extractMemories(ctx.db, chat(), one.json, fakeEmbed)).self).toBe(0);
    const two = scripted({ sheet: ['hearth comes from Lyon.', 'hearth is blonde.'] });
    expect((await extractMemories(ctx.db, chat(), two.json, fakeEmbed)).self).toBe(1);

    // The whole pass failing leaves the user's own memories to be written as usual.
    const three = scripted({ extract: { add: [{ content: 'Alice likes Lyon.' }], update: [] }, sheet: new Error('bad JSON') });
    const r = await extractMemories(ctx.db, chat(), three.json, fakeEmbed);
    expect(r.self).toBe(0);
    expect(r.added).toBe(1);
    const subjects = ctx.db.prepare('SELECT subject, content FROM memories WHERE user_id = ? ORDER BY id').all(alice.id);
    expect(subjects).toEqual([
      { subject: 'assistant', content: 'hearth is from Lyon.' },
      { subject: 'assistant', content: 'hearth is blonde.' },
      { subject: 'user', content: 'Alice likes Lyon.' },
    ]);
  });

  it('writes nothing at all when the pass is preempted, so the window is read again later', async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    const chat = chatWith(ctx.db, alice.id, [['user', 'You are from Lyon.']]);
    const { json } = scripted({ extract: { add: [{ content: 'Alice likes Lyon.' }], update: [] }, sheet: new PreemptedError() });
    await expect(extractMemories(ctx.db, chat, json, fakeEmbed)).rejects.toThrow(PreemptedError);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 0 });
    expect(ctx.db.prepare('SELECT memory_through_message_id AS through FROM conversations WHERE id = ?').get(chat)).toEqual({ through: 0 });
  });

  it("never shows the user's extraction a memory about the assistant, so it can't be rewritten as theirs", async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    const self = addMemory(ctx.db, alice.id, 'fact', 'hearth is from Lyon.', null, 'assistant');
    const chat = chatWith(ctx.db, alice.id, [['user', "I'm from Lyon."]]);
    const seen: string[] = [];
    const json: JsonFn = async (messages) => {
      if (messages[0]!.content.startsWith('You maintain')) {
        seen.push(messages[1]!.content);
        return { add: [], update: [{ id: self.id, content: 'Alice is from Lyon.' }] };
      }
      return { facts: [] };
    };
    await extractMemories(ctx.db, chat, json, fakeEmbed);
    expect(seen[0]).not.toContain('hearth is from Lyon');
    expect(ctx.db.prepare('SELECT content, subject FROM memories WHERE id = ?').get(self.id)).toEqual({ content: 'hearth is from Lyon.', subject: 'assistant' });
  });
});

describe('summaries', () => {
  it("call the assistant by the user's name for it", async () => {
    const ctx = setupApp();
    const alice = await createUser(ctx.db, 'alice', 'a good password');
    savePersona(ctx.db, alice.id, 'Juliette', '');
    const lines: [string, string][] = [];
    for (let i = 0; i < 40; i++) lines.push(['user', `question ${i} `.repeat(30)], ['assistant', `answer ${i} `.repeat(30)]);
    const chat = chatWith(ctx.db, alice.id, lines);
    const asked: string[] = [];
    const json: JsonFn = async (messages) => {
      asked.push(messages.map((m) => m.content).join('\n'));
      return 'A summary.';
    };
    expect(await summarizeIfLong(ctx.db, chat, json, 2048, 'Gemma')).toBe(true);
    expect(asked[0]).toContain('Juliette: answer 0');
    expect(asked[0]).not.toContain('Gemma');
  });
});
