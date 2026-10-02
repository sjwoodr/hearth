// Images pasted into a chat. They are never stored: the model sees an image with the message it
// came with, then describes it in the background (cheaply, while that conversation is still in
// Ollama's cache), and from then on the description stands in for it everywhere. Until it is
// described, the image waits in server memory only, so a retry or a re-answer with thinking can
// still see it. A restart loses undescribed images; the message then says so.
import { isPreempted } from './busy.ts';
import { setImageNote } from './conversations.ts';
import type { DB } from './db.ts';
import type { ChatMessage, JsonFn } from './ollama.ts';

export const MAX_IMAGES = 4;
// After decoding. The client shrinks images to about 1600px JPEG first (a few hundred KB).
export const MAX_IMAGE_BYTES = 3_000_000;
// Measured with Gemma 4 26B-A4B in Ollama: 512px 123 tokens, 1024px 258, 2048×1536 268. Ollama
// scales larger images down, so the cost tops out near here; about 3.5 s to encode on the 780M.
export const IMAGE_TOKENS = 280;
// Undescribed images held in memory, by message. Beyond this the oldest are dropped.
const MAX_PENDING_MESSAGES = 8;
const MAX_ATTEMPTS = 3;
const MAX_NOTE_CHARS = 6000;

const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

/**
 * The images of a posted message, as base64 for Ollama. Accepts plain base64 or data URLs, and
 * only PNG, JPEG or WebP judged by their bytes, never by what the client says they are.
 */
export function parseImages(value: unknown): { images: string[] } | { error: string } {
  if (value === undefined || value === null) return { images: [] };
  if (!Array.isArray(value)) return { error: 'Images must be a list.' };
  if (value.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} images per message.` };
  const images: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { error: 'Each image must be base64 text.' };
    const base64 = item.replace(/^data:[\w/+.-]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: 'An image is not valid base64.' };
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) return { error: `Images must be under ${MAX_IMAGE_BYTES / 1_000_000} MB each.` };
    if (!SIGNATURES.some(([, matches]) => matches(bytes))) return { error: 'Images must be PNG, JPEG or WebP.' };
    images.push(base64);
  }
  return { images };
}

/** A stored message as background jobs read it. */
export type MessageRow = { id: number; role: string; content: string; image_count: number; image_note: string | null };

/** What text-only readers (history, summaries, memory extraction) see in place of a message's images. */
export function withImageText(content: string, imageCount: number, imageNote: string | null): string {
  if (imageCount === 0) return content;
  const images = imageCount === 1 ? 'an image' : `${imageCount} images`;
  const text = imageNote ? `[Attached ${images}, described:\n${imageNote}]` : `[Attached ${images}, no longer available]`;
  return content ? `${text}\n\n${content}` : text;
}

const DESCRIBE =
  'For the record (this reply is not shown to me): transcribe all text in the image(s) in my last message ' +
  'exactly as written, keeping every spelling, accent and grammar mistake, and describe briefly what else ' +
  'they show. This replaces the images in our conversation from now on.';
const DESCRIBE_ALONE =
  'Transcribe all text in these images exactly as written, keeping every spelling, accent and grammar ' +
  'mistake, and describe briefly what else they show.';

const SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, description: { type: 'string' } },
  required: ['text', 'description'],
};

/**
 * Describing right after the reply, as a continuation of the same prompt, lets Ollama reuse what it
 * just read (only the reply and the request are new). Older images, whose prompt has moved on, are
 * described on their own.
 */
export const describeAfterReply = (prompt: ChatMessage[], reply: string): ChatMessage[] => [
  ...prompt,
  { role: 'assistant', content: reply },
  { role: 'user', content: DESCRIBE },
];
export const describeAlone = (images: string[]): ChatMessage[] => [{ role: 'user', content: DESCRIBE_ALONE, images }];

/** Runs a describe request and turns the answer into the stored description. */
export function makeImageDescriber(json: JsonFn) {
  return async (messages: ChatMessage[]): Promise<string> => {
    const raw = (await json(messages, SCHEMA)) as { text?: unknown; description?: unknown };
    const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    const note = [description, text && `Text in the image:\n${text}`].filter(Boolean).join('\n\n');
    if (!note) throw new Error('The model returned an empty image description.');
    return note.slice(0, MAX_NOTE_CHARS);
  };
}

type Pending = { conversationId: number; images: string[]; described: boolean; attempts: number; busy: boolean };

/** Images waiting in memory, by message id. Message ids are only ever looked up for the owner's messages. */
export class PendingImages {
  #byMessage = new Map<number, Pending>();

  add(messageId: number, conversationId: number, images: string[]): void {
    this.#byMessage.set(messageId, { conversationId, images, described: false, attempts: 0, busy: false });
    while (this.#byMessage.size > MAX_PENDING_MESSAGES) {
      const oldest = [...this.#byMessage].find(([, p]) => p.described && !p.busy) ?? this.#byMessage.entries().next().value!;
      this.#byMessage.delete(oldest[0]);
    }
  }

  get(messageId: number): Pending | undefined {
    return this.#byMessage.get(messageId);
  }

  /** Undescribed images in a chat, oldest first, not already being described. */
  waiting(conversationId: number): [number, Pending][] {
    return [...this.#byMessage].filter(([, p]) => p.conversationId === conversationId && !p.described && !p.busy);
  }

  /** A new message moves the chat on: images already described are no longer needed. */
  moveOn(conversationId: number): void {
    this.#drop((p) => p.conversationId === conversationId && p.described);
  }

  #drop(matches: (p: Pending) => boolean): void {
    for (const [id, p] of this.#byMessage) if (matches(p)) this.#byMessage.delete(id);
  }

  forget(conversationId: number): void {
    this.#drop((p) => p.conversationId === conversationId);
  }

  /** A failed attempt (not a preemption). Returns true when it's time to give up on these images. */
  failed(messageId: number): boolean {
    const p = this.#byMessage.get(messageId);
    if (!p) return true;
    if (++p.attempts < MAX_ATTEMPTS) return false;
    this.#byMessage.delete(messageId);
    return true;
  }
}

/**
 * After a reply, describes the chat's images still waiting in memory, in the background. The ones
 * just answered are described as a continuation of the prompt Ollama still has cached; any left
 * over (preempted or failed earlier) on their own. Failures retry after the chat's next reply.
 */
export function describeWaitingImages(
  db: DB,
  pending: PendingImages,
  describe: (messages: ChatMessage[]) => Promise<string>,
  turn: { conversationId: number; answeredId: number; prompt: ChatMessage[]; reply: string },
): void {
  const waiting = pending.waiting(turn.conversationId);
  for (const [, p] of waiting) p.busy = true;
  void (async () => {
    for (const [messageId, p] of waiting) {
      const onPrompt = messageId === turn.answeredId && turn.prompt.at(-1)?.images === p.images;
      try {
        const request = onPrompt ? describeAfterReply(turn.prompt, turn.reply) : describeAlone(p.images);
        setImageNote(db, messageId, await describe(request));
        p.described = true;
      } catch (err) {
        if (isPreempted(err)) console.log(`images: message ${messageId} paused for a chat reply`);
        else {
          const gaveUp = pending.failed(messageId);
          const why = err instanceof Error ? err.message : err;
          console.error(`images: message ${messageId} failed${gaveUp ? ', giving up' : ''}:`, why);
        }
      } finally {
        p.busy = false;
      }
    }
  })();
}
