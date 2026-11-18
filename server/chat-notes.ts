// The model's private notes for one chat: what it has to remember there but not say. A story's plan
// and culprit, a quiz's answer key, a game's secret, a checklist. It writes them with the save_notes
// tool, mid-reply, and they ride on the newest message of every later prompt (like recalled
// memories, so an update never changes the start of the prompt that Ollama caches).
//
// Measured before building (2026-11-17, chat 63's mystery brief, 8 chapters, x2 per condition on
// paris and on the Mac): without a plan the stories wandered (3-5 characters added as they went,
// the premise redefined 2-4 times, no culprit by chapter 8); with the brief asking for a plan in the
// notes, the model saved one before chapter 1 (culprit, five characters, a clue per chapter) and kept
// to it: no character outside the plan, the planned clues in their planned chapters. Offered the tool
// without being asked to plan, it almost never used it (0 of 4 runs on paris).
//
// The owner never wants to see them in the app: no web route returns them, only bin/hearth does.
import type { DB } from './db.ts';
import type { ChatMessage, ToolCall } from './ollama.ts';

/** Room for a ten-chapter plan: one hit the 2,000 the probe allowed and was cut off. */
export const MAX_NOTES_CHARS = 3000;

export const SAVE_NOTES_TOOL = {
  type: 'function',
  function: {
    name: 'save_notes',
    description:
      'Save your private notes for this chat, replacing the old ones. Only you can see them; the user never does. ' +
      `Up to about ${MAX_NOTES_CHARS} characters.`,
    parameters: {
      type: 'object',
      properties: { notes: { type: 'string', description: 'The full notes, replacing the previous ones.' } },
      required: ['notes'],
    },
  },
};

/** Appended to the system prompt whenever the tool is offered, so it stays the same between turns. */
export const NOTES_INSTRUCTIONS = `## Your notes for this chat

You have private notes for this chat that only you can see; they are shown to you with the newest message. Call save_notes to write them (it replaces the old notes). Use them for what you must remember here but not say: a plan, a secret, an answer key, a checklist. Write them before you rely on them: for a story or a game, decide the plan or the secret first and save it, then keep to it, and update the notes when something changes. Don't quote them or give away what's in them unless you're asked.`;

/** The notes as the model reads them on the newest message, or '' for none. */
export const notesForPrompt = (notes: string): string =>
  notes ? `[Your notes for this chat; only you can see them]\n${notes}` : '';

/**
 * Whether the reply this prompt is for has already saved notes: a save_notes answer after the last user
 * message. True when a reply resumes after a search card, so the saved-notes line isn't lost.
 */
export function savedInTurn(prompt: ChatMessage[]): boolean {
  const lastUser = prompt.findLastIndex((m) => m.role === 'user');
  return prompt.slice(lastUser + 1).some((m) => m.role === 'tool' && m.tool_name === 'save_notes');
}

/** The notes a save_notes call carries, clipped to the cap; undefined for any other call. */
export function notesFromCall(call: ToolCall): string | undefined {
  if (call.function.name !== 'save_notes') return undefined;
  const notes = call.function.arguments?.notes;
  return typeof notes === 'string' ? notes.trim().slice(0, MAX_NOTES_CHARS) : undefined;
}

/** A chat's notes, only for the user who owns the chat ('' for none). */
export function getNotes(db: DB, userId: number, conversationId: number): string {
  const row = db
    .prepare(
      `SELECT n.content FROM chat_notes n JOIN conversations c ON c.id = n.conversation_id
       WHERE n.conversation_id = ? AND c.user_id = ?`,
    )
    .get(conversationId, userId) as { content: string } | undefined;
  return row?.content ?? '';
}

/** Replaces a chat's notes; false when the chat isn't the user's (or is gone). */
export function saveNotes(db: DB, userId: number, conversationId: number, content: string): boolean {
  const owned = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!owned) return false;
  db.prepare(
    `INSERT INTO chat_notes (conversation_id, content) VALUES (?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
  ).run(conversationId, content);
  return true;
}

const PRIVATE_NOTES_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_PRIVATE_NOTES = 500;

/**
 * A private chat's notes, in server memory only (private chats write nothing): lost on restart, when
 * the chat ends, or after 12 idle hours. Keys are per user (`private:<user>:<id>`).
 */
export class PrivateNotes {
  #notes = new Map<string, { content: string; at: number }>();
  #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  get(key: string): string {
    this.#expire();
    const entry = this.#notes.get(key);
    if (!entry) return '';
    entry.at = this.#now().getTime();
    return entry.content;
  }

  set(key: string, content: string) {
    this.#expire();
    this.#notes.delete(key);
    this.#notes.set(key, { content, at: this.#now().getTime() });
    for (const k of this.#notes.keys()) {
      if (this.#notes.size <= MAX_PRIVATE_NOTES) break;
      this.#notes.delete(k);
    }
  }

  forget(key: string) {
    this.#notes.delete(key);
  }

  #expire() {
    const cutoff = this.#now().getTime() - PRIVATE_NOTES_IDLE_MS;
    for (const [k, v] of this.#notes) if (v.at < cutoff) this.#notes.delete(k);
  }
}
