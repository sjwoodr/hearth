import type { DB } from './db.ts';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.ts';
import { deleteUserSessions } from './sessions.ts';

export type User = {
  id: number;
  username: string;
  display_name: string | null;
  password_hash: string;
  disabled: number;
  created_at: string;
};

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;

export function validateUsername(username: string): string | undefined {
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 1-32 characters: letters, digits, "_", "." or "-", starting with a letter or digit.';
  }
}

export function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
}

export const MAX_DISPLAY_NAME_CHARS = 40;

/** Collapses whitespace; returns undefined for anything unusable as a name. */
export function cleanDisplayName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > MAX_DISPLAY_NAME_CHARS || /[<>{}[\]#*_`|\\]/.test(name)) return undefined;
  return name;
}

/** Sets the display name, or clears it (back to the username) when `name` is empty. */
export function setDisplayName(db: DB, username: string, name: string): void {
  const user = requireUser(db, username);
  const clean = name.trim() === '' ? null : cleanDisplayName(name);
  if (clean === undefined) {
    throw new Error(`A display name must be 1-${MAX_DISPLAY_NAME_CHARS} characters, without markdown symbols.`);
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(clean, user.id);
}

/** What hearth calls the user. */
export const nameOf = (user: Pick<User, 'username' | 'display_name'>) => user.display_name ?? user.username;

export function findUser(db: DB, username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function listUsers(db: DB): (User & { sessions: number })[] {
  return db
    .prepare(
      `SELECT u.*, (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
       FROM users u ORDER BY u.username`,
    )
    .all(Date.now()) as (User & { sessions: number })[];
}

export async function createUser(db: DB, username: string, password: string): Promise<User> {
  const problem = validateUsername(username) ?? validatePassword(password);
  if (problem) throw new Error(problem);
  if (findUser(db, username)) throw new Error(`User "${username}" already exists.`);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, await hashPassword(password));
  return findUser(db, username)!;
}

function requireUser(db: DB, username: string): User {
  const user = findUser(db, username);
  if (!user) throw new Error(`No user "${username}".`);
  return user;
}

// Changing a password, disabling or deleting a user all end that user's sessions.
export async function setPassword(db: DB, username: string, password: string): Promise<void> {
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const user = requireUser(db, username);
  const hash = await hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    deleteUserSessions(db, user.id);
  })();
}

export function setDisabled(db: DB, username: string, disabled: boolean): void {
  const user = requireUser(db, username);
  db.transaction(() => {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, user.id);
    if (disabled) deleteUserSessions(db, user.id);
  })();
}

// Cascades to the user's sessions, conversations, messages and memories.
export function deleteUser(db: DB, username: string): void {
  const user = requireUser(db, username);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
}
