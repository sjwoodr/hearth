// Memory extraction: reads the unread part of a conversation and records durable facts
// about the user. Runs in the background once a chat has gone quiet.
import { every } from './every.ts';
import { assistantNameFor } from './persona.ts';
import { job } from './metrics.ts';
import { estimateTokens } from './context.ts';
import { isPreempted } from './busy.ts';
import type { DB } from './db.ts';
import { withImageText, type MessageRow } from './images.ts';
import { cosine, MAX_MEMORY_CHARS, toBlob, withEmbeddings, type MemoryKind } from './memories.ts';
import type { EmbedFn, JsonFn } from './ollama.ts';
import { cleanDisplayName, MAX_DISPLAY_NAME_CHARS } from './users.ts';
import { addDays, calendarDay, dayWithWeekday, FOR_NOW_DEFAULT_DAYS, localDay, MAX_FOR_NOW_DAYS } from '../shared/for-now.ts';
import { rewriteEnded } from './for-now.ts';

const MAX_CHANGES = 8;
/** How many of the user's memories the extractor is shown: past this, the ones closest to the chat. */
export const MAX_EXISTING_SHOWN = 80;
const TRANSCRIPT_BUDGET_TOKENS = 4500;

// The limits bound the grammar so the model can't loop on items or one endless string. Lengths
// are twice the stored limit: a string the grammar cuts off is over the limit and gets dropped by
// sanitizeExtraction, rather than saved as a truncated fact. The pattern stops a stray double
// quote from ending a fact early (see JsonFn): with no raw quote allowed and a closing punctuation
// mark required, the string can only end where the sentence does. Ollama enforces patterns.
const CONTENT = { type: 'string', maxLength: 2 * MAX_MEMORY_CHARS, pattern: String.raw`^[^"\\\n]*[.!?)]$` };
/** A "for now" memory's last day (shared/for-now.ts); left out for lasting ones. */
const UNTIL = { type: 'string', pattern: String.raw`^\d{4}-\d{2}-\d{2}$` };

export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      maxItems: MAX_CHANGES,
      items: { type: 'object', properties: { content: CONTENT, until: UNTIL }, required: ['content'] },
    },
    update: {
      type: 'array',
      maxItems: MAX_CHANGES,
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, content: CONTENT, until: UNTIL },
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
  /** `until`: a "for now" memory's last day, after today and within MAX_FOR_NOW_DAYS. */
  add: { content: string; until?: string }[];
  /** `until` only for a memory that is already "for now" (a trip extended): never makes a lasting one expire. */
  update: { id: number; content: string; until?: string }[];
  /** A name the user explicitly asked to be called, if any. */
  name?: string;
};

type Existing = { id: number; kind: MemoryKind; content: string; until?: string | null };

/**
 * The user's memories the extractor sees, newest-changed first. Up to MAX_EXISTING_SHOWN that's all of
 * them. Past it, the always-remembered ones and then the facts closest to the chat (each scored by its
 * best match against any message read), so a correction finds the memory it corrects however old it
 * is: shown only the newest 80, a correction to an older one became a second, contradicting memory.
 * If embedding fails, the newest-changed are shown instead.
 */
async function memoriesToShow(db: DB, userId: number, said: string[], embed?: EmbedFn): Promise<Existing[]> {
  const all = db
    .prepare(`SELECT id, kind, content, until FROM memories WHERE user_id = ? AND subject = 'user' ORDER BY updated_at DESC, id DESC`)
    .all(userId) as Existing[];
  if (all.length <= MAX_EXISTING_SHOWN) return all;
  const newest = all.slice(0, MAX_EXISTING_SHOWN);
  if (!embed || said.length === 0) return newest;
  try {
    const stored = await withEmbeddings(db, userId, embed, undefined, 'user');
    const vectors = await embed(said);
    const score = new Map(stored.map((m) => [m.id, Math.max(...vectors.map((v) => cosine(v, m.vector)))]));
    const rank = (m: Existing) => (m.kind === 'profile' ? 2 : (score.get(m.id) ?? -1));
    const shown = new Set([...all].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_EXISTING_SHOWN).map((m) => m.id));
    return all.filter((m) => shown.has(m.id));
  } catch (err) {
    if (isPreempted(err)) throw err;
    console.error('memory: matching memories to the chat failed, showing the newest:', err instanceof Error ? err.message : err);
    return newest;
  }
}

/**
 * Keeps only well-formed changes: known kinds, non-empty text within the length limit,
 * updates to memories this user actually has, no duplicate additions, a capped count.
 * A new "for now" memory must end at least two days out: one ending today or tomorrow was only
 * about the day (the prompt says so, yet "dentist appointment tomorrow" became "for now" until
 * tomorrow 3/3 in a probe), so that addition is dropped; one past MAX_FOR_NOW_DAYS isn't "for now", so it
 * loses the date and is judged as a lasting memory. An update may move the end date only of a
 * memory that already has one; if it leaves "until" out but names a later day in its words ("…, now
 * extended until 2026-12-02"), that day is the new end (the model did that 3/3 in a probe).
 */
export function sanitizeExtraction(raw: unknown, existing: Existing[], today: string = localDay()): Extraction {
  const out: Extraction = { add: [], update: [] };
  if (!raw || typeof raw !== 'object') return out;
  const { add, update, name } = raw as { add?: unknown; update?: unknown; name?: unknown };
  const cleanName = cleanDisplayName(name);
  if (cleanName) out.name = cleanName;
  const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const known = new Map(existing.map((m) => [m.id, m]));
  const seen = new Set(existing.map((m) => m.content.toLowerCase()));
  const latest = addDays(today, MAX_FOR_NOW_DAYS);
  const endOf = (item: unknown) => calendarDay((item as { until?: unknown } | null)?.until);

  for (const item of Array.isArray(add) ? add : []) {
    const content = clean(item?.content);
    if (!content || content.length > MAX_MEMORY_CHARS) continue;
    if (seen.has(content.toLowerCase())) continue;
    const until = endOf(item);
    if (until && until <= addDays(today, 1)) continue;
    seen.add(content.toLowerCase());
    out.add.push(until && until <= latest ? { content, until } : { content });
    if (out.add.length === MAX_CHANGES) break;
  }
  const updated = new Set<number>();
  for (const item of Array.isArray(update) ? update : []) {
    const content = clean(item?.content);
    const current = known.get(item?.id);
    if (!current || updated.has(current.id) || !content || content.length > MAX_MEMORY_CHARS) continue;
    const named = (content.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).map(calendarDay).filter((d): d is string => !!d);
    const until = endOf(item) ?? (named.length ? named.sort().at(-1) : undefined);
    const moved = current.until && until && until > today && until <= latest && until !== current.until ? until : undefined;
    if (content === current.content && !moved) continue;
    updated.add(current.id);
    out.update.push(moved ? { id: current.id, content, until: moved } : { id: current.id, content });
    if (out.update.length === MAX_CHANGES) break;
  }
  return out;
}

/** The next two weeks as "Thursday 2026-11-26, Friday 2026-11-27, …", so "back Thursday" maps to a date. */
const calendar = (today: string) =>
  Array.from({ length: 14 }, (_, i) => dayWithWeekday(addDays(today, i + 1))).join(', ');

function instructions(username: string, assistant: string, today: string): string {
  return `You maintain the long-term memory of a chat companion called ${assistant}, about its user ${username}.
Read the new conversation and decide what is worth remembering in future chats.

Record only what ${username} said or clearly implied about themselves: preferences, likes and
dislikes, hobbies, ongoing projects, goals, what they are learning, people and pets they mention.
Never record what ${assistant} said, general knowledge, guesses, or one-off small talk.

- An instruction about a single reply ("keep it short", "answer in French") is not a lasting
  preference. Record it only if ${username} says it applies from now on.
- Each thing gets exactly one memory. Never add a memory that restates another one, new or
  existing, in different words.
- Before adding a memory, check the existing ones for the same subject (the same habit, object,
  person or project). If one exists, do not add: update that memory by its id, rewriting it to
  include the new or corrected detail. Use "add" only for a subject no existing memory covers.
- If ${username} corrects something ${assistant} said about them, rewrite the memory behind it so the
  mistake can't happen again.
- Write each memory as one short, specific sentence in the third person, using the name ${username}.
  Don't include dates; hearth records when each memory was learned.
- Leave out what only matters on the day (tonight's plans, what ${username} is doing or watching right
  now, a score): keep only the part that will still be true next month, or record nothing.
- The exception is a situation that lasts several days or weeks and then ends: a trip or vacation,
  someone visiting, being ill, a busy stretch before a deadline. Record it as one memory and set
  "until" to its last day (YYYY-MM-DD); if ${username} doesn't say when it ends, use
  ${addDays(today, FOR_NOW_DEFAULT_DAYS)}. What ${username} likes or does during it (a favourite spot on
  the trip, who is visiting) goes in that memory too: in the one you add if it's new, or by updating
  it if it's already in the existing memories. If it now ends on another day (extended, cut short),
  update it with the new "until". Tonight's plans and anything over by tomorrow are not one of these.
  Hobbies, what they are learning, pets, family, their job and ongoing projects have no end: leave
  "until" out of those and of every other memory.
- Dates for "until": today is ${dayWithWeekday(today)}; then ${calendar(today)}.
- If nothing is worth remembering, return empty lists.
- "name": only if ${username} explicitly tells you their name or what to call them ("I'm Sam",
  "call me Sam"), put just that name here. Otherwise leave it empty. Never guess.`;
}

// Measured with embeddinggemma: rewordings of one fact scored 0.86-0.94, but different facts on
// the same topic scored up to 0.91 (French vs Spanish 0.886, druid vs paladin 0.905). Similarity
// alone can't tell them apart, so it only picks candidates and the model makes the call
// (9 of 10 right on those pairs, erring toward keeping).
export const NEAR_DUPLICATE_CANDIDATE = 0.85;
// An addition next to an update in the same batch is often that update restated on its own
// (a correction saved twice): those pairs scored 0.77-0.83, under the bar above, so a memory
// updated in this batch is checked from a lower one.
export const UPDATED_CANDIDATE = 0.7;
const MAX_CANDIDATES_CHECKED = 3;
const SAME_SCHEMA = { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'] };

const LASTING_SCHEMA = { type: 'object', properties: { lasting: { type: 'boolean' } }, required: ['lasting'] };
const TEMPORARY_SCHEMA = { type: 'object', properties: { temporary: { type: 'boolean' } }, required: ['temporary'] };

/**
 * Whether a memory the extractor marked "for now" really describes something that will be over within
 * weeks. Probe (2026-11-25, live model, made-up chats x3): the prompt alone gave "has been learning
 * ukulele since the summer" an end date 3/3, and a dog 1/3; such a memory would be rewritten as past
 * a week later. Judged on the memory alone, like isLasting.
 */
export async function isTemporary(json: JsonFn, username: string, memory: string): Promise<boolean> {
  const raw = (await json(
    [
      {
        role: 'system',
        content:
          `You check one memory about ${username} that a chat companion will keep only for a few days or weeks, then ` +
          'file away as something that happened. Answer temporary=true if what it describes will be over within weeks: ' +
          'a trip or vacation, a visit, an illness or recovery, a deadline or busy stretch, an event they are preparing ' +
          'for. Answer temporary=false if it is an ongoing part of their life: a hobby, something they are learning, a ' +
          'pet, family, their job, where they live, a taste or habit, a long-running project.',
      },
      { role: 'user', content: `MEMORY: ${memory}` },
    ],
    TEMPORARY_SCHEMA,
  )) as { temporary?: unknown };
  return raw?.temporary === true;
}

/**
 * Whether `memory` will still be true and worth knowing in a month. Live chats about a game became
 * "is currently watching UCF vs. BYU, tied 24-24 in the 4th quarter", "is going to a game tonight
 * with seats in row 2" and "notes it is still dark at 6:30 am"; a result hearth got wrong
 * ("BYU won 28-24") was saved and then updated with more play-by-play. Judged on the memory alone,
 * so the call is short. Applied to additions and updates; any failure keeps the memory.
 */
export async function isLasting(json: JsonFn, username: string, memory: string): Promise<boolean> {
  const raw = (await json(
    [
      {
        role: 'system',
        content:
          `You check one memory about ${username} that a chat companion will keep for months. Answer lasting=true ` +
          'if it will probably still be true and worth knowing a month from now: who they are, family, friends and ' +
          'pets, where they live, likes and dislikes, teams they support, habits, opinions, skills, what they are ' +
          'learning, ongoing projects and goals, plans or situations that run for weeks or longer, and stories ' +
          'from their past (a trip, someone they met). Answer ' +
          'lasting=false if it is only about one moment or one day: what they are doing, watching or feeling right ' +
          "now, today's or tonight's plans, the weather or the time of day, or the score, result or play-by-play of a " +
          'single game or event. If part of it is lasting, answer true.',
      },
      { role: 'user', content: `MEMORY: ${memory}` },
    ],
    LASTING_SCHEMA,
  )) as { lasting?: unknown };
  return raw?.lasting !== false;
}

/** A yes/no check that keeps the memory when it fails (other than a preemption, which abandons the run). */
async function keptIfFails(what: string, check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (err) {
    if (isPreempted(err)) throw err;
    console.error(`memory: ${what} check failed, keeping it:`, err instanceof Error ? err.message : err);
    return true;
  }
}

const STATED_SCHEMA = { type: 'object', properties: { stated: { type: 'boolean' } }, required: ['stated'] };

/**
 * Whether the user actually said `candidate` about themselves in this conversation. A lone lookup
 * ("who is the Jaguars' quarterback?", follow-up "he played at Clemson, right?") became "interested in
 * the Jaguars" in about 1 of 5 extractions of that real chat; a rule in the main prompt didn't change
 * the rate. A narrow yes/no on each new memory is the check.
 */
export async function statedByUser(
  json: JsonFn,
  username: string,
  transcript: string,
  candidate: string,
  assistant = 'hearth',
): Promise<boolean> {
  const raw = (await json(
    [
      {
        role: 'system',
        content:
          `You check one memory about ${username} against the conversation it came from. Answer stated=true only if ` +
          `${username} said it, or clearly implied it, about themselves: a fact, a preference, an interest, a plan. ` +
          `Answer stated=false if it rests only on a question ${username} asked, on something ${assistant} said, or on a guess. ` +
          'Asking about a team, a product or a person is not an interest in it.',
      },
      { role: 'user', content: `CONVERSATION:\n${transcript}\n\nMEMORY: ${candidate}` },
    ],
    STATED_SCHEMA,
  )) as { stated?: unknown };
  return raw?.stated !== false;
}

export async function saysTheSame(json: JsonFn, existing: string, candidate: string): Promise<boolean> {
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

type NewMemory = { content: string; until?: string; vector?: ArrayLike<number> };

/**
 * Drops additions that reword a memory the user already has, one updated in this batch, or one
 * added earlier in the batch. Any failure keeps the memory: a duplicate is cheaper than a lost fact.
 */
async function dropNearDuplicates(
  db: DB,
  userId: number,
  adds: { content: string; until?: string }[],
  updates: { content: string }[],
  json: JsonFn,
  embed: EmbedFn,
): Promise<{ kept: NewMemory[]; skipped: number }> {
  if (adds.length === 0) return { kept: [], skipped: 0 };
  let existing: { content: string; vector: ArrayLike<number>; bar: number }[];
  let vectors: number[][];
  try {
    const stored = await withEmbeddings(db, userId, embed, undefined, 'user');
    vectors = await embed([...adds, ...updates].map((a) => a.content));
    existing = [
      ...stored.map((m) => ({ ...m, bar: NEAR_DUPLICATE_CANDIDATE })),
      ...updates.map((u, i) => ({ content: u.content, vector: vectors[adds.length + i]!, bar: UPDATED_CANDIDATE })),
    ];
  } catch (err) {
    console.error('memory: near-duplicate check skipped:', err instanceof Error ? err.message : err);
    return { kept: adds, skipped: 0 };
  }

  const kept: (NewMemory & { vector: ArrayLike<number> })[] = [];
  let skipped = 0;
  for (const [i, add] of adds.entries()) {
    const vector = vectors[i]!;
    const candidates = [...existing, ...kept.map((m) => ({ ...m, bar: NEAR_DUPLICATE_CANDIDATE }))]
      .map((m) => ({ content: m.content, score: cosine(vector, m.vector), bar: m.bar }))
      .filter((m) => m.score >= m.bar)
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
    else kept.push({ ...add, vector });
  }
  return { kept, skipped };
}

// ── what the user established about the assistant ────────────────────────────────────────────────
// Its own pass after the user's memories, so that measured extraction is untouched. Only what the
// user set becomes canon: the assistant's improvised claims about itself ("I grew up near Lyon")
// would otherwise come back in every chat as lore. So every proposed fact is checked against the
// conversation, and unlike the user's memories, a failed check drops it.

const SELF_SCHEMA = { type: 'object', properties: { facts: { type: 'array', maxItems: 5, items: CONTENT } }, required: ['facts'] };
const ESTABLISHED_SCHEMA = { type: 'object', properties: { established: { type: 'boolean' } }, required: ['established'] };
/** As close as a rewording gets (the user's near-duplicate candidates start at 0.85 too); persona facts don't get a judge. */
const SELF_DUPLICATE_SCORE = 0.85;

/** What the user established about the assistant in a conversation, as short sentences naming it. */
export async function selfFacts(json: JsonFn, username: string, assistant: string, transcript: string, known: string[]): Promise<string[]> {
  const raw = (await json(
    [
      {
        role: 'system',
        content:
          `You keep the character sheet of ${assistant}, a chat companion, as its user ${username} has shaped it. From the ` +
          `conversation, list what ${username} established about ${assistant} itself: a name or nickname they gave it, a ` +
          `backstory, how they picture it, its personality, a role they gave it, a running joke about it. Only what ` +
          `${username} set themselves, or explicitly confirmed when ${assistant} offered it ("yes, that's you now"). A polite ` +
          `reaction to something ${assistant} made up ("nice", "that sounds lovely") is not agreeing to it. Never what ` +
          `${assistant} said about itself on its own, never facts about ` +
          `${username} (those are kept elsewhere), and never what only matters today. Leave out what the sheet already has. ` +
          `Write each as a plain fact about ${assistant} that starts with its name ("${assistant} grew up in Lyon."), not as who said it. ` +
          'Most conversations establish nothing: then return an empty list.',
      },
      {
        role: 'user',
        content: `Character sheet so far:\n${known.length ? known.map((k) => `- ${k}`).join('\n') : '(empty)'}\n\nConversation:\n${transcript}`,
      },
    ],
    SELF_SCHEMA,
  )) as { facts?: unknown };
  const facts = Array.isArray(raw?.facts) ? raw.facts : [];
  return facts
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.replace(/\s+/g, ' ').trim())
    .filter((f) => f.length > 0 && f.length <= MAX_MEMORY_CHARS)
    .slice(0, 5);
}

/** Whether the user set this about the assistant, rather than the assistant claiming it on its own. */
export async function establishedByUser(json: JsonFn, username: string, assistant: string, transcript: string, candidate: string): Promise<boolean> {
  const raw = (await json(
    [
      {
        role: 'system',
        content:
          `You check one note about ${assistant}, a chat companion, against the conversation it came from. Answer ` +
          `established=true only if ${username} said it or asked for it, or explicitly confirmed it when ${assistant} offered ` +
          `it: a name, a backstory, a look or a trait they gave ${assistant}. Answer established=false if ${assistant} brought ` +
          `it up and ${username} only reacted ("nice", "that sounds lovely"), if only ${assistant} claimed it, if it is really ` +
          `about ${username}, or if it only matters today.`,
      },
      { role: 'user', content: `CONVERSATION:\n${transcript}\n\nNOTE: ${candidate}` },
    ],
    ESTABLISHED_SCHEMA,
  )) as { established?: unknown };
  return raw?.established === true;
}

/** A yes/no check that drops the fact when it fails (other than a preemption, which abandons the run). */
async function droppedIfFails(what: string, check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (err) {
    if (isPreempted(err)) throw err;
    console.error(`memory: ${what} check failed, dropping it:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** New facts about the assistant, minus rewordings of what's known (and of each other), with their vectors. */
async function newSelfFacts(db: DB, userId: number, facts: string[], embed?: EmbedFn): Promise<NewMemory[]> {
  if (facts.length === 0) return [];
  if (!embed) {
    const known = new Set((db.prepare("SELECT content FROM memories WHERE user_id = ? AND subject = 'assistant'").all(userId) as { content: string }[]).map((r) => r.content));
    return facts.filter((f, i) => !known.has(f) && facts.indexOf(f) === i).map((content) => ({ content }));
  }
  const stored = await withEmbeddings(db, userId, embed, undefined, 'assistant');
  const vectors = await embed(facts);
  const kept: NewMemory[] = [];
  facts.forEach((content, i) => {
    const vector = vectors[i]!;
    const seen = [...stored.map((m) => m.vector), ...kept.map((k) => k.vector!)];
    if (!seen.some((v) => cosine(v, vector) >= SELF_DUPLICATE_SCORE)) kept.push({ content, vector });
  });
  return kept;
}

export type ExtractResult = {
  conversationId: number;
  read: number;
  added: number;
  /** How many of those were "for now" (shared/for-now.ts). */
  forNow: number;
  updated: number;
  /** Additions dropped as rewordings of an existing memory. */
  duplicates: number;
  /** Additions dropped because the user never said them about themselves (a lookup, a guess). */
  unstated: number;
  /** Additions dropped, and updates not made, because they were about one moment (a live score, tonight). */
  fleeting: number;
  named: boolean;
  /** Facts about the assistant the user established (persona.ts), added as memories about it. */
  self: number;
};

/**
 * `embed` enables the near-duplicate check; without it only exact duplicates are skipped.
 * `assistant` is the name the assistant answers to (HEARTH_ASSISTANT_NAME). `today` (server time
 * zone) is what "for now" end dates are worked out from.
 */
export async function extractMemories(
  db: DB,
  conversationId: number,
  json: JsonFn,
  embed?: EmbedFn,
  assistant = 'hearth',
  today: string = localDay(),
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
  // The name this user's assistant answers to (persona.ts), as the replies in the transcript use it.
  assistant = assistantNameFor(db, conversation.user_id, assistant);

  const since = db
    .prepare(
      'SELECT id, role, content, image_count, image_note, no_extraction FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id',
    )
    .all(conversation.id, conversation.memory_through_message_id) as (MessageRow & { no_extraction: number })[];
  const none = { conversationId, read: 0, added: 0, forNow: 0, updated: 0, duplicates: 0, unstated: 0, fleeting: 0, named: false, self: 0 };
  if (since.length === 0) return none;
  const lastId = since.at(-1)!.id;
  // A message the user started with "[no extraction]", and its reply, are never read (by either pass),
  // but the chat is still marked read past them.
  const unread = since.filter((m) => m.no_extraction === 0);
  if (unread.length === 0) {
    db.prepare('UPDATE conversations SET memory_through_message_id = ? WHERE id = ?').run(lastId, conversation.id);
    return none;
  }

  // Newest first until the budget runs out, so a very long chat keeps its latest turns.
  let used = 0;
  const transcript: string[] = [];
  // The same messages without who said them: what memories are matched against.
  const said: string[] = [];
  for (let i = unread.length - 1; i >= 0; i--) {
    const m = unread[i]!;
    const text = withImageText(m.content, m.image_count, m.image_note);
    const line = `${m.role === 'user' ? conversation.username : assistant}: ${text}`;
    used += estimateTokens(line);
    if (used > TRANSCRIPT_BUDGET_TOKENS && transcript.length > 0) break;
    transcript.unshift(line);
    said.unshift(text);
  }

  const existing = await memoriesToShow(db, conversation.user_id, said, embed);
  const existingText = existing.length
    ? existing
        .map((m) => `[${m.id}] (${m.kind}${m.until ? `, until ${m.until}` : ''}) ${m.content}`)
        .join('\n')
    : '(none yet)';

  const raw = await json(
    [
      { role: 'system', content: instructions(conversation.username, assistant, today) },
      {
        role: 'user',
        content: `Existing memories:\n${existingText}\n\nNew conversation:\n${transcript.join('\n\n')}`,
      },
    ],
    EXTRACTION_SCHEMA,
  );
  const changes = sanitizeExtraction(raw, existing, today);
  const named = changes.name !== undefined && conversation.display_name === null;
  // Each new memory must outlast the day, then be something the user said about themselves, not a
  // question they asked. Updates are only checked for lasting: they rewrite a memory the user
  // already has, and a fleeting one leaves it as it was. Any failure keeps the memory. A "for now"
  // memory isn't asked whether it lasts a month (it doesn't, by design): its end date, after
  // today, is its check (sanitizeExtraction).
  const { username } = conversation;
  const forNowIds = new Set(existing.filter((m) => m.until).map((m) => m.id));
  const stated: { content: string; until?: string }[] = [];
  let unstated = 0;
  let fleeting = 0;
  for (const add of changes.add) {
    // Not really temporary (or the check failed): it's judged as a lasting memory, without an end.
    // A lasting fact filed away as past a week later is the worse error than a trip recalled only when relevant.
    if (add.until) {
      let temporary = false;
      try {
        temporary = await isTemporary(json, username, add.content);
      } catch (err) {
        if (isPreempted(err)) throw err;
        console.error('memory: temporary check failed, keeping it as lasting:', err instanceof Error ? err.message : err);
      }
      if (!temporary) delete add.until;
    }
    if (!add.until && !(await keptIfFails('lasting', () => isLasting(json, username, add.content)))) fleeting++;
    else if (await keptIfFails('stated', () => statedByUser(json, username, transcript.join('\n\n'), add.content, assistant))) stated.push(add);
    else unstated++;
  }
  const updates: Extraction['update'] = [];
  for (const u of changes.update) {
    if (forNowIds.has(u.id) || (await keptIfFails('lasting', () => isLasting(json, username, u.content)))) updates.push(u);
    else fleeting++;
  }
  const { kept, skipped } = embed
    ? await dropNearDuplicates(db, conversation.user_id, stated, updates, json, embed)
    : { kept: stated as NewMemory[], skipped: 0 };

  // Then what the user established about the assistant, which is written with the rest below (or
  // not at all, if anything is preempted). Any other failure skips it for this window.
  let selfKept: NewMemory[] = [];
  try {
    const conversationText = transcript.join('\n\n');
    const known = (
      db.prepare("SELECT content FROM memories WHERE user_id = ? AND subject = 'assistant' ORDER BY id").all(conversation.user_id) as { content: string }[]
    ).map((r) => r.content);
    const proposed = await selfFacts(json, username, assistant, conversationText, known);
    const established: string[] = [];
    for (const fact of proposed) {
      if (await droppedIfFails('established', () => establishedByUser(json, username, assistant, conversationText, fact))) established.push(fact);
    }
    selfKept = await newSelfFacts(db, conversation.user_id, established, embed);
  } catch (err) {
    if (isPreempted(err)) throw err;
    console.error(`memory: chat ${conversationId}: facts about the assistant skipped:`, err instanceof Error ? err.message : err);
  }

  db.transaction(() => {
    const insert = db.prepare(
      'INSERT INTO memories (user_id, kind, content, source_conversation_id, embedding, until) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const a of kept) {
      insert.run(conversation.user_id, 'fact', a.content, conversation.id, a.vector ? toBlob(a.vector) : null, a.until ?? null);
    }
    const insertSelf = db.prepare(
      "INSERT INTO memories (user_id, kind, content, source_conversation_id, embedding, subject) VALUES (?, 'fact', ?, ?, ?, 'assistant')",
    );
    for (const f of selfKept) insertSelf.run(conversation.user_id, f.content, conversation.id, f.vector ? toBlob(f.vector) : null);
    const update = db.prepare(
      "UPDATE memories SET content = ?, until = coalesce(?, until), embedding = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND subject = 'user'",
    );
    for (const u of updates) update.run(u.content, u.until ?? null, u.id, conversation.user_id);
    db.prepare('UPDATE conversations SET memory_through_message_id = ? WHERE id = ?').run(lastId, conversation.id);
    // A learned name only fills a blank; it never replaces one someone set.
    if (named) db.prepare('UPDATE users SET display_name = ? WHERE id = ? AND display_name IS NULL').run(changes.name, conversation.user_id);
  })();

  return {
    conversationId,
    read: unread.length,
    added: kept.length,
    forNow: kept.filter((a) => a.until).length,
    updated: updates.length,
    duplicates: skipped,
    unstated,
    fleeting,
    named,
    self: selfKept.length,
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
  opts: { paused?: () => boolean; now?: () => number; assistant?: string } = {},
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  const retryAt = new Map<number, number>();
  let running = false;
  return async () => {
    if (running || opts.paused?.()) return;
    running = true;
    try {
      // "For now" memories past their last day become ordinary ones first (for-now.ts).
      try {
        await rewriteEnded(db, json);
      } catch (err) {
        if (isPreempted(err)) return;
        console.error('memory: ended "for now" memories:', err instanceof Error ? err.message : err);
      }
      for (const id of conversationsReadyForExtraction(db, idleMinutes)) {
        if ((retryAt.get(id) ?? 0) > now()) continue;
        if (opts.paused?.()) return;
        const started = Date.now();
        const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
        console.log(`memory: reading chat ${id} (${unreadCount(db, id)} new message(s))…`);
        try {
          const r = await extractMemories(db, id, json, embed, opts.assistant);
          retryAt.delete(id);
          job('memory', 'ok');
          console.log(
            `memory: chat ${id} done in ${secs()}: read ${r.read}, added ${r.added} (${r.forNow} for now), updated ${r.updated}, ` +
              `skipped ${r.duplicates} duplicate(s), ${r.unstated} not said by the user, ${r.fleeting} only for the day`,
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
  opts: { paused?: () => boolean; assistant?: string } = {},
): () => void {
  return every(60_000, createSweep(db, json, embed, idleMinutes, opts));
}
