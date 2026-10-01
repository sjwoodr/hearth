import type { Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import { fitHistory } from './context.ts';
import {
  addMessage,
  createConversation,
  deleteConversation,
  deleteMessage,
  getContextState,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
  setAutoTitle,
  titleFrom,
} from './conversations.ts';
import { isPreempted } from './busy.ts';
import { SELF_CORRECTION, shouldThink, type ThinkDecision } from './think-router.ts';
import type { DB } from './db.ts';
import type { MemorySections } from './memories.ts';
import type { ChatFn, ChatMessage } from './ollama.ts';
import { searchMessages } from './search.ts';
import type { SessionUser } from './sessions.ts';

export type ChatDeps = {
  db: DB;
  chat: ChatFn;
  /** The same job with thinking on, used when the client asks for it (the Think toggle). */
  thinkingChat?: ChatFn;
  systemPrompt: () => string;
  numCtx: number;
  /** Memory for this user and message: a stable part for the system prompt, and facts recalled for this message. */
  memoryContext: (user: SessionUser, message: string) => Promise<MemorySections>;
  /** Extra context held back when thinking: the reasoning budget, plus the notes it's handed back as. */
  thinkingReserve?: number;
  /** A model-written title for a chat's first exchange. */
  titleFor?: (userMessage: string, reply: string) => Promise<string | undefined>;
  /** Called after each saved reply, for background work such as summarizing long chats. */
  afterReply?: (conversationId: number) => void;
  /** True while another chat reply is being generated, so this one will queue. */
  replyActive?: () => boolean;
  /** Cancels background model work so this reply goes first. */
  preemptBackground?: () => void;
};

// Context tokens held back for the reply itself.
const REPLY_RESERVE = 1024;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TITLE_CHARS = 120;

type Env = { Variables: { user: SessionUser } };

const parseId = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * The client's Think setting: true (always), false (never) or "auto", where the rules in
 * think-router.ts decide from the message and the reply before it.
 */
function decideThinking(setting: unknown, message: string, previousReply: string | undefined) {
  if (setting === true) return { think: true, auto: false };
  if (setting === 'auto') return { ...shouldThink(message, previousReply), auto: true };
  return { think: false, auto: false };
}

export function registerChatRoutes(api: Hono<Env>, deps: ChatDeps): void {
  const { db, chat, systemPrompt, numCtx, memoryContext } = deps;
  const notFound = { error: 'Chat not found.' };

  api.get('/conversations', (c) => c.json(listConversations(db, c.get('user').id)));

  api.get('/search', (c) => c.json(searchMessages(db, c.get('user').id, (c.req.query('q') ?? '').slice(0, 200))));

  api.post('/conversations', (c) => c.json(createConversation(db, c.get('user').id), 201));

  api.get('/conversations/:id', (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, userId, id) : undefined;
    if (!conversation) return c.json(notFound, 404);
    return c.json({ conversation, messages: listMessages(db, userId, conversation.id) });
  });

  api.patch('/conversations/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > MAX_TITLE_CHARS) {
      return c.json({ error: `Title must be 1-${MAX_TITLE_CHARS} characters.` }, 400);
    }
    const id = parseId(c.req.param('id'));
    if (!id || !renameConversation(db, c.get('user').id, id, title)) return c.json(notFound, 404);
    return c.json({ ok: true });
  });

  api.delete('/conversations/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (!id || !deleteConversation(db, c.get('user').id, id)) return c.json(notFound, 404);
    return c.json({ ok: true });
  });

  // The prompt for a reply to the chat's latest message. Ordered so the start stays the same from
  // turn to turn (personality, always-remembered memories, the running summary, older history),
  // which lets Ollama reuse its cache and read only what's new. The facts recalled for this message
  // change every time, so they ride on the newest message, in the prompt only; the stored message
  // is left as written.
  async function buildPrompt(user: SessionUser, conversationId: number, latest: string, think = false): Promise<ChatMessage[]> {
    const state = getContextState(db, conversationId);
    const history: ChatMessage[] = listMessages(db, user.id, conversationId)
      .filter((m) => m.id > state.summary_through_message_id)
      .map(({ role, content }) => ({ role, content }));
    const { stable, recalled } = await memoryContext(user, latest);
    const last = history.at(-1);
    if (recalled && last?.role === 'user') {
      history[history.length - 1] = { role: 'user', content: `${recalled}\n\n[${user.name}'s message]\n${last.content}` };
    }
    const earlier = state.summary ? `## Earlier in this conversation\n\n${state.summary}` : '';
    const system = [systemPrompt(), stable, earlier].filter(Boolean).join('\n\n');
    const reserve = REPLY_RESERVE + (think ? (deps.thinkingReserve ?? 0) : 0);
    return fitHistory(system, history, numCtx - reserve);
  }

  // Streams a reply as NDJSON: start, optional queued, delta..., then done or error, and after
  // a chat's first reply, title.
  function streamReply(
    c: Context<Env>,
    conversationId: number,
    prompt: ChatMessage[],
    opts: { userMessageId: number; firstMessage?: string; decision: ThinkDecision & { auto: boolean } },
  ) {
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return stream(c, async (s) => {
      const controller = new AbortController();
      s.onAbort(() => controller.abort());
      // One queue for every write: thinking progress arrives from a callback while text streams.
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: object) => (writes = writes.then(() => s.write(`${JSON.stringify(event)}\n`)));
      const think = opts.decision.think && !!deps.thinkingChat;
      const generate = think ? deps.thinkingChat! : chat;
      let lastReported = 0;
      const onThinking = (tokens: number) => {
        // Enough to show progress without an event per token.
        if (tokens === 1 || tokens - lastReported >= 10) {
          lastReported = tokens;
          void send({ type: 'thinking', tokens });
        }
      };

      await send({
        type: 'start',
        userMessageId: opts.userMessageId,
        think,
        // Why Auto chose to think, so the client can say so.
        ...(think && opts.decision.auto && opts.decision.reason ? { reason: opts.decision.reason } : {}),
      });
      // Background jobs yield to chat; only another reply makes this one wait. Ceiling: other
      // Ollama clients are invisible here.
      const queued = deps.replyActive?.() ?? false;
      deps.preemptBackground?.();
      if (queued) await send({ type: 'queued' });
      let reply = '';
      try {
        for await (const text of generate(prompt, controller.signal, { onThinking })) {
          reply += text;
          await send({ type: 'delta', text });
        }
        if (!reply.trim()) throw new Error('The model returned an empty reply.');
        const messageId = addMessage(db, conversationId, 'assistant', reply);
        // A fast reply that caught itself mid-answer ("wait, no, that's wrong") is worth re-asking with thinking.
        await send({ type: 'done', messageId, ...(!think && SELF_CORRECTION.test(reply) ? { selfCorrected: true } : {}) });
      } catch (err) {
        // Stopped or failed mid-reply: keep what was generated so the chat reads as it happened.
        if (reply.trim()) addMessage(db, conversationId, 'assistant', reply);
        if (!controller.signal.aborted) {
          await send({ type: 'error', error: err instanceof Error ? err.message : 'Generation failed.' });
        }
        return;
      }

      if (opts.firstMessage && deps.titleFor && !controller.signal.aborted) {
        try {
          const title = await deps.titleFor(opts.firstMessage, reply);
          if (title && setAutoTitle(db, conversationId, title)) await send({ type: 'title', title });
        } catch (err) {
          // The first-message title stays; a failed or preempted title isn't worth an error.
          if (!isPreempted(err)) console.error(`title: chat ${conversationId} failed:`, err instanceof Error ? err.message : err);
        }
      }
      deps.afterReply?.(conversationId);
    });
  }

  api.post('/conversations/:id/messages', async (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, user.id, id) : undefined;
    if (!conversation) return c.json(notFound, 404);

    const body = await c.req.json().catch(() => null);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) return c.json({ error: 'Message is empty.' }, 400);
    if (content.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` }, 400);
    }

    const earlier = listMessages(db, user.id, conversation.id);
    const isFirst = earlier.length === 0;
    const decision = decideThinking(body?.think, content, earlier.findLast((m) => m.role === 'assistant')?.content);
    const userMessageId = addMessage(db, conversation.id, 'user', content);
    if (!conversation.title) setAutoTitle(db, conversation.id, titleFrom(content));
    const prompt = await buildPrompt(user, conversation.id, content, decision.think);
    return streamReply(c, conversation.id, prompt, { userMessageId, firstMessage: isFirst ? content : undefined, decision });
  });

  // Regenerates the reply to the latest user message, replacing the last reply if there is one
  // (a failed, stopped or unwanted answer).
  api.post('/conversations/:id/retry', async (c) => {
    const body = await c.req.json().catch(() => null);
    const user = c.get('user');
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, user.id, id) : undefined;
    if (!conversation) return c.json(notFound, 404);

    const messages = listMessages(db, user.id, conversation.id);
    const last = messages.at(-1);
    const question = last?.role === 'assistant' ? messages.at(-2) : last;
    if (!question || question.role !== 'user') return c.json({ error: 'There is no message to retry.' }, 400);
    if (last!.role === 'assistant') deleteMessage(db, conversation.id, last!.id);

    const before = messages.slice(0, messages.indexOf(question));
    const decision = decideThinking(body?.think, question.content, before.findLast((m) => m.role === 'assistant')?.content);
    const prompt = await buildPrompt(user, conversation.id, question.content, decision.think);
    return streamReply(c, conversation.id, prompt, {
      userMessageId: question.id,
      firstMessage: messages.length <= 2 ? question.content : undefined,
      decision,
    });
  });
}
