// Keeps long chats coherent: once the unsummarized part of a chat grows past a threshold, the
// oldest messages are folded into a running summary that is sent in their place.
import { estimateTokens } from './context.ts';
import { isPreempted } from './busy.ts';
import { every } from './every.ts';
import { job } from './metrics.ts';
import type { DB } from './db.ts';
import { withImageText, type MessageRow } from './images.ts';
import type { JsonFn } from './ollama.ts';

// Scaled to the context window: summarize once the unsummarized part passes half of it, keeping the
// newest quarter verbatim. The rest holds the reply, personality, memories and the summary itself.
export const summaryThresholds = (numCtx: number) => ({ above: Math.floor(numCtx / 2), keep: Math.floor(numCtx / 4) });
export const SUMMARIZE_ABOVE_TOKENS = summaryThresholds(8192).above;
export const KEEP_RECENT_TOKENS = summaryThresholds(8192).keep;
const MAX_SUMMARY_CHARS = 2400;

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

  // Keep the newest messages verbatim; everything older gets folded in, at most `above` tokens per
  // pass (and at least one message) so the request always fits the window. A chat with more than
  // that to fold (one rebuilt from scratch) is folded over several passes, oldest first.
  let kept = 0;
  let cut = messages.length;
  while (cut > 0 && kept + estimateTokens(text(messages[cut - 1]!)) <= keep) {
    kept += estimateTokens(text(messages[--cut]!));
  }
  let folding = 0;
  let end = 0;
  while (end < cut && (end === 0 || folding + estimateTokens(text(messages[end]!)) <= above)) {
    folding += estimateTokens(text(messages[end++]!));
  }
  const fold = messages.slice(0, Math.max(end, 1));

  console.log(`summary: folding ${fold.length} older message(s) of chat ${conversationId}…`);
  const transcript = fold.map((m) => `${m.role === 'user' ? chat.name : 'hearth'}: ${text(m)}`).join('\n\n');
  const raw = await json(
    [
      {
        role: 'system',
        content: `You keep a running summary of a long conversation between ${chat.name} and hearth, a chat
companion, so the conversation can continue after older messages are no longer shown. Rewrite the
summary so it covers the previous summary plus the messages below. Keep the topics, what was decided or
explained, details ${chat.name} shared, open questions, and anything hearth offered to do. Plain prose,
third person, under 200 words. Reply with the summary only.`,
      },
      { role: 'user', content: `Previous summary:\n${chat.summary ?? '(none)'}\n\nMessages to fold in:\n${transcript}` },
    ],
    // Plain text, not a JSON schema: under a schema a quoted word ended the summary mid-sentence.
    null,
  );
  const summary = typeof raw === 'string' ? raw.trim().slice(0, MAX_SUMMARY_CHARS) : '';
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

/** Summarizes one chat if it's long, logging and counting the outcome. */
async function summarizeAndRecord(db: DB, conversationId: number, json: JsonFn, numCtx: number): Promise<'done' | 'preempted' | 'failed'> {
  try {
    if (await summarizeIfLong(db, conversationId, json, numCtx)) {
      job('summary', 'ok');
      console.log(`summary: chat ${conversationId} updated`);
    }
    return 'done';
  } catch (err) {
    const preempted = isPreempted(err);
    job('summary', preempted ? 'preempted' : 'failed');
    if (preempted) console.log(`summary: chat ${conversationId} paused for a chat reply`);
    else console.error(`summary: chat ${conversationId} failed:`, err instanceof Error ? err.message : err);
    return preempted ? 'preempted' : 'failed';
  }
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
      await summarizeAndRecord(db, conversationId, json, numCtx);
      pending.delete(conversationId);
    });
  };
}

/**
 * For a worker in its own process, which doesn't see replies happen: each pass looks for chats with
 * new replies since the last pass and summarizes the long ones. The first pass checks every chat
 * once (cheap: no model call unless one is over the threshold). A summary preempted for a reply is
 * retried on the next pass; other failures wait for the chat's next reply, as with createSummarizer.
 */
export function createSummarySweep(db: DB, json: JsonFn, numCtx = 8192) {
  let lastSeen = 0;
  const retry = new Set<number>();
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const fresh = db
        .prepare(
          `SELECT conversation_id AS id, max(id) AS last FROM messages
           WHERE id > ? AND role = 'assistant' GROUP BY conversation_id`,
        )
        .all(lastSeen) as { id: number; last: number }[];
      for (const row of fresh) lastSeen = Math.max(lastSeen, row.last);
      const chats = new Set([...retry, ...fresh.map((r) => r.id)]);
      retry.clear();
      // Preempted ones go round again next pass; failed ones wait for the chat's next reply.
      for (const id of chats) if ((await summarizeAndRecord(db, id, json, numCtx)) === 'preempted') retry.add(id);
    } finally {
      running = false;
    }
  };
}

// No "pause while a reply is active" (unlike the memory sweeper): the worker runs with the gateway,
// which preempts its calls for replies, and a preempted summary is retried on the next pass.
export function startSummarySweeper(db: DB, json: JsonFn, numCtx: number): () => void {
  return every(60_000, createSummarySweep(db, json, numCtx), { now: true, keepAlive: true });
}
