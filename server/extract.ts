// Memory extraction: reads the unread part of a conversation and records durable facts
// about the user. Runs in the background once a chat has gone quiet.
import { every } from './every.ts';
import { job } from './metrics.ts';
import { estimateTokens } from './context.ts';
import { isPreempted } from './busy.ts';
import type { DB } from './db.ts';
import { withImageText, type MessageRow } from './images.ts';
import { cosine, MAX_MEMORY_CHARS, toBlob, withEmbeddings, type MemoryKind } from './memories.ts';
import type { EmbedFn, JsonFn } from './ollama.ts';
import { cleanDisplayName, MAX_DISPLAY_NAME_CHARS } from './users.ts';

const MAX_CHANGES = 8;
const MAX_EXISTING_SHOWN = 80;
const TRANSCRIPT_BUDGET_TOKENS = 4500;

// The limits bound the grammar so the model can't loop on items or one endless string. Lengths
// are twice the stored limit: a string the grammar cuts off is over the limit and gets dropped by
// sanitizeExtraction, rather than saved as a truncated fact. The pattern stops a stray double
// quote from ending a fact early (see JsonFn): with no raw quote allowed and a closing punctuation
// mark required, the string can only end where the sentence does. Ollama enforces patterns.
const CONTENT = { type: 'string', maxLength: 2 * MAX_MEMORY_CHARS, pattern: String.raw`^[^"\\\n]*[.!?)]$` };

export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      maxItems: MAX_CHANGES,
      items: { type: 'object', properties: { content: CONTENT }, required: ['content'] },
    },
    update: {
      type: 'array',
      maxItems: MAX_CHANGES,
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, content: CONTENT },
        required: ['id', 'content'],
      },
    },
    name: { type: 'string', maxLength: 2 * MAX_DISPLAY_NAME_CHARS },
  },
  required: ['add', 'update', 'name'],
};

// Extraction only ever adds facts. A memory becomes "profile" (included in every chat) only when
// the user promotes it: the model over-generalizes one-off requests into standing preferences.
export type Extraction = {
  add: { content: string }[];
  update: { id: number; content: string }[];
  /** A name the user explicitly asked to be called, if any. */
  name?: string;
};

type Existing = { id: number; kind: MemoryKind; content: string };

/**
 * Keeps only well-formed changes: known kinds, non-empty text within the length limit,
 * updates to memories this user actually has, no duplicate additions, a capped count.
 */
export function sanitizeExtraction(raw: unknown, existing: Existing[]): Extraction {
  const out: Extraction = { add: [], update: [] };
  if (!raw || typeof raw !== 'object') return out;
  const { add, update, name } = raw as { add?: unknown; update?: unknown; name?: unknown };
  const cleanName = cleanDisplayName(name);
  if (cleanName) out.name = cleanName;
  const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const known = new Map(existing.map((m) => [m.id, m]));
  const seen = new Set(existing.map((m) => m.content.toLowerCase()));

  for (const item of Array.isArray(add) ? add : []) {
    const content = clean(item?.content);
    if (!content || content.length > MAX_MEMORY_CHARS) continue;
    if (seen.has(content.toLowerCase())) continue;
    seen.add(content.toLowerCase());
    out.add.push({ content });
    if (out.add.length === MAX_CHANGES) break;
  }
  const updated = new Set<number>();
  for (const item of Array.isArray(update) ? update : []) {
    const content = clean(item?.content);
    const current = known.get(item?.id);
    if (!current || updated.has(current.id) || !content || content.length > MAX_MEMORY_CHARS) continue;
    if (content === current.content) continue;
    updated.add(current.id);
    out.update.push({ id: current.id, content });
    if (out.update.length === MAX_CHANGES) break;
  }
  return out;
}

function instructions(username: string): string {
  return `You maintain the long-term memory of a chat companion called hearth, about its user ${username}.
Read the new conversation and decide what is worth remembering in future chats.

Record only what ${username} said or clearly implied about themselves: preferences, likes and
dislikes, hobbies, ongoing projects, goals, what they are learning, people and pets they mention.
Never record what hearth said, general knowledge, guesses, or one-off small talk.

- An instruction about a single reply ("keep it short", "answer in French") is not a lasting
  preference. Record it only if ${username} says it applies from now on.
- Each thing gets exactly one memory. Never add a memory that restates another one, new or
  existing, in different words.
- If a new detail changes or extends an existing memory, update that memory by its id instead of
  adding another.
- Write each memory as one short, specific sentence in the third person, using the name ${username}.
  Don't include dates; hearth records when each memory was learned.
- If nothing is worth remembering, return empty lists.
- "name": only if ${username} explicitly tells you their name or what to call them ("I'm Sam",
  "call me Sam"), put just that name here. Otherwise leave it empty. Never guess.`;
}

// Measured with embeddinggemma: rewordings of one fact scored 0.86-0.94, but different facts on
// the same topic scored up to 0.91 (French vs Spanish 0.886, druid vs paladin 0.905). Similarity
// alone can't tell them apart, so it only picks candidates and the model makes the call
// (9 of 10 right on those pairs, erring toward keeping).
export const NEAR_DUPLICATE_CANDIDATE = 0.85;
const MAX_CANDIDATES_CHECKED = 3;
const SAME_SCHEMA = { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'] };

async function saysTheSame(json: JsonFn, existing: string, candidate: string): Promise<boolean> {
  const raw = (await json(
    [
      {
        role: 'system',
        content:
          'You compare two memories about a person. Answer same=true only if the NEW memory adds nothing beyond ' +
          'the EXISTING one: the same fact, just worded differently. If the new one states a different fact, a ' +
          'different detail, or something more specific, answer same=false.',
      },
      { role: 'user', content: `EXISTING: ${existing}\nNEW: ${candidate}` },
    ],
    SAME_SCHEMA,
  )) as { same?: unknown };
  return raw?.same === true;
}

type NewMemory = { content: string; vector?: ArrayLike<number> };

/**
 * Drops additions that reword a memory the user already has (or one added earlier in the same
 * batch). Any failure keeps the memory: a duplicate is cheaper than a lost fact.
 */
async function dropNearDuplicates(
  db: DB,
  userId: number,
  adds: { content: string }[],
  json: JsonFn,
  embed: EmbedFn,
): Promise<{ kept: NewMemory[]; skipped: number }> {
  if (adds.length === 0) return { kept: [], skipped: 0 };
  let existing: { content: string; vector: ArrayLike<number> }[];
  let vectors: number[][];
  try {
    existing = await withEmbeddings(db, userId, embed);
    vectors = await embed(adds.map((a) => a.content));
  } catch (err) {
    console.error('memory: near-duplicate check skipped:', err instanceof Error ? err.message : err);
    return { kept: adds, skipped: 0 };
  }

  const kept: { content: string; vector: ArrayLike<number> }[] = [];
  let skipped = 0;
  for (const [i, add] of adds.entries()) {
    const vector = vectors[i]!;
    const candidates = [...existing, ...kept]
      .map((m) => ({ content: m.content, score: cosine(vector, m.vector) }))
      .filter((m) => m.score >= NEAR_DUPLICATE_CANDIDATE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES_CHECKED);
    let duplicate = false;
    for (const candidate of candidates) {
      try {
        if (await saysTheSame(json, candidate.content, add.content)) {
          duplicate = true;
          break;
        }
      } catch (err) {
        // Preempted by a chat: abandon the whole run (nothing is written) so it retries intact.
        if (isPreempted(err)) throw err;
        console.error('memory: duplicate judgement failed, keeping it:', err instanceof Error ? err.message : err);
      }
    }
    if (duplicate) skipped++;
    else kept.push({ content: add.content, vector });
  }
  return { kept, skipped };
}

export type ExtractResult = {
  conversationId: number;
  read: number;
  added: number;
  updated: number;
  /** Additions dropped as rewordings of an existing memory. */
  duplicates: number;
  named: boolean;
};

/** `embed` enables the near-duplicate check; without it only exact duplicates are skipped. */
export async function extractMemories(
  db: DB,
  conversationId: number,
  json: JsonFn,
  embed?: EmbedFn,
): Promise<ExtractResult> {
  const conversation = db
    .prepare(
      `SELECT c.id, c.user_id, c.memory_through_message_id, u.display_name,
              coalesce(u.display_name, u.username) AS username
       FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    )
    .get(conversationId) as
    | { id: number; user_id: number; memory_through_message_id: number; display_name: string | null; username: string }
    | undefined;
  if (!conversation) throw new Error(`No conversation ${conversationId}.`);

  const unread = db
    .prepare('SELECT id, role, content, image_count, image_note FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .all(conversation.id, conversation.memory_through_message_id) as MessageRow[];
  const none = { conversationId, read: 0, added: 0, updated: 0, duplicates: 0, named: false };
  if (unread.length === 0) return none;
  const lastId = unread.at(-1)!.id;

  // Newest first until the budget runs out, so a very long chat keeps its latest turns.
  let used = 0;
  const transcript: string[] = [];
  for (let i = unread.length - 1; i >= 0; i--) {
    const m = unread[i]!;
    const line = `${m.role === 'user' ? conversation.username : 'hearth'}: ${withImageText(m.content, m.image_count, m.image_note)}`;
    used += estimateTokens(line);
    if (used > TRANSCRIPT_BUDGET_TOKENS && transcript.length > 0) break;
    transcript.unshift(line);
  }

  const existing = db
    .prepare(
      `SELECT id, kind, content FROM memories
       WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(conversation.user_id, MAX_EXISTING_SHOWN) as Existing[];
  const existingText = existing.length
    ? existing
        .map((m) => `[${m.id}] (${m.kind}) ${m.content}`)
        .join('\n')
    : '(none yet)';

  const raw = await json(
    [
      { role: 'system', content: instructions(conversation.username) },
      {
        role: 'user',
        content: `Existing memories:\n${existingText}\n\nNew conversation:\n${transcript.join('\n\n')}`,
      },
    ],
    EXTRACTION_SCHEMA,
  );
  const changes = sanitizeExtraction(raw, existing);
  const named = changes.name !== undefined && conversation.display_name === null;
  const { kept, skipped } = embed
    ? await dropNearDuplicates(db, conversation.user_id, changes.add, json, embed)
    : { kept: changes.add as NewMemory[], skipped: 0 };

  db.transaction(() => {
    const insert = db.prepare(
      'INSERT INTO memories (user_id, kind, content, source_conversation_id, embedding) VALUES (?, ?, ?, ?, ?)',
    );
    for (const a of kept) {
      insert.run(conversation.user_id, 'fact', a.content, conversation.id, a.vector ? toBlob(a.vector) : null);
    }
    const update = db.prepare(
      "UPDATE memories SET content = ?, embedding = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    );
    for (const u of changes.update) update.run(u.content, u.id, conversation.user_id);
    db.prepare('UPDATE conversations SET memory_through_message_id = ? WHERE id = ?').run(lastId, conversation.id);
    // A learned name only fills a blank; it never replaces one someone set.
    if (named) db.prepare('UPDATE users SET display_name = ? WHERE id = ? AND display_name IS NULL').run(changes.name, conversation.user_id);
  })();

  return {
    conversationId,
    read: unread.length,
    added: kept.length,
    updated: changes.update.length,
    duplicates: skipped,
    named,
  };
}

/** Conversations with unread messages whose last message is at least `idleMinutes` old. */
export function conversationsReadyForExtraction(db: DB, idleMinutes: number): number[] {
  return (
    db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.id > c.memory_through_message_id)
           AND (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id) <= datetime('now', ?)
         ORDER BY c.updated_at`,
      )
      .all(`-${idleMinutes} minutes`) as { id: number }[]
  ).map((r) => r.id);
}

function unreadCount(db: DB, conversationId: number): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.id = ? AND m.id > c.memory_through_message_id`,
      )
      .get(conversationId) as { n: number }
  ).n;
}

/**
 * One pass over quiet chats, extracting from each in turn. A failing chat waits 15 minutes
 * before a retry, so a persistent error can't keep the model busy; a chat preempted by a
 * reply is retried on the next pass, and the pass stops so the reply has the model.
 */
export function createSweep(
  db: DB,
  json: JsonFn,
  embed: EmbedFn,
  idleMinutes: number,
  opts: { paused?: () => boolean; now?: () => number } = {},
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  const retryAt = new Map<number, number>();
  let running = false;
  return async () => {
    if (running || opts.paused?.()) return;
    running = true;
    try {
      for (const id of conversationsReadyForExtraction(db, idleMinutes)) {
        if ((retryAt.get(id) ?? 0) > now()) continue;
        if (opts.paused?.()) return;
        const started = Date.now();
        const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
        console.log(`memory: reading chat ${id} (${unreadCount(db, id)} new message(s))…`);
        try {
          const r = await extractMemories(db, id, json, embed);
          retryAt.delete(id);
          job('memory', 'ok');
          console.log(
            `memory: chat ${id} done in ${secs()}: read ${r.read}, added ${r.added}, updated ${r.updated}, skipped ${r.duplicates} duplicate(s)`,
          );
        } catch (err) {
          if (isPreempted(err)) {
            job('memory', 'preempted');
            console.log(`memory: chat ${id} paused after ${secs()} for a chat reply; will retry`);
            return;
          }
          job('memory', 'failed');
          retryAt.set(id, now() + 15 * 60_000);
          console.error(`memory: chat ${id} failed after ${secs()}:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      running = false;
    }
  };
}

/** Runs the sweep every minute. Progress lives in the database, so a restart loses nothing. */
export function startMemorySweeper(
  db: DB,
  json: JsonFn,
  embed: EmbedFn,
  idleMinutes: number,
  opts: { paused?: () => boolean } = {},
): () => void {
  return every(60_000, createSweep(db, json, embed, idleMinutes, opts));
}
