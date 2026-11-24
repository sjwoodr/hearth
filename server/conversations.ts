// Conversation and message queries for the web app. Every function takes the signed-in
// user's id and matches on it, so one user can never read or change another's chats.
import type { DB } from './db.ts';
import type { DrewOn, Source } from './web-search.ts';

export type Conversation = { id: number; title: string | null; created_at: string; updated_at: string };
/**
 * `image_count` images came with the message; `image_note` is the model's description of them, once
 * written. `sources`: the pages a reply drew on, when it followed a web search.
 */
export type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  image_count: number;
  image_note: string | null;
  sources: Source[] | null;
  /** The model saved its private notes while writing this reply (never what they say). */
  notes_saved: boolean;
  /** Started with "[no extraction]", or the reply to one: kept out of memories, summary, titles and search. */
  no_extraction: boolean;
  /** A reply's "Recalled" line: the first message of each earlier exchange it looked back on (lookback.ts). */
  recalled: number[];
  /** A reply's "Remembered" line: the memories recalled for it, as they read now (deleted ones left out). */
  remembered: DrewOn['remembered'];
  created_at: string;
};

export function listConversations(db: DB, userId: number): Conversation[] {
  return db
    .prepare(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
    )
    .all(userId) as Conversation[];
}

export function getConversation(db: DB, userId: number, id: number): Conversation | undefined {
  return db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?')
    .get(id, userId) as Conversation | undefined;
}

export function createConversation(db: DB, userId: number): Conversation {
  const id = db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid;
  return getConversation(db, userId, Number(id))!;
}

/**
 * A rename by the user. A title they wrote is theirs: hearth never retitles the chat. `auto` means
 * they kept hearth's suggestion as it was, which hands the title back to hearth: the retitler looks
 * at the chat again only after RETITLE_AFTER new messages (retitle.ts), as after one of its own checks.
 */
export function renameConversation(db: DB, userId: number, id: number, title: string, auto = false): boolean {
  return (
    db
      .prepare(
        `UPDATE conversations SET title = ?, title_is_auto = ?,
           title_checked_through_message_id = CASE WHEN ? THEN
             coalesce((SELECT max(id) FROM messages WHERE conversation_id = conversations.id), 0)
             ELSE title_checked_through_message_id END,
           updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      )
      .run(title, auto ? 1 : 0, auto ? 1 : 0, id, userId).changes > 0
  );
}

/** hearth's own title; does nothing once the user has renamed the chat. */
export function setAutoTitle(db: DB, id: number, title: string): boolean {
  return db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title_is_auto = 1').run(title, id).changes > 0;
}

export type ContextState = { summary: string | null; summary_through_message_id: number };

/** Caller must already have checked the conversation belongs to the user. */
export function getContextState(db: DB, conversationId: number): ContextState {
  return db
    .prepare('SELECT summary, summary_through_message_id FROM conversations WHERE id = ?')
    .get(conversationId) as ContextState;
}

export function deleteConversation(db: DB, userId: number, id: number): boolean {
  return db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function listMessages(db: DB, userId: number, conversationId: number): Message[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.role, m.content, m.image_count, m.image_note, m.sources, m.notes_saved, m.no_extraction,
         m.recalled, m.remembered, m.created_at FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = ? AND c.user_id = ? ORDER BY m.id`,
    )
    .all(conversationId, userId) as (Omit<Message, 'sources' | 'notes_saved' | 'no_extraction' | 'recalled' | 'remembered'> & {
    sources: string | null;
    notes_saved: number;
    no_extraction: number;
    recalled: string | null;
    remembered: string | null;
  })[];
  const ids = (json: string | null) => (json ? (JSON.parse(json) as number[]) : []);
  // The memories behind the "Remembered" lines, read now and only from this user's own.
  const wanted = [...new Set(rows.flatMap((m) => ids(m.remembered)))];
  const memories = new Map(
    wanted.length
      ? (
          db
            .prepare(`SELECT id, content FROM memories WHERE user_id = ? AND id IN (${wanted.map(() => '?').join(',')})`)
            .all(userId, ...wanted) as { id: number; content: string }[]
        ).map((r) => [r.id, r.content])
      : [],
  );
  return rows.map((m) => ({
    ...m,
    sources: m.sources ? (JSON.parse(m.sources) as Source[]) : null,
    notes_saved: m.notes_saved === 1,
    no_extraction: m.no_extraction === 1,
    recalled: ids(m.recalled),
    remembered: ids(m.remembered).flatMap((id) => (memories.has(id) ? [{ id, content: memories.get(id)! }] : [])),
  }));
}

/** Caller must already have checked the conversation belongs to the user. */
export function addMessage(
  db: DB,
  conversationId: number,
  role: Message['role'],
  content: string,
  extra: { imageCount?: number; sources?: Source[]; notesSaved?: boolean; noExtraction?: boolean; drewOn?: DrewOn } = {},
): number {
  const sources = extra.sources?.length ? JSON.stringify(extra.sources) : null;
  const recalled = extra.drewOn?.recalled.length ? JSON.stringify(extra.drewOn.recalled) : null;
  const remembered = extra.drewOn?.remembered.length ? JSON.stringify(extra.drewOn.remembered.map((m) => m.id)) : null;
  return db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, image_count, sources, notes_saved, no_extraction, recalled, remembered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversationId,
        role,
        content,
        extra.imageCount ?? 0,
        sources,
        extra.notesSaved ? 1 : 0,
        extra.noExtraction ? 1 : 0,
        recalled,
        remembered,
      ).lastInsertRowid;
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
    return Number(id);
  })();
}

/** Whether a message was kept out of extraction ("[no extraction]"). Caller must have checked the chat is the user's. */
export function isNoExtraction(db: DB, messageId: number): boolean {
  const row = db.prepare('SELECT no_extraction FROM messages WHERE id = ?').get(messageId) as { no_extraction: number } | undefined;
  return row?.no_extraction === 1;
}

/** The model's description of a message's images. Only the server's own background job calls this. */
export function setImageNote(db: DB, messageId: number, note: string): boolean {
  return db.prepare('UPDATE messages SET image_note = ? WHERE id = ? AND image_count > 0').run(note, messageId).changes > 0;
}

/** Caller must already have checked the conversation belongs to the user. */
export function deleteMessage(db: DB, conversationId: number, messageId: number): boolean {
  return db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(messageId, conversationId).changes > 0;
}

// The placeholder title until the model writes one after the first reply.
export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine;
}
