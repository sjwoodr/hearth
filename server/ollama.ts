import { PreemptedError } from './busy.ts';
import { recordModelStats } from './metrics.ts';

/**
 * Where model calls go: Ollama itself (a URL), or the model gateway (URL and token). Calls always
 * carry X-Hearth-Priority and X-Hearth-User; Ollama ignores them, the gateway schedules by them.
 */
export type Endpoint = string | { url: string; token?: string };

const urlOf = (e: Endpoint) => (typeof e === 'string' ? e : e.url);

function headersFor(e: Endpoint, priority: 'reply' | 'background', userId?: number): Record<string, string> {
  const token = typeof e === 'string' ? undefined : e.token;
  return {
    'Content-Type': 'application/json',
    'X-Hearth-Priority': priority,
    ...(userId !== undefined ? { 'X-Hearth-User': String(userId) } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** The gateway's answer for a background call a reply preempted: 409 `{"error":"preempted"}`. */
const PREEMPTED = 'preempted';

/** A tool the model asked to use, as Ollama reports it. */
export type ToolCall = { id?: string; function: { name: string; arguments: Record<string, unknown> } };

/**
 * `images`: base64 PNG, JPEG or WebP, for a model that can see (Ollama's per-message field).
 * `tool_calls` rides on an assistant message that asked for a tool; a `tool` message carries the result.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: ToolCall[];
  tool_name?: string;
};

/**
 * `onThinking`: called as a thinking reply reasons, with the number of reasoning tokens so far.
 * `tools`: tool definitions the model may call; each call it makes is reported to `onToolCall`.
 */
export type ChatOptions = {
  onThinking?: (tokens: number) => void;
  tools?: object[];
  onToolCall?: (call: ToolCall) => void;
  /** For the scheduler: whose reply this is, so waiting replies take turns between users. */
  userId?: number;
  /** The scheduler calls this if the reply has to wait for a slot (position 1 = next). */
  onQueued?: (position: number) => void;
};

/** Streams a reply as text chunks. Aborting the signal stops generation. */
export type ChatFn = (messages: ChatMessage[], signal: AbortSignal, opts?: ChatOptions) => AsyncIterable<string>;

export type StreamLine = {
  error?: string;
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] };
  /** From the gateway only: this reply is waiting for a slot, at this position. */
  hearth?: { queued?: number };
};

// One line of a stream: the data to use, or nothing for a line that's only the gateway saying the
// reply is queued (reported to onQueued instead).
function parseLine(line: string, onQueued?: (position: number) => void): StreamLine | undefined {
  const data = JSON.parse(line) as StreamLine;
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  if (!data.hearth) return data;
  if (data.hearth.queued) onQueued?.(data.hearth.queued);
  return undefined;
}

/** Ollama streams one JSON object per line. */
export async function* readLines(body: ReadableStream<Uint8Array>, onQueued?: (position: number) => void): AsyncGenerator<StreamLine> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const data = line ? parseLine(line, onQueued) : undefined;
      if (data) yield data;
    }
  }
}

function startChat(endpoint: Endpoint, body: object, signal: AbortSignal, userId?: number) {
  return fetch(`${urlOf(endpoint)}/api/chat`, {
    method: 'POST',
    headers: headersFor(endpoint, 'reply', userId),
    body: JSON.stringify({ stream: true, ...body }),
    signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    return res.body;
  });
}

const withTools = (opts?: ChatOptions) => (opts?.tools?.length ? { tools: opts.tools } : {});

export function ollamaChat(endpoint: Endpoint, model: string, numCtx: number): ChatFn {
  return async function* (messages, signal, opts) {
    // think: false keeps chat snappy; the model otherwise reasons before every reply.
    const request = { model, messages, think: false, ...withTools(opts), options: { num_ctx: numCtx } };
    const body = await startChat(endpoint, request, signal, opts?.userId);
    for await (const data of readLines(body, opts?.onQueued)) {
      if (data.done) recordModelStats('reply', data);
      for (const call of data.message?.tool_calls ?? []) opts?.onToolCall?.(call);
      if (data.message?.content) yield data.message.content;
    }
  };
}

/**
 * A reply that reasons first, for at most `budget` reasoning tokens. Measured on the French bench:
 * a 200-token cap kept all of unlimited thinking's grading accuracy (40/40) while cutting the worst
 * case from over five minutes to 30 seconds. At the cap the model is stopped and asked to answer
 * straight away, with its reasoning so far passed back as notes. The reasoning itself is never
 * shown or stored.
 */
export function ollamaThinkingChat(endpoint: Endpoint, model: string, numCtx: number, budget: number): ChatFn {
  return async function* (messages, signal, opts) {
    const thinking = new AbortController();
    const stop = () => thinking.abort();
    signal.addEventListener('abort', stop);
    let notes = '';
    let tokens = 0;
    let cut = false;
    // Whether the model wrote anything or asked for a tool. Reasoning that stops short of the budget
    // with neither would otherwise end as an empty reply; it gets the same "answer now" turn as a cut.
    let answered = false;
    try {
      const body = await startChat(
        endpoint,
        { model, messages, think: true, ...withTools(opts), options: { num_ctx: numCtx } },
        thinking.signal,
        opts?.userId,
      );
      for await (const data of readLines(body, opts?.onQueued)) {
        if (data.done) recordModelStats('reply', data);
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
        for (const call of data.message?.tool_calls ?? []) {
          answered = true;
          opts?.onToolCall?.(call);
        }
        if (data.message?.content) {
          answered = true;
          yield data.message.content;
        }
      }
    } catch (err) {
      // Leaving the stream at the cap can throw while it shuts down; anything before the cap is real.
      if (!cut) throw err;
    } finally {
      signal.removeEventListener('abort', stop);
      thinking.abort();
    }
    if (answered && !cut) return;
    // "Reply now" alone made the model answer from memory instead of asking to search (and invent
    // specifics), so when tools are offered it's reminded it may still call one.
    const orTool = opts?.tools?.length ? ', or call a tool if you need one' : '';
    const answerNow: ChatMessage = {
      role: 'user',
      content: `(Your private reasoning so far, not shown to me:)\n${notes}\n\nThinking time is up. Reply to my last message now${orTool}.`,
    };
    // Through the gateway this is a second request, so it can wait for a slot again.
    yield* ollamaChat(endpoint, model, numCtx)([...messages, answerNow], signal, {
      tools: opts?.tools,
      onToolCall: opts?.onToolCall,
      userId: opts?.userId,
      onQueued: opts?.onQueued,
    });
  };
}

/**
 * Output cap for background JSON replies. The largest legitimate one (an extraction at its
 * 8 + 8 change limit) is about 1,400 tokens. Without a cap, schema-constrained output can loop:
 * one extraction ran 6,000 tokens until Node's fetch gave up at 5 minutes, holding the only slot.
 */
export const JSON_MAX_TOKENS = 2048;

/**
 * One non-streamed background reply: constrained to a JSON schema (Ollama's `format`) and parsed, or
 * with `schema` null, plain text. Use plain text for free prose: under a schema, a double quote the
 * model meant to open a quotation ("the band's \"engine\"") is taken as the end of the string, and the
 * text is silently cut there. That clipped a chat summary and two memories mid-sentence.
 */
export type JsonFn = (messages: ChatMessage[], schema: object | null, signal?: AbortSignal) => Promise<unknown>;

export function ollamaJson(endpoint: Endpoint, model: string, numCtx: number): JsonFn {
  return async (messages, schema, signal) => {
    const res = await fetch(`${urlOf(endpoint)}/api/chat`, {
      method: 'POST',
      headers: headersFor(endpoint, 'background'),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false,
        ...(schema ? { format: schema } : {}),
        options: { num_ctx: numCtx, temperature: 0.2, num_predict: JSON_MAX_TOKENS },
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      // The gateway preempted this for a reply: the same outcome as the in-process scheduler's.
      if (res.status === 409 && text.includes(`"${PREEMPTED}"`)) throw new PreemptedError();
      throw new Error(`Ollama returned ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { message?: { content?: string }; done_reason?: string } & Parameters<typeof recordModelStats>[1];
    recordModelStats('background', data);
    if (data.done_reason === 'length') throw new Error(`The model's reply hit the ${JSON_MAX_TOKENS}-token cap.`);
    const content = data.message?.content ?? '';
    return schema ? JSON.parse(content) : content;
  };
}

/** Embeds each text; vectors come back in input order. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export function ollamaEmbed(endpoint: Endpoint, model: string): EmbedFn {
  return async (texts) => {
    if (texts.length === 0) return [];
    const res = await fetch(`${urlOf(endpoint)}/api/embed`, {
      method: 'POST',
      headers: headersFor(endpoint, 'background'),
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed returned ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  };
}
