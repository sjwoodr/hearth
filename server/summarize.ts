// Keeps long chats coherent: once the unsummarized part of a chat grows past a threshold, the
// oldest messages are folded into a running summary that is sent in their place.
import { estimateTokens } from './context.ts';
import { isPreempted } from './busy.ts';
import type { DB } from './db.ts';
import { withImageText, type MessageRow } from './images.ts';
import type { JsonFn } from './ollama.ts';

// Scaled to the context window: summarize once the unsummarized part passes half of it, keeping the
// newest quarter verbatim. The rest holds the reply, personality, memories and the summary itself.
export const summaryThresholds = (numCtx: number) => ({ above: Math.floor(numCtx / 2), keep: Math.floor(numCtx / 4) });
export const SUMMARIZE_ABOVE_TOKENS = summaryThresholds(8192).above;
export const KEEP_RECENT_TOKENS = summaryThresholds(8192).keep;
const MAX_SUMMARY_CHARS = 2400;

const SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

/** Folds older messages into the summary when the chat is long enough. Returns true if it did. */
export async function summarizeIfLong(db: DB, conversationId: number, json: JsonFn, numCtx = 8192): Promise<boolean> {
  const { above, keep } = summaryThresholds(numCtx);
  const chat = db
    .prepare(
      `SELECT c.summary, c.summary_through_message_id AS through, coalesce(u.display_name, u.username) AS name
       FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    )
    .get(conversationId) as { summary: string | null; through: number; name: string } | undefined;
  if (!chat) return false;

  const messages = db
    .prepare('SELECT id, role, content, image_count, image_note FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .all(conversationId, chat.through) as MessageRow[];
  const text = (m: MessageRow) => withImageText(m.content, m.image_count, m.image_note);
  const total = messages.reduce((n, m) => n + estimateTokens(text(m)), 0);
  if (total <= above) return false;

  // Keep the newest messages verbatim; everything older gets folded in.
  let kept = 0;
  let cut = messages.length;
  while (cut > 0 && kept + estimateTokens(text(messages[cut - 1]!)) <= keep) {
    kept += estimateTokens(text(messages[--cut]!));
  }
  const fold = messages.slice(0, Math.max(cut, 1));

  console.log(`summary: folding ${fold.length} older message(s) of chat ${conversationId}…`);
  const transcript = fold.map((m) => `${m.role === 'user' ? chat.name : 'hearth'}: ${text(m)}`).join('\n\n');
  const raw = (await json(
    [
      {
        role: 'system',
        content: `You keep a running summary of a long conversation between ${chat.name} and hearth, a chat
companion, so the conversation can continue after older messages are no longer shown. Rewrite the
summary so it covers the previous summary plus the messages below. Keep the topics, what was decided or
explained, details ${chat.name} shared, open questions, and anything hearth offered to do. Plain prose,
third person, under 200 words.`,
      },
      { role: 'user', content: `Previous summary:\n${chat.summary ?? '(none)'}\n\nMessages to fold in:\n${transcript}` },
    ],
    SCHEMA,
  )) as { summary?: unknown };
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, MAX_SUMMARY_CHARS) : '';
  if (!summary) throw new Error('The model returned an empty summary.');

  // Only advance if nothing else summarized this chat in the meantime.
  return (
    db
      .prepare(
        'UPDATE conversations SET summary = ?, summary_through_message_id = ? WHERE id = ? AND summary_through_message_id = ?',
      )
      .run(summary, fold.at(-1)!.id, conversationId, chat.through).changes > 0
  );
}

/**
 * Runs summaries in the background, one at a time, at most one queued per chat. Failures are
 * logged and retried after the chat's next reply.
 */
export function createSummarizer(db: DB, json: JsonFn, numCtx = 8192): (conversationId: number) => void {
  const pending = new Set<number>();
  let chain = Promise.resolve();
  return (conversationId) => {
    if (pending.has(conversationId)) return;
    pending.add(conversationId);
    chain = chain.then(async () => {
      try {
        if (await summarizeIfLong(db, conversationId, json, numCtx)) console.log(`summary: chat ${conversationId} updated`);
      } catch (err) {
        if (isPreempted(err)) console.log(`summary: chat ${conversationId} paused for a chat reply`);
        else console.error(`summary: chat ${conversationId} failed:`, err instanceof Error ? err.message : err);
      } finally {
        pending.delete(conversationId);
      }
    });
  };
}
