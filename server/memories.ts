// Memory queries for the web app and chat. Every function is scoped to one user.
import { estimateTokens } from './context.ts';
import type { DB } from './db.ts';
import type { EmbedFn } from './ollama.ts';

export const MEMORY_KINDS = ['profile', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MAX_MEMORY_CHARS = 300;

export type Memory = {
  id: number;
  kind: MemoryKind;
  content: string;
  source_conversation_id: number | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = 'id, kind, content, source_conversation_id, created_at, updated_at';

export const isMemoryKind = (value: unknown): value is MemoryKind =>
  typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);

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
): Memory {
  const id = db
    .prepare('INSERT INTO memories (user_id, kind, content, source_conversation_id) VALUES (?, ?, ?, ?)')
    .run(userId, kind, content, sourceConversationId).lastInsertRowid;
  return getMemory(db, userId, Number(id))!;
}

/** New content clears the stored embedding; recall computes a fresh one on next use. */
export function updateMemory(db: DB, userId: number, id: number, change: { kind?: MemoryKind; content?: string }): boolean {
  const current = getMemory(db, userId, id);
  if (!current) return false;
  const content = change.content ?? current.content;
  db.prepare(
    `UPDATE memories SET kind = ?, content = ?, updated_at = datetime('now'),
       embedding = CASE WHEN content = ? THEN embedding ELSE NULL END
     WHERE id = ? AND user_id = ?`,
  ).run(change.kind ?? current.kind, content, content, id, userId);
  return true;
}

export function deleteMemory(db: DB, userId: number, id: number): boolean {
  return db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// ── recall ─────────────────────────────────────────────────────────────────────
/** SQLite's UTC "YYYY-MM-DD HH:MM:SS" as the host's local date (en-CA formats as YYYY-MM-DD). */
const localDate = (sqliteUtc: string) => new Date(`${sqliteUtc.replace(' ', 'T')}Z`).toLocaleDateString('en-CA');

export const toBlob = (v: ArrayLike<number>) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

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

export type RecallOptions = { topK: number; minScore: number };
// Measured with embeddinggemma: related memory 0.44-0.61, unrelated 0.19-0.30.
export const DEFAULT_RECALL: RecallOptions = { topK: 6, minScore: 0.38 };

export type ScoredFact = Memory & { score: number };

/**
 * The user's memories (optionally one kind) with their embedding vectors. Memories without one
 * (new or edited) are embedded here first, in one batch, and the vectors saved. Ceiling: a
 * linear scan over all of a user's memories, fine into the thousands; past that, add an index.
 */
export async function withEmbeddings(
  db: DB,
  userId: number,
  embed: EmbedFn,
  kind?: MemoryKind,
): Promise<(Memory & { vector: Float32Array })[]> {
  const rows = db
    .prepare(`SELECT ${COLUMNS}, embedding FROM memories WHERE user_id = ?${kind ? ' AND kind = ?' : ''}`)
    .all(...(kind ? [userId, kind] : [userId])) as (Memory & { embedding: Buffer | null })[];
  const missing = rows.filter((r) => !r.embedding);
  if (missing.length) {
    const vectors = await embed(missing.map((r) => r.content));
    const save = db.prepare('UPDATE memories SET embedding = ? WHERE id = ? AND user_id = ?');
    db.transaction(() => {
      missing.forEach((r, i) => {
        r.embedding = toBlob(vectors[i]!);
        save.run(r.embedding, r.id, userId);
      });
    })();
  }
  return rows.map(({ embedding, ...memory }) => ({ ...memory, vector: fromBlob(embedding!) }));
}

/** The user's facts ranked by similarity to `query`. */
export async function rankFacts(db: DB, userId: number, query: string, embed: EmbedFn): Promise<ScoredFact[]> {
  const facts = await withEmbeddings(db, userId, embed, 'fact');
  if (facts.length === 0) return [];
  const [q] = await embed([query]);
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
 * Both are empty when the user has no memories.
 */
export type MemorySections = { stable: string; recalled: string };

export async function memoryContext(
  db: DB,
  user: { id: number; name: string },
  query: string,
  embed: EmbedFn,
  budgetTokens: number,
  opts: RecallOptions = DEFAULT_RECALL,
): Promise<MemorySections> {
  const all = listMemories(db, user.id);
  if (all.length === 0) return { stable: '', recalled: '' };
  const profile = all.filter((m) => m.kind === 'profile');
  let facts: ScoredFact[] = [];
  try {
    facts = (await rankFacts(db, user.id, query, embed)).filter((f) => f.score >= opts.minScore).slice(0, opts.topK);
  } catch (err) {
    // Recall is a nicety: if embedding fails, chat carries on with the profile alone.
    console.error('memory recall failed:', err instanceof Error ? err.message : err);
  }

  let used = 0;
  const take = (items: Memory[]) =>
    items.filter((m) => {
      const cost = estimateTokens(m.content);
      if (used + cost > budgetTokens) return false;
      used += cost;
      return true;
    });
  const keptProfile = take(profile);
  const keptFacts = take(facts);

  const stable = [`## What you remember about ${user.name}`];
  if (keptProfile.length) stable.push('', ...keptProfile.map((m) => `- ${m.content}`));
  stable.push(
    '',
    `Today is ${new Date().toLocaleDateString('en-CA')}. A message may start with notes from your memory of earlier ` +
      `chats. Use memories the way a friend would: let them shape your reply when they fit, and bring one up only ` +
      "when it helps. Don't list them back or announce that you remember something.",
  );

  // The date comes from the database, so the model can say "last week" without guessing.
  const recalled = keptFacts.length
    ? [
        `[Notes from your memory, possibly relevant here. ${user.name} didn't write these.]`,
        ...keptFacts.map((m) => `- ${m.content} (${localDate(m.created_at)})`),
      ].join('\n')
    : '';
  return { stable: stable.join('\n'), recalled };
}
