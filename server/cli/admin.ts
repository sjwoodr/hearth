// Cross-user queries for the admin CLI only. They deliberately take no user scope, so they
// live here rather than in the server modules the web app imports.
import fs from 'node:fs';
import type { DB } from '../db.ts';
import { localTime } from './io.ts';

export type ConversationRow = {
  id: number;
  username: string;
  title: string | null;
  summary: string | null;
  summary_through_message_id: number;
  messages: number;
  created_at: string;
  updated_at: string;
};
export type MessageRow = { id: number; conversation_id: number; role: string; content: string; created_at: string };
export type MemoryRow = {
  id: number;
  username: string;
  kind: 'profile' | 'fact';
  content: string;
  source_conversation_id: number | null;
  created_at: string;
  updated_at: string;
};
export type SessionRow = { id: string; username: string; created_at: string; expires_at: number };

export const MEMORY_KINDS = ['profile', 'fact'] as const;

const byUser = (username: string | undefined) => (username ? 'WHERE u.username = ?' : '');
const userArg = (username: string | undefined) => (username ? [username] : []);

// ── conversations and messages ───────────────────────────────────────────────
function conversationsWhere(db: DB, where: string, args: unknown[]): ConversationRow[] {
  return db
    .prepare(
      `SELECT c.id, u.username, c.title, c.summary, c.summary_through_message_id, c.created_at, c.updated_at,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS messages
       FROM conversations c JOIN users u ON u.id = c.user_id ${where}
       ORDER BY c.updated_at DESC, c.id DESC`,
    )
    .all(...args) as ConversationRow[];
}

export function listConversations(db: DB, username?: string): ConversationRow[] {
  return conversationsWhere(db, byUser(username), userArg(username));
}

export function getConversation(db: DB, id: number): ConversationRow | undefined {
  return conversationsWhere(db, 'WHERE c.id = ?', [id])[0];
}

export function listMessages(db: DB, conversationId: number): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as MessageRow[];
}

export function getMessage(db: DB, id: number): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export function renameConversation(db: DB, id: number, title: string): boolean {
  return (
    db
      .prepare("UPDATE conversations SET title = ?, title_is_auto = 0, updated_at = datetime('now') WHERE id = ?")
      .run(title, id).changes > 0
  );
}

export function deleteConversation(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
}

export function updateMessage(db: DB, id: number, content: string): boolean {
  return db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id).changes > 0;
}

export function deleteMessage(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

export function conversationTitle(c: ConversationRow): string {
  return c.title || '(untitled)';
}

export function formatConversation(c: ConversationRow, messages: MessageRow[]): string {
  const lines = [
    `# ${conversationTitle(c)}`,
    '',
    `Chat ${c.id} · ${c.username} · ${c.messages} messages · started ${localTime(c.created_at)} · updated ${localTime(c.updated_at)}`,
    '',
  ];
  if (c.summary) {
    lines.push(`## Running summary (covers messages up to ${c.summary_through_message_id})`, '', c.summary, '');
  }
  for (const m of messages) {
    lines.push(`## ${m.role === 'user' ? c.username : 'hearth'} · ${localTime(m.created_at)} · message ${m.id}`, '', m.content, '');
  }
  if (messages.length === 0) lines.push('(no messages)');
  return lines.join('\n');
}

// ── memories ─────────────────────────────────────────────────────────────────
export function listMemories(db: DB, username?: string): MemoryRow[] {
  return db
    .prepare(
      `SELECT m.id, u.username, m.kind, m.content, m.source_conversation_id, m.created_at, m.updated_at
       FROM memories m JOIN users u ON u.id = m.user_id ${byUser(username)}
       ORDER BY u.username, m.kind DESC, m.updated_at DESC`,
    )
    .all(...userArg(username)) as MemoryRow[];
}

export function getMemory(db: DB, id: number): MemoryRow | undefined {
  return db
    .prepare(
      `SELECT m.id, u.username, m.kind, m.content, m.source_conversation_id, m.created_at, m.updated_at
       FROM memories m JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    )
    .get(id) as MemoryRow | undefined;
}

export function addMemory(db: DB, userId: number, kind: string, content: string): number {
  return Number(
    db.prepare('INSERT INTO memories (user_id, kind, content) VALUES (?, ?, ?)').run(userId, kind, content).lastInsertRowid,
  );
}

// New text invalidates the stored embedding; recall recomputes missing ones.
export function updateMemoryContent(db: DB, id: number, content: string): boolean {
  return (
    db
      .prepare("UPDATE memories SET content = ?, embedding = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(content, id).changes > 0
  );
}

export function updateMemoryKind(db: DB, id: number, kind: string): boolean {
  return db.prepare("UPDATE memories SET kind = ?, updated_at = datetime('now') WHERE id = ?").run(kind, id).changes > 0;
}

export function deleteMemory(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

export function formatMemory(m: MemoryRow): string {
  return [
    `Memory ${m.id} · ${m.username} · ${m.kind}`,
    `From chat: ${m.source_conversation_id ?? '(added by hand)'}`,
    `Created ${localTime(m.created_at)} · updated ${localTime(m.updated_at)}`,
    '',
    m.content,
  ].join('\n');
}

// ── sessions ─────────────────────────────────────────────────────────────────
export function listSessions(db: DB, username?: string): SessionRow[] {
  return db
    .prepare(
      `SELECT s.id, u.username, s.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id ${byUser(username)}
       ORDER BY s.created_at DESC`,
    )
    .all(...userArg(username)) as SessionRow[];
}

/** Session ids are long hashes; accept any unique prefix. */
export function findSessionIds(db: DB, prefix: string): string[] {
  return (db.prepare("SELECT id FROM sessions WHERE id LIKE ? || '%'").all(prefix) as { id: string }[]).map((r) => r.id);
}

export function revokeSession(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
}

export function purgeExpiredSessions(db: DB): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
}

export function formatSession(s: SessionRow): string {
  const state = s.expires_at > Date.now() ? `expires ${new Date(s.expires_at).toLocaleString()}` : 'EXPIRED';
  return `${s.id.slice(0, 12)}  ${s.username.padEnd(20)} signed in ${localTime(s.created_at)} · ${state}`;
}

// ── database ─────────────────────────────────────────────────────────────────
export function dbInfo(db: DB, file: string): string {
  const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  const mib = (n: number) => `${(n / 2 ** 20).toFixed(2)} MiB`;
  return [
    `Database: ${file}`,
    `Size: ${mib(size(file))} (+ ${mib(size(`${file}-wal`))} write-ahead log)`,
    `Schema version: ${db.pragma('user_version', { simple: true })}`,
    '',
    ...['users', 'sessions', 'conversations', 'messages', 'memories'].map((t) => `  ${t.padEnd(14)} ${count(t)}`),
  ].join('\n');
}

export function integrityCheck(db: DB): string[] {
  return (db.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check);
}
