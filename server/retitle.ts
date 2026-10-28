// Retitles a chat that has moved on from where it started. The first title comes from the first
// exchange (titles.ts), so a chat that opened with a quick question and became something else kept
// that question's name. Once a chat goes quiet with a few new messages, the model sees the current
// title and the user's side of the whole chat, and keeps the title or writes a better one.
// Never touches a chat the user renamed (setAutoTitle).
import { isPreempted } from './busy.ts';
import { setAutoTitle } from './conversations.ts';
import type { DB } from './db.ts';
import { every } from './every.ts';
import { job } from './metrics.ts';
import type { JsonFn } from './ollama.ts';
import { cleanTitle } from './titles.ts';

/** New messages since the last check before a chat is looked at again. */
export const RETITLE_AFTER = 4;
// The model reads the user's side only, shortened: replies are long and repeat the topic, while the
// user's messages show what the chat spent its time on. A long chat is sampled evenly.
const MAX_LINES = 100;
const MAX_LINE_CHARS = 200;

/** Up to MAX_LINES of the user's messages, oldest first, evenly spread over the whole chat. */
export function sampleLines(messages: string[]): string[] {
  const step = Math.max(1, messages.length / MAX_LINES);
  const picked: string[] = [];
  for (let i = 0; i < messages.length && picked.length < MAX_LINES; i += step) picked.push(messages[Math.floor(i)]!);
  return picked.map((m) => {
    const line = m.replace(/\s+/g, ' ').trim();
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
  });
}

const FITS_SCHEMA = { type: 'object', properties: { fits: { type: 'boolean' } }, required: ['fits'] };

/**
 * The model's answer: a new title, or undefined to keep the current one. Two calls: a yes/no on
 * whether the title still fits, then a title only if it doesn't. One call answering "KEEP or a new
 * title" either reworded titles that fitted ("Chicago Bears Schedule" → "...Performance") or, told not
 * to, kept titles a chat had long left.
 */
export function makeRetitler(json: JsonFn) {
  return async (title: string, userMessages: string[]): Promise<string | undefined> => {
    const said = `The user's messages, oldest first:\n${sampleLines(userMessages).map((m) => `- ${m}`).join('\n')}`;
    const check = (await json(
      [
        {
          role: 'system',
          content:
            "You check whether a chat's title still fits. Answer fits=true if most of the chat is about the " +
            'subject the title names, even loosely. Answer fits=false if most of the chat is about a different ' +
            'subject and the title only fits how it began.',
        },
        { role: 'user', content: `TITLE: ${title}\n\n${said}` },
      ],
      FITS_SCHEMA,
    )) as { fits?: unknown };
    if (check?.fits !== false) return undefined;
    const raw = await json(
      [
        {
          role: 'system',
          content:
            'Write a short title, 2 to 6 words, for the chat below. Name the subject most of it is about, like a ' +
            'heading. No quotes, no trailing period, no emoji. Reply with the title only.',
        },
        { role: 'user', content: said },
      ],
      // Plain text, as for the first title (titles.ts).
      null,
    );
    const better = cleanTitle(raw);
    return better && better.toLowerCase() !== title.toLowerCase() ? better : undefined;
  };
}

/** Auto-titled chats, quiet for `idleMinutes`, with at least RETITLE_AFTER messages since the last check. */
export function chatsToRetitle(db: DB, idleMinutes: number): number[] {
  return (
    db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE c.title_is_auto = 1 AND c.title IS NOT NULL
           AND (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.id > c.title_checked_through_message_id) >= ?
           AND (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id) <= datetime('now', ?)
         ORDER BY c.updated_at`,
      )
      .all(RETITLE_AFTER, `-${idleMinutes} minutes`) as { id: number }[]
  ).map((r) => r.id);
}

/** Checks one chat; true if it got a new title. */
export async function retitle(db: DB, id: number, retitler: ReturnType<typeof makeRetitler>): Promise<boolean> {
  const chat = db
    .prepare('SELECT title, (SELECT max(id) FROM messages WHERE conversation_id = c.id) AS through FROM conversations c WHERE id = ?')
    .get(id) as { title: string | null; through: number | null } | undefined;
  if (!chat?.title || chat.through === null) return false;
  const said = db
    .prepare("SELECT content, image_count FROM messages WHERE conversation_id = ? AND role = 'user' AND id <= ? ORDER BY id")
    .all(id, chat.through) as { content: string; image_count: number }[];
  const better = await retitler(
    chat.title,
    said.map((m) => m.content || (m.image_count ? '[an image]' : '')).filter(Boolean),
  );
  // One transaction: the title (unless the user renamed it meanwhile) and how far this check read.
  return db.transaction(() => {
    db.prepare('UPDATE conversations SET title_checked_through_message_id = ? WHERE id = ?').run(chat.through, id);
    return better ? setAutoTitle(db, id, better) : false;
  })();
}

/**
 * One pass over quiet chats. A preempted check stops the pass and is retried next time (nothing was
 * written); a failed one waits 15 minutes, as memory extraction does.
 */
export function createRetitleSweep(
  db: DB,
  json: JsonFn,
  idleMinutes: number,
  opts: { paused?: () => boolean; now?: () => number } = {},
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  const retitler = makeRetitler(json);
  const retryAt = new Map<number, number>();
  let running = false;
  return async () => {
    if (running || opts.paused?.()) return;
    running = true;
    try {
      for (const id of chatsToRetitle(db, idleMinutes)) {
        if ((retryAt.get(id) ?? 0) > now()) continue;
        if (opts.paused?.()) return;
        try {
          if (await retitle(db, id, retitler)) console.log(`title: chat ${id} retitled`);
          retryAt.delete(id);
          job('retitle', 'ok');
        } catch (err) {
          if (isPreempted(err)) {
            job('retitle', 'preempted');
            return;
          }
          job('retitle', 'failed');
          retryAt.set(id, now() + 15 * 60_000);
          console.error(`title: chat ${id} recheck failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      running = false;
    }
  };
}

/** Runs the sweep every minute, alongside memory extraction (same idle time, same pause). */
export function startRetitleSweeper(db: DB, json: JsonFn, idleMinutes: number, opts: { paused?: () => boolean } = {}): () => void {
  return every(60_000, createRetitleSweep(db, json, idleMinutes, opts));
}
