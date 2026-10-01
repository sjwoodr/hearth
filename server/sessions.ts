import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

export const SESSION_COOKIE = 'hearth_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `name` is what hearth calls the user: their display name, else their username. */
export type SessionUser = { id: number; username: string; name: string };

const idFor = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: DB, userId: number, now = Date.now()): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    idFor(token),
    userId,
    now + SESSION_TTL_MS,
  );
  return token;
}

export function getSessionUser(db: DB, token: string, now = Date.now()): SessionUser | undefined {
  return db
    .prepare(
      `SELECT u.id, u.username, coalesce(u.display_name, u.username) AS name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`,
    )
    .get(idFor(token), now) as SessionUser | undefined;
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(idFor(token));
}

export function deleteUserSessions(db: DB, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
