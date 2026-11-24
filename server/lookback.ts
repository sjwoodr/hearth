// Look-back: a long chat recalls its own folded-out past. Once older messages are folded into the
// summary (summarize.ts), a short "Latest" note and one topic line are all that stand for them, so a
// detail from two folds back is gone. This keeps them findable: once folded, each message is cut into
// pieces of a few hundred characters and embedded (`indexFolded`, in the background), and for each new
// message the earlier exchanges that match it best ride on it (`lookBack`), like recalled memories:
// on the newest message only, never stored, so the start of the prompt stays cached.
import type { DB } from './db.ts';
import { every } from './every.ts';
import { withImageText } from './images.ts';
import { cosine, fromBlob, toBlob } from './memories.ts';
import { job, lookBacks } from './metrics.ts';
import type { EmbedFn } from './ollama.ts';

/** The most characters in one embedded piece: a short paragraph, so one subject per vector. */
export const PIECE_CHARS = 500;

// Split at paragraphs, then lines, then sentences, then words; whatever is still too long is cut.
const LEVELS: [RegExp, string][] = [
  [/\n\s*\n/, '\n\n'],
  [/\n/, '\n'],
  [/(?<=[.!?…])\s+/, ' '],
  [/\s+/, ' '],
];

/** `text` as [separator before it, unit] pairs, each unit at most `max` characters. */
function units(text: string, max: number, level = 0, sep = '\n\n'): [string, string][] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= max) return [[sep, t]];
  if (level === LEVELS.length) {
    const cut: [string, string][] = [];
    for (let i = 0; i < t.length; i += max) cut.push([i ? '' : sep, t.slice(i, i + max)]);
    return cut;
  }
  const [pattern, inner] = LEVELS[level]!;
  return t.split(pattern).flatMap((part, i) => units(part, max, level + 1, i ? inner : sep));
}

/** Text cut into pieces of at most `max` characters, whole paragraphs where they fit, packed in order. */
export function pieces(text: string, max = PIECE_CHARS): string[] {
  const out: string[] = [];
  for (const [sep, unit] of units(text, max)) {
    const last = out.at(-1);
    if (last !== undefined && last.length + sep.length + unit.length <= max) out[out.length - 1] = last + sep + unit;
    else out.push(unit);
  }
  return out;
}

type Folded = { id: number; content: string; image_count: number; image_note: string | null; no_extraction: number };

/**
 * EmbeddingGemma's task prompts: stored pieces as documents, the newest message as a search query.
 * Without them "how do tides work?" matched "can you explain what brining does?" (0.58) about as
 * well as a real back-reference matched its exchange, because the two are worded alike; with them
 * new subjects scored 0.27-0.40 on a synthetic 186-message chat and back-references 0.46-0.68.
 */
export const DOC_PREFIX = 'title: none | text: ';
export const QUERY_PREFIX = 'task: search result | query: ';

/** Embeds at most this many pieces per request, so one call stays short (~16 ms a piece on paris). */
const EMBED_BATCH = 64;

/**
 * Indexes the chat's messages folded into its summary since the last call: whole messages, until about
 * `limit` pieces (at least one message). Returns how many pieces it stored. "[no extraction]" messages
 * are skipped, as the summary skips them. Only advances if nothing else indexed the chat meanwhile.
 */
export async function indexFolded(db: DB, conversationId: number, embed: EmbedFn, limit = 256): Promise<number> {
  const chat = db
    .prepare('SELECT summary_through_message_id AS through, lookback_through_message_id AS indexed FROM conversations WHERE id = ?')
    .get(conversationId) as { through: number; indexed: number } | undefined;
  if (!chat || chat.indexed >= chat.through) return 0;
  const messages = db
    .prepare(
      `SELECT id, content, image_count, image_note, no_extraction FROM messages
       WHERE conversation_id = ? AND id > ? AND id <= ? ORDER BY id`,
    )
    .all(conversationId, chat.indexed, chat.through) as Folded[];

  const todo: { messageId: number; text: string }[] = [];
  let upTo = chat.through;
  for (const m of messages) {
    if (todo.length >= limit) {
      upTo = m.id - 1;
      break;
    }
    if (m.no_extraction) continue;
    for (const text of pieces(withImageText(m.content, m.image_count, m.image_note))) todo.push({ messageId: m.id, text });
  }
  const vectors: number[][] = [];
  for (let i = 0; i < todo.length; i += EMBED_BATCH) vectors.push(...(await embed(todo.slice(i, i + EMBED_BATCH).map((p) => DOC_PREFIX + p.text))));

  return db.transaction(() => {
    const moved = db
      .prepare('UPDATE conversations SET lookback_through_message_id = ? WHERE id = ? AND lookback_through_message_id = ?')
      .run(upTo, conversationId, chat.indexed).changes;
    if (!moved) return 0;
    const insert = db.prepare('INSERT INTO message_pieces (message_id, conversation_id, text, embedding) VALUES (?, ?, ?, ?)');
    todo.forEach((p, i) => insert.run(p.messageId, conversationId, p.text, toBlob(vectors[i]!)));
    return todo.length;
  })();
}

/**
 * Indexes folded messages chat by chat, the most recently active first, about `perPass` pieces a
 * pass, so a deploy's backfill of old chats is spread over a few minutes. Stops a pass at the first
 * failure (the embedding model is down, most likely); the next pass tries again.
 */
export function createLookbackIndexer(db: DB, embed: EmbedFn, perPass = 256) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const chats = db
        .prepare(
          `SELECT id FROM conversations WHERE lookback_through_message_id < summary_through_message_id
           ORDER BY updated_at DESC, id DESC`,
        )
        .all() as { id: number }[];
      let left = perPass;
      for (const { id } of chats) {
        if (left <= 0) break;
        try {
          const stored = await indexFolded(db, id, embed, left);
          left -= Math.max(stored, 1);
          if (stored) {
            job('lookback', 'ok');
            console.log(`lookback: indexed ${stored} piece(s) of chat ${id}`);
          }
        } catch (err) {
          job('lookback', 'failed');
          console.error(`lookback: indexing chat ${id} failed:`, err instanceof Error ? err.message : err);
          break;
        }
      }
    } finally {
      running = false;
    }
  };
}

/** Every minute, in whichever process folds summaries (the worker, or hearth on its own). */
export function startLookbackIndexer(db: DB, embed: EmbedFn): () => void {
  return every(60_000, createLookbackIndexer(db, embed), { now: true, keepAlive: true });
}

export type LookBackOptions = {
  /** A piece must match the newest message at least this well (cosine) for its exchange to come back. */
  minScore: number;
  /** At most this many exchanges. */
  maxExchanges: number;
  /** And at most this many characters of excerpts in all. */
  maxChars: number;
};
// 0.45: above every new-subject message in the probe (best 0.40), below every back-reference (0.46+).
export const DEFAULT_LOOKBACK: LookBackOptions = { minScore: 0.45, maxExchanges: 3, maxChars: 2400 };
// Per exchange: the user's side, then the reply's best-matching pieces.
const USER_CHARS = 500;
const REPLY_CHARS = 1000;

type Piece = { messageId: number; text: string; score: number; index: number; of: number };
/** The block for the newest message, and the first message of each exchange in it (for the "Recalled" line). */
export type LookedBack = { text: string; recalled: number[] };
export const LOOKED_BACK_NOTHING: LookedBack = { text: '', recalled: [] };
type Line = { role: 'user' | 'assistant'; created_at: string; pieces: Piece[] };

/**
 * One message's best piece, plus its other pieces that match too, as many as fit in `cap`, in their
 * order; "…" marks what's left out. The best piece comes back even below the bar: the question an
 * answer matched, or the answer to a question that did.
 */
function excerpt(all: Piece[], cap: number, minScore: number): string {
  const chosen = new Set<Piece>();
  let used = 0;
  for (const p of [...all].sort((a, b) => b.score - a.score)) {
    if (chosen.size && (p.score < minScore || used + p.text.length > cap)) continue;
    chosen.add(p);
    used += p.text.length;
  }
  let out = '';
  let previous = -1;
  for (const p of all.filter((x) => chosen.has(x))) {
    out += p.index > previous + 1 ? (out ? '\n…\n' : '… ') : out ? '\n' : '';
    out += p.text;
    previous = p.index;
  }
  return previous < all[0]!.of - 1 ? `${out} …` : out;
}

const when = (sqliteUtc: string, timeZone?: string) =>
  new Date(`${sqliteUtc.replace(' ', 'T')}Z`).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });

/**
 * The earlier exchanges of this chat, out of what the prompt still shows, that match `query` (the
 * newest message), as a block for the newest message, with each exchange's first message id; nothing
 * when the chat has none indexed or none match. Scoped to the user's own chat. Throws if embedding
 * fails; `lookBackForPrompt` turns that into nothing.
 */
export async function lookBack(
  db: DB,
  user: { id: number; name: string },
  conversationId: number,
  query: string,
  embed: EmbedFn,
  opts: LookBackOptions = DEFAULT_LOOKBACK,
  timeZone?: string,
): Promise<LookedBack> {
  if (!query.trim()) return LOOKED_BACK_NOTHING;
  const chat = db.prepare('SELECT summary_through_message_id AS through FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, user.id) as
    | { through: number }
    | undefined;
  if (!chat) return LOOKED_BACK_NOTHING;
  const rows = db
    .prepare('SELECT message_id AS messageId, text, embedding FROM message_pieces WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as { messageId: number; text: string; embedding: Buffer }[];
  if (rows.length === 0) return LOOKED_BACK_NOTHING;
  const [q] = await embed([QUERY_PREFIX + query]);

  // The folded messages, each with the exchange it belongs to: the user message that opened it. Only
  // their pieces count: the newer ones are in the prompt already.
  const messages = db
    .prepare('SELECT id, role, created_at FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id')
    .all(conversationId, chat.through) as { id: number; role: 'user' | 'assistant'; created_at: string }[];
  const lines = new Map<number, Line & { exchange: number }>();
  let opened = 0;
  for (const m of messages) {
    if (m.role === 'user' || !opened) opened = m.id;
    lines.set(m.id, { role: m.role, created_at: m.created_at, pieces: [], exchange: opened });
  }
  for (const row of rows) {
    const line = lines.get(row.messageId);
    if (!line) continue;
    line.pieces.push({ messageId: row.messageId, text: row.text, score: cosine(q!, fromBlob(row.embedding)), index: line.pieces.length, of: 0 });
  }
  const exchanges = new Map<number, { score: number; lines: Line[] }>();
  for (const line of lines.values()) {
    if (line.pieces.length === 0) continue;
    for (const p of line.pieces) p.of = line.pieces.length;
    const exchange = exchanges.get(line.exchange) ?? { score: -1, lines: [] };
    exchange.lines.push(line);
    exchange.score = Math.max(exchange.score, ...line.pieces.map((p) => p.score));
    exchanges.set(line.exchange, exchange);
  }

  const picked: { start: number; text: string }[] = [];
  let used = 0;
  const ranked = [...exchanges.entries()].filter(([, x]) => x.score >= opts.minScore).sort((a, b) => b[1].score - a[1].score);
  for (const [start, x] of ranked) {
    if (picked.length >= opts.maxExchanges) break;
    const said = x.lines.map(
      (l) => `${l.role === 'user' ? user.name : 'You'}: ${excerpt(l.pieces, l.role === 'user' ? USER_CHARS : REPLY_CHARS, opts.minScore)}`,
    );
    const text = `(${when(x.lines[0]!.created_at, timeZone)})\n${said.join('\n')}`;
    if (picked.length && used + text.length > opts.maxChars) continue;
    picked.push({ start, text });
    used += text.length;
  }
  if (picked.length === 0) return LOOKED_BACK_NOTHING;
  picked.sort((a, b) => a.start - b.start);
  const text = [
    `[Earlier in this chat, from messages too old to show in full, possibly relevant to ${user.name}'s newest message. ` +
      'This is your memory of the conversation: use it only if it helps.]',
    ...picked.map((p) => p.text),
  ].join('\n\n');
  return { text, recalled: picked.map((p) => p.start) };
}

/** `lookBack` for a reply's prompt: counted, and nothing if it fails (a nicety, like memory recall). */
export async function lookBackForPrompt(
  db: DB,
  user: { id: number; name: string },
  conversationId: number,
  query: string,
  embed: EmbedFn,
): Promise<LookedBack> {
  try {
    const found = await lookBack(db, user, conversationId, query, embed);
    // Chats with nothing folded yet aren't counted: the counter is about long chats.
    if (found.text) lookBacks.inc({ outcome: 'attached' });
    else if (hasPieces(db, conversationId)) lookBacks.inc({ outcome: 'none' });
    return found;
  } catch (err) {
    lookBacks.inc({ outcome: 'failed' });
    console.error(`lookback: chat ${conversationId} failed:`, err instanceof Error ? err.message : err);
    return LOOKED_BACK_NOTHING;
  }
}

const hasPieces = (db: DB, conversationId: number) =>
  !!db.prepare('SELECT 1 FROM message_pieces WHERE conversation_id = ? LIMIT 1').get(conversationId);
