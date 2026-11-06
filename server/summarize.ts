// Keeps long chats coherent: once the unsummarized part of a chat grows past a threshold, the
// oldest messages are folded into a running summary that is sent in their place.
import { estimateTokens } from './context.ts';
import { isPreempted } from './busy.ts';
import { every } from './every.ts';
import { job } from './metrics.ts';
import type { DB } from './db.ts';
import { withImageText, type MessageRow } from './images.ts';
import type { JsonFn } from './ollama.ts';

// Scaled to the context budget (HEARTH_CONTEXT_BUDGET, the part of the window hearth fills):
// summarize once the unsummarized part passes half of it, keeping the newest quarter verbatim. The
// rest holds the reply, personality, memories and the summary itself.
export const summaryThresholds = (budget: number) => ({ above: Math.floor(budget / 2), keep: Math.floor(budget / 4) });
export const SUMMARIZE_ABOVE_TOKENS = summaryThresholds(8192).above;
export const KEEP_RECENT_TOKENS = summaryThresholds(8192).keep;
// The notes ride in every prompt of a long chat, so this is about 1,700 tokens of each one.
const MAX_SUMMARY_CHARS = 6000;
// Normal is ~400 characters. This stops a rambling reply from pushing the topics out.
const MAX_LATEST_CHARS = 1200;
const MAX_NEW_TOPICS = 10;
const TOPICS_HEADING = 'Topics so far:';
const NEW_TOPICS_HEADING = 'New topics:';

/** How far a chat is toward its next fold: unsummarized tokens (estimated) against the fold threshold. */
export type ContextUse = { used: number; foldAt: number };

const unsummarized = (db: DB, conversationId: number, through: number) =>
  db
    .prepare('SELECT id, role, content, image_count, image_note FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .all(conversationId, through) as MessageRow[];
const messageText = (m: MessageRow) => withImageText(m.content, m.image_count, m.image_note);

/** For the chat's context meter. Counted the way `summarizeIfLong` counts, so 100% is where it folds. */
export function contextUse(db: DB, conversationId: number, budget = 8192): ContextUse {
  const row = db.prepare('SELECT summary_through_message_id AS through FROM conversations WHERE id = ?').get(conversationId) as
    | { through: number }
    | undefined;
  const messages = row ? unsummarized(db, conversationId, row.through) : [];
  return { used: messages.reduce((n, m) => n + estimateTokens(messageText(m)), 0), foldAt: summaryThresholds(budget).above };
}

/** The topic lines of a stored summary. A chat folded before topics existed has prose: that's one line. */
function topicLines(summary: string | null): string[] {
  if (!summary) return [];
  const at = summary.indexOf(TOPICS_HEADING);
  if (at === -1) return [`- Earlier: ${summary.replace(/\s+/g, ' ').trim()}`];
  return summary.slice(at).split('\n').filter((line) => line.startsWith('- '));
}

/**
 * The next summary: the model's Latest, then every topic so far plus its new ones. Code keeps the
 * list because a model rewriting it each fold lost the oldest topics, and copying it was slow. A
 * reply without the heading is all Latest, so a malformed one can't cost the list.
 */
function nextSummary(previous: string | null, reply: string): string {
  const at = reply.indexOf(NEW_TOPICS_HEADING);
  const latest = (at === -1 ? reply : reply.slice(0, at)).trim().slice(0, MAX_LATEST_CHARS);
  const added = at === -1 ? [] : reply.slice(at).split('\n').map((line) => line.trim());
  const fresh = added.filter((line) => line.startsWith('- ')).slice(0, MAX_NEW_TOPICS);
  const topics = [...new Set([...topicLines(previous), ...fresh])];
  const render = () => (topics.length ? `${latest}\n\n${TOPICS_HEADING}\n${topics.join('\n')}` : latest);
  // Shortcut: past the limit the oldest topics go, about 12 folds in. A model call that merges old
  // lines is the upgrade if chats ever get that long.
  while (render().length > MAX_SUMMARY_CHARS) topics.shift();
  return render();
}

/** Folds older messages into the summary when the chat is long enough. Returns true if it did. */
/** `assistant` is the name the assistant answers to (HEARTH_ASSISTANT_NAME). */
export async function summarizeIfLong(
  db: DB,
  conversationId: number,
  json: JsonFn,
  budget = 8192,
  assistant = 'hearth',
): Promise<boolean> {
  const { above, keep } = summaryThresholds(budget);
  const chat = db
    .prepare(
      `SELECT c.summary, c.summary_through_message_id AS through, coalesce(u.display_name, u.username) AS name
       FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    )
    .get(conversationId) as { summary: string | null; through: number; name: string } | undefined;
  if (!chat) return false;

  const messages = unsummarized(db, conversationId, chat.through);
  const text = messageText;
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
  const transcript = fold.map((m) => `${m.role === 'user' ? chat.name : assistant}: ${text(m)}`).join('\n\n');
  const raw = await json(
    [
      {
        role: 'system',
        content: `You keep notes on a long conversation between ${chat.name} and ${assistant}, a chat
companion, so the conversation can continue after older messages are no longer shown. You are given
the existing notes and the newest messages. Reply with two sections, in this order.

The first section starts with the line "Latest:". Under it write plain prose, third person, under 60
words: what was decided or explained in the newest messages, details ${chat.name} shared, open questions,
and anything ${assistant} offered to do.

The second section starts with the line "${NEW_TOPICS_HEADING}". Under it put at most ${MAX_NEW_TOPICS} lines, each starting
with "- ", one for each subject of the newest messages that the existing topics do not cover yet. Go
through the newest messages in order, starting from the very first one, and cover all of them.
Each line is a short phrase saying what was said about the subject, with the people and works
involved grouped on the same line, not one line per name. Say who made a work only if the messages
say so. Do not repeat existing topics. If nothing is new, leave the section empty.

Reply with those two sections only.`,
      },
      { role: 'user', content: `Existing notes:\n${chat.summary ?? '(none)'}\n\nNewest messages:\n${transcript}` },
    ],
    // Plain text, not a JSON schema: under a schema a quoted word ended the summary mid-sentence.
    null,
  );
  const reply = typeof raw === 'string' ? raw.trim() : '';
  if (!reply) throw new Error('The model returned an empty summary.');
  const summary = nextSummary(chat.summary, reply);

  // Only advance if nothing else summarized this chat in the meantime.
  const advanced =
    db
      .prepare(
        'UPDATE conversations SET summary = ?, summary_through_message_id = ? WHERE id = ? AND summary_through_message_id = ?',
      )
      .run(summary, fold.at(-1)!.id, conversationId, chat.through).changes > 0;
  // For the line the chat shows where this happened: after the newest message at the time.
  if (advanced) {
    db.prepare('INSERT INTO summary_folds (conversation_id, after_message_id, folded) VALUES (?, ?, ?)').run(
      conversationId,
      messages.at(-1)!.id,
      fold.length,
    );
  }
  return advanced;
}

/** A pass that folded messages into the chat's summary, for the line shown after `afterMessageId`. */
export type SummaryFold = { afterMessageId: number; folded: number };

export function listFolds(db: DB, conversationId: number): SummaryFold[] {
  return db
    .prepare('SELECT after_message_id AS afterMessageId, folded FROM summary_folds WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as SummaryFold[];
}

/** Summarizes one chat if it's long, logging and counting the outcome. */
async function summarizeAndRecord(
  db: DB,
  conversationId: number,
  json: JsonFn,
  budget: number,
  assistant: string,
): Promise<'done' | 'preempted' | 'failed'> {
  try {
    if (await summarizeIfLong(db, conversationId, json, budget, assistant)) {
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
export function createSummarizer(db: DB, json: JsonFn, budget = 8192, assistant = 'hearth'): (conversationId: number) => void {
  const pending = new Set<number>();
  let chain = Promise.resolve();
  return (conversationId) => {
    if (pending.has(conversationId)) return;
    pending.add(conversationId);
    chain = chain.then(async () => {
      await summarizeAndRecord(db, conversationId, json, budget, assistant);
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
export function createSummarySweep(db: DB, json: JsonFn, budget = 8192, assistant = 'hearth') {
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
      for (const id of chats) if ((await summarizeAndRecord(db, id, json, budget, assistant)) === 'preempted') retry.add(id);
    } finally {
      running = false;
    }
  };
}

// No "pause while a reply is active" (unlike the memory sweeper): the worker runs with the gateway,
// which preempts its calls for replies, and a preempted summary is retried on the next pass.
export function startSummarySweeper(db: DB, json: JsonFn, budget: number, assistant = 'hearth'): () => void {
  return every(60_000, createSummarySweep(db, json, budget, assistant), { now: true, keepAlive: true });
}
