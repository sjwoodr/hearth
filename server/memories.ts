// Memory queries for the web app and chat. Every function is scoped to one user.
import { estimateTokens } from './context.ts';
import { isForNow, localDay, MAX_ACTIVE_FOR_NOW } from '../shared/for-now.ts';
import type { DB } from './db.ts';
import type { EmbedFn } from './ollama.ts';
import { getPersona } from './persona.ts';

export const MEMORY_KINDS = ['profile', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MAX_MEMORY_CHARS = 400;
/** Who a memory is about: the user, or the assistant as the user has established it (persona.ts). */
export const MEMORY_SUBJECTS = ['user', 'assistant'] as const;
export type MemorySubject = (typeof MEMORY_SUBJECTS)[number];
/** Facts about the assistant recalled per message, beside the user's six. */
const SELF_RECALL_TOP = 3;

export type Memory = {
  id: number;
  kind: MemoryKind;
  subject: MemorySubject;
  content: string;
  source_conversation_id: number | null;
  created_at: string;
  updated_at: string;
  /**
   * A "for now" memory's last day (YYYY-MM-DD, server time zone): it rides on every reply until then,
   * and is rewritten as past afterwards (for-now.ts). NULL for lasting memories. Only the user's facts
   * have one: promoting a memory to always-remembered, or filing it under the assistant, clears it.
   */
  until: string | null;
  /**
   * The last day of a "for now" memory that has ended and not been reviewed yet (for-now.ts): the
   * Memories page lists it under "Ended" until the user keeps, edits or forgets it. Meanwhile it's an
   * ordinary memory. Cleared by `ended_on: null`, a new `until`, promotion or a move to the assistant.
   */
  ended_on: string | null;
};

const COLUMNS = 'id, kind, subject, content, source_conversation_id, created_at, updated_at, until, ended_on';

export const isMemoryKind = (value: unknown): value is MemoryKind =>
  typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
export const isMemorySubject = (value: unknown): value is MemorySubject =>
  typeof value === 'string' && (MEMORY_SUBJECTS as readonly string[]).includes(value);

export function listMemories(db: DB, userId: number): Memory[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM memories WHERE user_id = ? ORDER BY kind DESC, updated_at DESC, id DESC`)
    .all(userId) as Memory[];
}

export function getMemory(db: DB, userId: number, id: number): Memory | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ? AND user_id = ?`).get(id, userId) as Memory | undefined;
}

export function addMemory(
  db: DB,
  userId: number,
  kind: MemoryKind,
  content: string,
  sourceConversationId: number | null = null,
  subject: MemorySubject = 'user',
  until: string | null = null,
): Memory {
  const id = db
    .prepare('INSERT INTO memories (user_id, kind, content, source_conversation_id, subject, until) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, kind, content, sourceConversationId, subject, kind === 'fact' && subject === 'user' ? until : null).lastInsertRowid;
  return getMemory(db, userId, Number(id))!;
}

/**
 * New content clears the stored embedding; recall computes a fresh one on next use. `until` is kept
 * unless given (null makes the memory lasting), and only the user's facts keep one.
 */
export function updateMemory(
  db: DB,
  userId: number,
  id: number,
  change: { kind?: MemoryKind; content?: string; subject?: MemorySubject; until?: string | null; ended_on?: null },
): boolean {
  const current = getMemory(db, userId, id);
  if (!current) return false;
  const content = change.content ?? current.content;
  const kind = change.kind ?? current.kind;
  const subject = change.subject ?? current.subject;
  const ownFact = kind === 'fact' && subject === 'user';
  const until = ownFact ? (change.until !== undefined ? change.until : current.until) : null;
  // Reviewed (kept), for now again, promoted or moved: no longer waiting under "Ended".
  const endedOn = ownFact && change.ended_on !== null && !until ? current.ended_on : null;
  db.prepare(
    `UPDATE memories SET kind = ?, subject = ?, content = ?, until = ?, ended_on = ?, updated_at = datetime('now'),
       embedding = CASE WHEN content = ? THEN embedding ELSE NULL END
     WHERE id = ? AND user_id = ?`,
  ).run(kind, subject, content, until, endedOn, content, id, userId);
  return true;
}

export function deleteMemory(db: DB, userId: number, id: number): boolean {
  return db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// ── recall ─────────────────────────────────────────────────────────────────────
/** SQLite's UTC "YYYY-MM-DD HH:MM:SS" as the host's local date (en-CA formats as YYYY-MM-DD). */
const localDate = (sqliteUtc: string) => new Date(`${sqliteUtc.replace(' ', 'T')}Z`).toLocaleDateString('en-CA');

export const toBlob = (v: ArrayLike<number>) => Buffer.from(new Float32Array(v).buffer);
export const fromBlob = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * EmbeddingGemma's task prompts: stored text as documents, the message as a search query. Look-back
 * (lookback.ts) and memory recall both use them. On raw text a short message ("brb", "ok", "lol")
 * resembled everything: 18 filler messages pulled 88 made-up memories over the old 0.38 bar. With them,
 * filler scored 0.19-0.27.
 */
export const DOC_PREFIX = 'title: none | text: ';
export const QUERY_PREFIX = 'task: search result | query: ';

export type RecallOptions = { topK: number; minScore: number };
// With the prompts (2026-11-24; 25 made-up memories, 25 filler and 20 real messages): at 0.30 filler got
// 6 facts in all (one message, "same"), real messages 19, nearly all the fact they were about (a shrimp
// recipe → the shellfish allergy, "Maya has a recital" → she plays piano); 3 related-but-reworded ones got
// nothing (new tires vs the car). The old raw-text bar, 0.38, missed real matches with the prompts.
export const DEFAULT_RECALL: RecallOptions = { topK: 6, minScore: 0.3 };

export type ScoredFact = Memory & { score: number };

/**
 * The user's memories (optionally one kind) with their embedding vectors. Memories without one
 * (new or edited) are embedded here first, in one batch, and the vectors saved. Ceiling: a
 * linear scan over all of a user's memories, fine into the thousands; past that, add an index.
 * This is the raw-text vector, which near-duplicate detection and the extractor's closest memories
 * were measured on; recall has its own (`recall_embedding`, see `rankFacts`).
 */
export function withEmbeddings(
  db: DB,
  userId: number,
  embed: EmbedFn,
  kind?: MemoryKind,
  subject?: MemorySubject,
): Promise<(Memory & { vector: Float32Array })[]> {
  return embedded(db, userId, embed, 'embedding', '', kind, subject);
}

async function embedded(
  db: DB,
  userId: number,
  embed: EmbedFn,
  column: 'embedding' | 'recall_embedding',
  prefix: string,
  kind?: MemoryKind,
  subject?: MemorySubject,
): Promise<(Memory & { vector: Float32Array })[]> {
  const rows = db
    .prepare(`SELECT ${COLUMNS}, ${column} AS vec FROM memories WHERE user_id = ?${kind ? ' AND kind = ?' : ''}${subject ? ' AND subject = ?' : ''}`)
    .all(userId, ...(kind ? [kind] : []), ...(subject ? [subject] : [])) as (Memory & { vec: Buffer | null })[];
  const missing = rows.filter((r) => !r.vec);
  if (missing.length) {
    const vectors = await embed(missing.map((r) => prefix + r.content));
    const save = db.prepare(`UPDATE memories SET ${column} = ? WHERE id = ? AND user_id = ?`);
    db.transaction(() => {
      missing.forEach((r, i) => {
        r.vec = toBlob(vectors[i]!);
        save.run(r.vec, r.id, userId);
      });
    })();
  }
  return rows.map(({ vec, ...memory }) => ({ ...memory, vector: fromBlob(vec!) }));
}

/** The user's facts, about them and about the assistant (see `subject`), ranked by similarity to `query`. */
export async function rankFacts(db: DB, userId: number, query: string, embed: EmbedFn): Promise<ScoredFact[]> {
  // An image sent without words has nothing to recall by.
  if (!query.trim()) return [];
  // Facts as documents and the message as a search query (EmbeddingGemma's prompts): see DOC_PREFIX.
  const facts = await embedded(db, userId, embed, 'recall_embedding', DOC_PREFIX, 'fact');
  if (facts.length === 0) return [];
  const [q] = await embed([QUERY_PREFIX + query]);
  return facts
    .map(({ vector, ...memory }) => ({ ...memory, score: cosine(q!, vector) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Memory for one reply, in two parts so the start of the prompt stays stable between turns:
 * - `stable`: the always-remembered memories and how to use memories. It goes in the system
 *   prompt and changes rarely, so Ollama can reuse the cached start of the conversation.
 * - `recalled`: facts matched to this message. It changes every message, so it's attached to
 *   the newest message instead, where it only costs rereading that message. (Measured: with a
 *   changing system prompt every reply reread the whole ~7k-token chat, ~22 s; appended at the
 *   end, ~1 s.)
 * - `remembered`: those recalled facts' ids and text, for the "Remembered" line under the reply.
 * "For now" memories (a trip, a visit: `until` today or later) go in `recalled` too, on every reply,
 * since a new chat's "good evening" matches nothing about the trip it's sent from. The newest
 * message, not the system prompt: one added mid-chat would make the whole chat reread its prompt.
 * All are empty when the user has no memories.
 */
export type MemorySections = { stable: string; recalled: string; remembered: { id: number; content: string }[] };

export async function memoryContext(
  db: DB,
  user: { id: number; name: string },
  query: string,
  embed: EmbedFn,
  budgetTokens: number,
  opts: RecallOptions = DEFAULT_RECALL,
  today: string = localDay(),
): Promise<MemorySections> {
  const all = listMemories(db, user.id);
  const { about } = getPersona(db, user.id);
  if (all.length === 0 && !about) return { stable: '', recalled: '', remembered: [] };
  const theirs = all.filter((m) => m.subject === 'user');
  const self = all.filter((m) => m.subject === 'assistant');
  // Newest-changed first (listMemories' order), so a trip that was just extended stays in.
  const forNow = theirs.filter((m) => m.kind === 'fact' && isForNow(m.until, today)).slice(0, MAX_ACTIVE_FOR_NOW);
  const riding = new Set(forNow.map((m) => m.id));
  let facts: ScoredFact[] = [];
  try {
    if (all.some((m) => m.kind === 'fact' && !riding.has(m.id)))
      facts = (await rankFacts(db, user.id, query, embed)).filter((f) => f.score >= opts.minScore && !riding.has(f.id));
  } catch (err) {
    // Recall is a nicety: if embedding fails, chat carries on with the profile alone.
    console.error('memory recall failed:', err instanceof Error ? err.message : err);
  }

  // The user's own memories first; what the assistant knows about itself gets what's left.
  let used = 0;
  const take = (items: Memory[]) =>
    items.filter((m) => {
      const cost = estimateTokens(m.content);
      if (used + cost > budgetTokens) return false;
      used += cost;
      return true;
    });
  const keptProfile = take(theirs.filter((m) => m.kind === 'profile'));
  const keptSelfProfile = take(self.filter((m) => m.kind === 'profile'));
  const keptForNow = take(forNow);
  const keptFacts = take(facts.filter((f) => f.subject === 'user').slice(0, opts.topK));
  const keptSelfFacts = take(facts.filter((f) => f.subject === 'assistant').slice(0, SELF_RECALL_TOP));

  const sections: string[] = [];
  // Who the assistant is to this user: what they wrote (persona.ts) and what was settled in chats.
  if (about || keptSelfProfile.length) {
    const who = ['## Who you are'];
    if (about) who.push('', about);
    if (keptSelfProfile.length) who.push('', ...keptSelfProfile.map((m) => `- ${m.content}`));
    who.push(
      '',
      `This is who you are with ${user.name}: they described you this way, or you settled it together in earlier chats. ` +
        "Speak from it naturally, without reciting it, and don't invent a past beyond it.",
    );
    sections.push(who.join('\n'));
  }
  if (theirs.length) {
    const stable = [`## What you remember about ${user.name}`];
    if (keptProfile.length) stable.push('', ...keptProfile.map((m) => `- ${m.content}`));
    stable.push(
      '',
      // "Notes" is the save_notes tool's word (chat-notes.ts): calling memories notes too made the model
      // describe the tool as a place for the user's preferences.
      `Today is ${today}. A message may start with things you remember from earlier ` +
        `chats. Use memories the way a friend would: let them shape your reply when they fit, and bring one up only ` +
        "when it helps. Don't list them back or announce that you remember something.",
    );
    sections.push(stable.join('\n'));
  }

  // The date comes from the database, so the model can say "last week" without guessing.
  const blocks: string[] = [];
  if (keptForNow.length) {
    blocks.push(
      [
        `[Going on in ${user.name}'s life for now, from your memory, until the date shown. ${user.name} didn't write this.]`,
        ...keptForNow.map((m) => `- ${m.content} (until ${m.until})`),
      ].join('\n'),
    );
  }
  if (keptFacts.length) {
    blocks.push(
      [
        `[From your memory of ${user.name}, possibly relevant here. ${user.name} didn't write these.]`,
        ...keptFacts.map((m) => `- ${m.content} (${localDate(m.created_at)})`),
      ].join('\n'),
    );
  }
  if (keptSelfFacts.length) {
    blocks.push(['[What you know about yourself, possibly relevant here.]', ...keptSelfFacts.map((m) => `- ${m.content}`)].join('\n'));
  }
  // The facts recalled for this message, for the "Remembered" line under the reply (never the
  // always-remembered or for-now ones, which ride on every reply).
  const remembered = [...keptFacts, ...keptSelfFacts].map(({ id, content }) => ({ id, content }));
  return { stable: sections.join('\n\n'), recalled: blocks.join('\n\n'), remembered };
}
