// Private chats: nothing is written to the database, so nothing is remembered, summarized, titled,
// searchable or backed up. The browser holds the transcript and sends it with every message; the
// server builds the prompt, streams the reply and forgets it. A search card waits in server memory
// only (one per private chat, for an hour), so a restart drops it and Retry asks again.
import type { PendingSearch, Source } from './web-search.ts';

/** A private chat's id, made by the browser: random, so one user's chats can't be guessed by another. */
export const PRIVATE_CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;

export const MAX_PRIVATE_MESSAGES = 400;
// Replies run longer than what a person types; a few long ones are fine, a pasted book is not.
const MAX_REPLY_CHARS = 64_000;
const MAX_HISTORY_CHARS = 1_000_000;
const MAX_SOURCES = 20;

export type PrivateMessage = { role: 'user' | 'assistant'; content: string; imageCount: number; sources: Source[] | null };

const isWebUrl = (url: unknown): url is string => {
  if (typeof url !== 'string' || url.length > 2000) return false;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

function parseSources(value: unknown): Source[] | null {
  if (!Array.isArray(value)) return null;
  const sources = value
    .filter((s) => isWebUrl(s?.url))
    .slice(0, MAX_SOURCES)
    .map((s) => ({ title: typeof s.title === 'string' ? s.title.slice(0, 200) : s.url, url: s.url as string }));
  return sources.length ? sources : null;
}

/**
 * A private chat's history as the browser sent it, checked like anything else from a client: only
 * user and assistant turns (never a system message), bounded sizes, and ending with the user's
 * message to answer. Faking an assistant turn only fools the sender's own chat.
 */
export function parsePrivateHistory(value: unknown, maxUserChars: number): { messages: PrivateMessage[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: 'A private chat needs its messages.' };
  if (value.length > MAX_PRIVATE_MESSAGES) return { error: `A private chat can send at most ${MAX_PRIVATE_MESSAGES} messages.` };
  const messages: PrivateMessage[] = [];
  let total = 0;
  for (const m of value) {
    if (m?.role !== 'user' && m?.role !== 'assistant') return { error: 'Messages must be from the user or the assistant.' };
    if (typeof m.content !== 'string') return { error: 'Each message needs its text.' };
    const max = m.role === 'user' ? maxUserChars : MAX_REPLY_CHARS;
    if (m.content.length > max) return { error: `A message is too long (max ${max} characters).` };
    total += m.content.length;
    const imageCount = Number.isInteger(m.imageCount) && m.imageCount > 0 ? Math.min(m.imageCount, 4) : 0;
    messages.push({ role: m.role, content: m.content, imageCount, sources: m.role === 'assistant' ? parseSources(m.sources) : null });
  }
  if (total > MAX_HISTORY_CHARS) return { error: 'This private chat is too long to send. Start a new one.' };
  if (messages.at(-1)!.role !== 'user') return { error: 'The last message must be yours.' };
  return { messages };
}

/** How long a private chat's search card stays answerable. */
export const PRIVATE_SEARCH_TTL_MS = 60 * 60 * 1000;
const MAX_PRIVATE_SEARCHES = 100;

/**
 * Search requests waiting in private chats, in memory only. Unlike stored chats' (web-search.ts),
 * these may hold image bytes: nothing here reaches the disk. Keyed by user and chat.
 */
export class PrivateSearches {
  #waiting = new Map<string, PendingSearch>();
  #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  set(key: string, search: Omit<PendingSearch, 'askedAt'>) {
    this.#expire();
    this.#waiting.delete(key);
    this.#waiting.set(key, { ...search, askedAt: this.#now() });
    // Oldest first (a Map keeps insertion order).
    for (const k of this.#waiting.keys()) {
      if (this.#waiting.size <= MAX_PRIVATE_SEARCHES) break;
      this.#waiting.delete(k);
    }
  }

  /** Removes and returns the chat's request, so a double tap can't run it twice. */
  take(key: string, userId: number): PendingSearch | undefined {
    this.#expire();
    const search = this.#waiting.get(key);
    if (search?.userId !== userId) return undefined;
    this.#waiting.delete(key);
    return search;
  }

  forget(key: string) {
    this.#waiting.delete(key);
  }

  #expire() {
    const cutoff = this.#now().getTime() - PRIVATE_SEARCH_TTL_MS;
    for (const [k, s] of this.#waiting) if (s.askedAt.getTime() <= cutoff) this.#waiting.delete(k);
  }
}
