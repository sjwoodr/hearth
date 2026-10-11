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

/** A model name, or a function giving the one to use now (an admin can switch it while hearth runs). */
export type ModelName = string | (() => string);
const nameOf = (m: ModelName) => (typeof m === 'function' ? m() : m);

/**
 * `think` for a reply that shouldn't reason. gpt-oss can't turn reasoning off: with `false` its answer
 * comes back empty (measured 2026-10-10), so it gets its lowest level instead.
 */
export const fastThink = (model: string): false | 'low' => (model.startsWith('gpt-oss') ? 'low' : false);

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
  /** For a thinking reply: this request's reasoning cap (its Think effort), instead of the default. */
  thinkingBudget?: number;
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

export function ollamaChat(endpoint: Endpoint, model: ModelName, numCtx: number): ChatFn {
  return async function* (messages, signal, opts) {
    const name = nameOf(model);
    // think: false keeps chat snappy; the model otherwise reasons before every reply.
    const request = { model: name, messages, think: fastThink(name), ...withTools(opts), options: { num_ctx: numCtx } };
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
export function ollamaThinkingChat(endpoint: Endpoint, model: ModelName, numCtx: number, defaultBudget: number): ChatFn {
  return async function* (messages, signal, opts) {
    // Resolved once, so the reasoning and the answer after a cut come from the same model.
    const name = nameOf(model);
    const budget = opts?.thinkingBudget ?? defaultBudget;
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
        { model: name, messages, think: true, ...withTools(opts), options: { num_ctx: numCtx } },
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
    yield* ollamaChat(endpoint, name, numCtx)([...messages, answerNow], signal, {
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

export function ollamaJson(endpoint: Endpoint, model: ModelName, numCtx: number): JsonFn {
  return async (messages, schema, signal) => {
    const name = nameOf(model);
    const res = await fetch(`${urlOf(endpoint)}/api/chat`, {
      method: 'POST',
      headers: headersFor(endpoint, 'background'),
      body: JSON.stringify({
        model: name,
        messages,
        stream: false,
        think: fastThink(name),
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

/**
 * Whether Ollama has `model` in memory, from its /api/ps (the gateway passes it through). Ollama
 * unloads an idle model after OLLAMA_KEEP_ALIVE, and loading it again takes ~15 s. Undefined when
 * it can't tell (no answer within a second, an error): callers then say nothing.
 */
export function ollamaModelLoaded(endpoint: Endpoint): (model: string) => Promise<boolean | undefined> {
  // Ollama lists "name:tag"; a configured name without a tag means ":latest".
  const tagged = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return async (model) => {
    try {
      const res = await fetch(`${urlOf(endpoint)}/api/ps`, { headers: headersFor(endpoint, 'reply'), signal: AbortSignal.timeout(1000) });
      if (!res.ok) return undefined;
      const { models = [] } = (await res.json()) as { models?: { name?: string; model?: string }[] };
      return models.some((m) => m.name === tagged(model) || m.model === tagged(model));
    } catch {
      return undefined;
    }
  };
}

/** A chat model Ollama has: never an embedding model, which can't hold a conversation. */
export type ModelInfo = { name: string; size: number; parameterSize?: string; quantization?: string; capabilities: string[] };

/**
 * The chat models Ollama has pulled, from /api/tags plus each one's /api/show capabilities (both
 * pass through the gateway). Capabilities are cached by digest, so a re-pulled tag is asked again.
 */
export function ollamaModels(endpoint: Endpoint): { list(): Promise<ModelInfo[]>; capabilities(name: string): Promise<string[] | undefined> } {
  const shown = new Map<string, string[]>();
  async function capabilitiesOf(name: string, digest = ''): Promise<string[]> {
    const key = `${name}@${digest}`;
    const cached = shown.get(key);
    if (cached) return cached;
    const res = await fetch(`${urlOf(endpoint)}/api/show`, {
      method: 'POST',
      headers: headersFor(endpoint, 'reply'),
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Ollama /api/show returned ${res.status} for ${name}`);
    const caps = ((await res.json()) as { capabilities?: string[] }).capabilities ?? [];
    shown.set(key, caps);
    return caps;
  }
  async function list(): Promise<ModelInfo[]> {
    const res = await fetch(`${urlOf(endpoint)}/api/tags`, { headers: headersFor(endpoint, 'reply'), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
    const { models = [] } = (await res.json()) as {
      models?: { name: string; size: number; digest?: string; details?: { parameter_size?: string; quantization_level?: string } }[];
    };
    const all = await Promise.all(
      models.map(async (m) => ({
        name: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
        capabilities: await capabilitiesOf(m.name, m.digest),
      })),
    );
    return all.filter((m) => m.capabilities.includes('completion') && !m.capabilities.includes('embedding')).sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    list,
    async capabilities(name) {
      try {
        return await capabilitiesOf(name);
      } catch {
        return undefined;
      }
    },
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
