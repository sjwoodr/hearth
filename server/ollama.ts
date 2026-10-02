export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Called as a thinking reply reasons, with the number of reasoning tokens so far. */
export type ChatOptions = { onThinking?: (tokens: number) => void };

/** Streams a reply as text chunks. Aborting the signal stops generation. */
export type ChatFn = (messages: ChatMessage[], signal: AbortSignal, opts?: ChatOptions) => AsyncIterable<string>;

type StreamLine = { error?: string; message?: { content?: string; thinking?: string } };

/** Ollama streams one JSON object per line. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamLine> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const data = JSON.parse(line) as StreamLine;
      if (data.error) throw new Error(`Ollama: ${data.error}`);
      yield data;
    }
  }
}

function startChat(baseUrl: string, body: object, signal: AbortSignal) {
  return fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: true, ...body }),
    signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    return res.body;
  });
}

export function ollamaChat(baseUrl: string, model: string, numCtx: number): ChatFn {
  return async function* (messages, signal) {
    // think: false keeps chat snappy; the model otherwise reasons before every reply.
    const body = await startChat(baseUrl, { model, messages, think: false, options: { num_ctx: numCtx } }, signal);
    for await (const data of readLines(body)) if (data.message?.content) yield data.message.content;
  };
}

/**
 * A reply that reasons first, for at most `budget` reasoning tokens. Measured on the French bench:
 * a 200-token cap kept all of unlimited thinking's grading accuracy (40/40) while cutting the worst
 * case from over five minutes to 30 seconds. At the cap the model is stopped and asked to answer
 * straight away, with its reasoning so far passed back as notes. The reasoning itself is never
 * shown or stored.
 */
export function ollamaThinkingChat(baseUrl: string, model: string, numCtx: number, budget: number): ChatFn {
  return async function* (messages, signal, opts) {
    const thinking = new AbortController();
    const stop = () => thinking.abort();
    signal.addEventListener('abort', stop);
    let notes = '';
    let tokens = 0;
    let cut = false;
    try {
      const body = await startChat(baseUrl, { model, messages, think: true, options: { num_ctx: numCtx } }, thinking.signal);
      for await (const data of readLines(body)) {
        if (data.message?.thinking) {
          notes += data.message.thinking;
          // Counted on its own line: inside `opts?.onThinking?.(…)` the increment would be skipped
          // whenever there's no callback, and the budget with it.
          tokens++; // Ollama streams about one token per chunk
          opts?.onThinking?.(tokens);
          if (tokens >= budget) {
            cut = true;
            break;
          }
        }
        if (data.message?.content) yield data.message.content;
      }
    } catch (err) {
      // Leaving the stream at the cap can throw while it shuts down; anything before the cap is real.
      if (!cut) throw err;
    } finally {
      signal.removeEventListener('abort', stop);
      thinking.abort();
    }
    if (!cut) return;
    const answerNow: ChatMessage = {
      role: 'user',
      content: `(Your private reasoning so far, not shown to me:)\n${notes}\n\nThinking time is up. Reply to my last message now.`,
    };
    yield* ollamaChat(baseUrl, model, numCtx)([...messages, answerNow], signal);
  };
}

/**
 * Output cap for background JSON replies. The largest legitimate one (an extraction at its
 * 8 + 8 change limit) is about 1,400 tokens. Without a cap, schema-constrained output can loop:
 * one extraction ran 6,000 tokens until Node's fetch gave up at 5 minutes, holding the only slot.
 */
export const JSON_MAX_TOKENS = 2048;

/** One non-streamed reply constrained to a JSON schema (Ollama's `format`). */
export type JsonFn = (messages: ChatMessage[], schema: object, signal?: AbortSignal) => Promise<unknown>;

export function ollamaJson(baseUrl: string, model: string, numCtx: number): JsonFn {
  return async (messages, schema, signal) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false,
        format: schema,
        options: { num_ctx: numCtx, temperature: 0.2, num_predict: JSON_MAX_TOKENS },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string }; done_reason?: string };
    if (data.done_reason === 'length') throw new Error(`The model's JSON reply hit the ${JSON_MAX_TOKENS}-token cap.`);
    return JSON.parse(data.message?.content ?? '');
  };
}

/** Embeds each text; vectors come back in input order. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export function ollamaEmbed(baseUrl: string, model: string): EmbedFn {
  return async (texts) => {
    if (texts.length === 0) return [];
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed returned ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  };
}
