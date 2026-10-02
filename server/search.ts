import type { DB } from './db.ts';

// Snippet highlight markers: control characters, so the client can mark matches without
// ever treating message text as HTML.
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

export type SearchHit = {
  conversationId: number;
  title: string | null;
  messageId: number;
  role: 'user' | 'assistant';
  snippet: string;
  created_at: string;
};

/**
 * Turns free text into a safe FTS5 query: every word quoted (so operators and punctuation are
 * literal), all words required, the last one matched as a prefix so results appear while typing.
 */
export function toFtsQuery(text: string): string | undefined {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  if (!words) return undefined;
  return words
    .slice(0, 12)
    .map((w, i, all) => `"${w.replace(/"/g, '""')}"${i === all.length - 1 ? '*' : ''}`)
    .join(' ');
}

// The snippet (column -1) comes from whichever column matched: the text or its image description.
const HIT_SQL = `
  SELECT m.conversation_id AS conversationId, c.title, m.id AS messageId, m.role, m.created_at,
         snippet(messages_fts, -1, '${MARK_START}', '${MARK_END}', '…', 14) AS snippet
  FROM messages_fts
  JOIN messages m ON m.id = messages_fts.rowid
  JOIN conversations c ON c.id = m.conversation_id`;

/** The user's messages matching `text`, best first. */
export function searchMessages(db: DB, userId: number, text: string, limit = 40): SearchHit[] {
  const query = toFtsQuery(text);
  if (!query) return [];
  return db
    .prepare(`${HIT_SQL} WHERE messages_fts MATCH ? AND c.user_id = ? ORDER BY rank LIMIT ?`)
    .all(query, userId, limit) as SearchHit[];
}

/** Admin CLI only: the same search across every user. */
export function searchAllMessages(db: DB, text: string, limit = 40): (SearchHit & { username: string })[] {
  const query = toFtsQuery(text);
  if (!query) return [];
  return db
    .prepare(
      `SELECT hits.*, u.username FROM (${HIT_SQL} WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?) hits
       JOIN conversations c2 ON c2.id = hits.conversationId JOIN users u ON u.id = c2.user_id`,
    )
    .all(query, limit) as (SearchHit & { username: string })[];
}
