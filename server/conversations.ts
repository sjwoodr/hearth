// Conversation and message queries for the web app. Every function takes the signed-in
// user's id and matches on it, so one user can never read or change another's chats.
import type { DB } from './db.ts';

export type Conversation = { id: number; title: string | null; created_at: string; updated_at: string };
export type Message = { id: number; role: 'user' | 'assistant'; content: string; created_at: string };

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

/** A rename by the user: hearth will never retitle this chat. */
export function renameConversation(db: DB, userId: number, id: number, title: string): boolean {
  return (
    db
      .prepare(
        "UPDATE conversations SET title = ?, title_is_auto = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      )
      .run(title, id, userId).changes > 0
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
  return db
    .prepare(
      `SELECT m.id, m.role, m.content, m.created_at FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = ? AND c.user_id = ? ORDER BY m.id`,
    )
    .all(conversationId, userId) as Message[];
}

/** Caller must already have checked the conversation belongs to the user. */
export function addMessage(db: DB, conversationId: number, role: Message['role'], content: string): number {
  return db.transaction(() => {
    const id = db
      .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(conversationId, role, content).lastInsertRowid;
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
    return Number(id);
  })();
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
