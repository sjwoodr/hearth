// "For now" memories after their last day (shared/for-now.ts has the dates and limits). Once a trip or a
// visit is over, its memory is rewritten once in the past tense ("Sam was on a cruise in December 2026
// and loved the piano player at the lounge"), its end date cleared, and from then on it's an ordinary memory,
// recalled when relevant (owner's call, 2026-11-25). If the rewrite fails it stays as written: the date
// it was learned, shown when it's recalled, still says when it was.
import { isPreempted } from './busy.ts';
import type { DB } from './db.ts';
import { job } from './metrics.ts';
import { MAX_MEMORY_CHARS } from './memories.ts';
import type { JsonFn } from './ollama.ts';
import { localDay, monthYear } from '../shared/for-now.ts';

/** How many ended memories one sweep pass rewrites: a backlog (the worker was down) clears over a few minutes. */
const REWRITES_PER_PASS = 5;

/** One memory rewritten as past, or undefined if the model's answer isn't one usable sentence. */
export async function pastTense(json: JsonFn, username: string, content: string, until: string): Promise<string | undefined> {
  const when = monthYear(until);
  // Plain text, not a schema: a quotation mark under Ollama's grammar would end the string early.
  const raw = await json(
    [
      {
        role: 'system',
        content:
          `You rewrite one memory that a chat companion keeps about ${username}. It describes a situation that is now ` +
          `over: it lasted until ${until}. Rewrite it as one sentence in the past tense, as something that happened, ` +
          `and say when ("in ${when}"). Keep its details and add nothing. Write only the sentence.`,
      },
      { role: 'user', content: `MEMORY: ${content}` },
    ],
    null,
  );
  const text = String(raw ?? '')
    .trim()
    .replace(/^MEMORY:\s*/i, '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > MAX_MEMORY_CHARS || !/[.!?)]$/.test(text) || text === content) return undefined;
  return text;
}

/**
 * Rewrites "for now" memories whose last day has passed (every user's: this is the background sweep).
 * Each write checks `until` is still what was read, so an end date the user moved meanwhile wins.
 * Preemption by a reply is rethrown with nothing written; any other failure keeps the memory as written.
 */
export async function rewriteEnded(db: DB, json: JsonFn, today: string = localDay()): Promise<number> {
  const ended = db
    .prepare(
      `SELECT m.id, m.content, m.until, coalesce(u.display_name, u.username) AS username
       FROM memories m JOIN users u ON u.id = m.user_id
       WHERE m.until IS NOT NULL AND m.until < ? ORDER BY m.until, m.id LIMIT ?`,
    )
    .all(today, REWRITES_PER_PASS) as { id: number; content: string; until: string; username: string }[];
  let rewritten = 0;
  for (const m of ended) {
    let past: string | undefined;
    try {
      past = await pastTense(json, m.username, m.content, m.until);
      if (!past) console.error(`memory: #${m.id} ended; its rewrite wasn't one sentence, keeping it as written`);
    } catch (err) {
      if (isPreempted(err)) {
        job('for-now', 'preempted');
        throw err;
      }
      console.error(`memory: #${m.id} ended; rewrite failed, keeping it as written:`, err instanceof Error ? err.message : err);
    }
    if (past) {
      const { changes } = db
        .prepare("UPDATE memories SET content = ?, until = NULL, embedding = NULL, updated_at = datetime('now') WHERE id = ? AND until = ?")
        .run(past, m.id, m.until);
      if (changes) {
        rewritten++;
        job('for-now', 'ok');
      }
    } else {
      db.prepare('UPDATE memories SET until = NULL WHERE id = ? AND until = ?').run(m.id, m.until);
      job('for-now', 'failed');
    }
  }
  if (ended.length) console.log(`memory: ${ended.length} "for now" memory(ies) ended, ${rewritten} rewritten as past`);
  return rewritten;
}
