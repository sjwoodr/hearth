import { describe, expect, it } from 'vitest';
import { PreemptedError } from './busy.ts';
import type { DB } from './db.ts';
import type { ChatMessage, JsonFn } from './ollama.ts';
import { chatsToRetitle, createRetitleSweep, RETITLE_AFTER, sampleLines } from './retitle.ts';
import { setupApp } from './testing.ts';
import { createUser } from './users.ts';

async function seed() {
  const ctx = setupApp();
  const alice = await createUser(ctx.db, 'alice', 'a good password');
  return { db: ctx.db, alice };
}

function chatWith(db: DB, userId: number, title: string, said: string[], minutesAgo = 10): number {
  const id = Number(db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)').run(userId, title).lastInsertRowid);
  for (const content of said) addTurn(db, id, content, minutesAgo);
  return id;
}

function addTurn(db: DB, id: number, content: string, minutesAgo = 10) {
  const add = db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', ?))`);
  add.run(id, 'user', content, `-${minutesAgo} minutes`);
  add.run(id, 'assistant', `About ${content}.`, `-${minutesAgo} minutes`);
}

const titleOf = (db: DB, id: number) => (db.prepare('SELECT title FROM conversations WHERE id = ?').get(id) as { title: string }).title;

/** Answers the fit check with `fits` and the title request with `title`; records every call. */
function fakeModel(fits: boolean, title = 'Raised Garden Beds') {
  const calls: { messages: ChatMessage[]; schema: unknown }[] = [];
  const json: JsonFn = async (messages, schema) => {
    calls.push({ messages, schema });
    return schema ? { fits } : title;
  };
  return { json, calls };
}

describe('retitling chats that moved on', () => {
  it('picks quiet, auto-titled chats with enough new messages, never renamed ones', async () => {
    const { db, alice } = await seed();
    const ready = chatWith(db, alice.id, 'Greeting', ['hi', 'a raised bed']);
    chatWith(db, alice.id, 'Short', ['hi']); // too few messages
    chatWith(db, alice.id, 'Busy', ['hi', 'still talking'], 1); // not quiet yet
    const renamed = chatWith(db, alice.id, 'Mine', ['hi', 'a raised bed']);
    db.prepare('UPDATE conversations SET title_is_auto = 0 WHERE id = ?').run(renamed);
    expect(RETITLE_AFTER).toBe(4);
    expect(chatsToRetitle(db, 5)).toEqual([ready]);
  });

  it('asks whether the title fits, writes a new one only when it does not, and checks again only after more messages', async () => {
    const { db, alice } = await seed();
    const id = chatWith(db, alice.id, 'Greeting', ['hi', 'I want a raised garden bed', 'how deep should it be']);
    const model = fakeModel(false);
    await createRetitleSweep(db, model.json, 5)();
    expect(titleOf(db, id)).toBe('Raised Garden Beds');
    // The fit check, then the title; both read the user's side only, oldest first.
    expect(model.calls.map((c) => !!c.schema)).toEqual([true, false]);
    expect(model.calls[0]!.messages[1]!.content).toBe(
      "TITLE: Greeting\n\nThe user's messages, oldest first:\n- hi\n- I want a raised garden bed\n- how deep should it be",
    );
    expect(model.calls[0]!.messages[1]!.content).not.toContain('About');

    // Checked through the newest message: not again until RETITLE_AFTER more.
    expect(chatsToRetitle(db, 5)).toEqual([]);
    addTurn(db, id, 'what soil');
    expect(chatsToRetitle(db, 5)).toEqual([]);
    addTurn(db, id, 'how many boards');
    expect(chatsToRetitle(db, 5)).toEqual([id]);
  });

  it('keeps a title that fits, with one call', async () => {
    const { db, alice } = await seed();
    const id = chatWith(db, alice.id, 'Cron Job Setup', ['run a script nightly', 'full path?']);
    const model = fakeModel(true);
    await createRetitleSweep(db, model.json, 5)();
    expect(titleOf(db, id)).toBe('Cron Job Setup');
    expect(model.calls).toHaveLength(1);
    expect(chatsToRetitle(db, 5)).toEqual([]);
  });

  it('leaves a chat the user renamed while the check ran', async () => {
    const { db, alice } = await seed();
    const id = chatWith(db, alice.id, 'Greeting', ['hi', 'a raised bed']);
    const json: JsonFn = async (_messages, schema) => {
      if (schema) {
        db.prepare("UPDATE conversations SET title = 'My garden', title_is_auto = 0 WHERE id = ?").run(id);
        return { fits: false };
      }
      return 'Raised Garden Beds';
    };
    await createRetitleSweep(db, json, 5)();
    expect(titleOf(db, id)).toBe('My garden');
  });

  it('writes nothing when preempted, so the chat is checked again', async () => {
    const { db, alice } = await seed();
    const id = chatWith(db, alice.id, 'Greeting', ['hi', 'a raised bed']);
    await createRetitleSweep(db, async () => {
      throw new PreemptedError();
    }, 5)();
    expect(titleOf(db, id)).toBe('Greeting');
    expect(chatsToRetitle(db, 5)).toEqual([id]);
  });

  it('samples a long chat evenly and shortens long messages', () => {
    const lines = sampleLines(Array.from({ length: 300 }, (_, i) => `message ${i}`));
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe('message 0');
    expect(lines[50]).toBe('message 150');
    expect(lines.at(-1)).toBe('message 297');
    expect(sampleLines(['x'.repeat(500)])[0]).toBe(`${'x'.repeat(200)}…`);
    expect(sampleLines(['one\n\ntwo'])).toEqual(['one two']);
  });
});
