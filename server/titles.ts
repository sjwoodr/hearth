import type { JsonFn } from './ollama.ts';

const SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

/** Cleans a model-written title; undefined if nothing usable is left. */
export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’#*\s]+|["'“”‘’*.\s]+$/g, '')
    .trim();
  return title && title.length <= 60 ? title : undefined;
}

/** Writes a short title from a chat's first exchange. */
export function makeTitler(json: JsonFn) {
  return async (userMessage: string, reply: string): Promise<string | undefined> => {
    const raw = (await json(
      [
        {
          role: 'system',
          content:
            'Write a short title, 2 to 6 words, for a chat that begins with the exchange below. ' +
            'Name the topic, like a heading. No quotes, no trailing period, no emoji.',
        },
        { role: 'user', content: `User: ${userMessage.slice(0, 2000)}\n\nReply: ${reply.slice(0, 2000)}` },
      ],
      SCHEMA,
    )) as { title?: unknown };
    return cleanTitle(raw?.title);
  };
}
