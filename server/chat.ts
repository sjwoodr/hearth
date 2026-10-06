import { job, replies, replyFirstTokenSeconds, replySeconds, searches as searchCount } from './metrics.ts';
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
import { describeWaitingImages, parseImages, PendingImages, withImageText } from './images.ts';
import { plainSymbols } from '../shared/plain-symbols.ts';
import { SELF_CORRECTION, shouldThink, type ReplyDecision } from './think-router.ts';
import { isEffort, type Effort } from '../shared/think-effort.ts';
import type { DB } from './db.ts';
import type { MemorySections } from './memories.ts';
import type { ChatFn, ChatMessage, ToolCall } from './ollama.ts';
import { searchMessages } from './search.ts';
import type { SessionUser } from './sessions.ts';
import {
  declinedTurn,
  MAX_SEARCHES_PER_TURN,
  PendingSearches,
  withTodaysDate,
  type ImageRef,
  type PendingSearch,
  SEARCH_RESERVE,
  searchInstructions,
  searchQuery,
  searchTurn,
  WEB_SEARCH_TOOL,
  type SearchFn,
  type Source,
  type Turn,
} from './web-search.ts';

export type ChatDeps = {
  db: DB;
  chat: ChatFn;
  /** The same job with thinking on, used when the client asks for it (the Think toggle). */
  thinkingChat?: ChatFn;
  systemPrompt: () => string;
  numCtx: number;
  /** Memory for this user and message: a stable part for the system prompt, and facts recalled for this message. */
  memoryContext: (user: SessionUser, message: string) => Promise<MemorySections>;
  /** Each Think effort's cap on reasoning tokens; without them the thinking model uses its own default. */
  thinkingBudgets?: Record<Effort, number>;
  /** A model-written title for a chat's first exchange. */
  titleFor?: (userMessage: string, reply: string) => Promise<string | undefined>;
  /** Runs a describe request (images.ts) in the background and returns the description. */
  describeImages?: (messages: ChatMessage[]) => Promise<string>;
  /** Called after each saved reply, for background work such as summarizing long chats. */
  afterReply?: (conversationId: number) => void;
  /** The search engine behind the web_search tool; without it the model is never offered the tool. */
  webSearch?: SearchFn;
  /** The current time, for the date in the system prompt (tests pin it). */
  now?: () => Date;
  /** Whether the reply's model (the thinking one when `think`) is in Ollama's memory; undefined: can't tell. */
  modelLoaded?: (think: boolean) => Promise<boolean | undefined>;
};

/**
 * Sends `loading` when the model isn't in memory and the reply has shown nothing yet. The check runs
 * alongside the reply, never before it, so a loaded model costs nothing.
 */
function noticeLoading(loaded: Promise<boolean | undefined> | undefined, quiet: () => boolean, send: (event: object) => void) {
  void loaded?.then((isLoaded) => {
    if (isLoaded === false && quiet()) send({ type: 'loading' });
  });
}

// Context tokens held back for the reply itself.
const REPLY_RESERVE = 1024;
/** Context held back when thinking: the reasoning budget, plus roughly as much again when it's handed back as notes. */
export const thinkingReserve = (budget: number) => 2 * budget + 64;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TITLE_CHARS = 120;

type Env = { Variables: { user: SessionUser } };

/** Pages a reply drew on, as the model sees them in later turns. */
const withSources = (content: string, sources: Source[] | null) =>
  sources?.length ? `${content}\n\n[Sources: ${sources.map((s) => s.url).join(', ')}]` : content;

type ReplyOpts = {
  userMessageId: number;
  firstMessage?: string;
  decision: ReplyDecision;
  /** Searches already asked for while answering this message. */
  searches?: number;
  /** Set when the user approved a search: the reply first waits for it (the turn promise). */
  searching?: string;
};



const parseId = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * The client's Think setting: true (always), false (never) or "auto", where the rules in
 * think-router.ts decide from the message and the reply before it. `effort` is how hard to think when
 * it does (On, or Auto deciding to); anything unknown is Medium.
 */
function decideThinking(
  setting: unknown,
  effortSetting: unknown,
  message: string,
  previousReply: string | undefined,
  hasImages: boolean,
): ReplyDecision {
  const effort = isEffort(effortSetting) ? effortSetting : 'medium';
  if (setting === true) return { think: true, auto: false, effort };
  if (setting === 'auto') return { ...shouldThink(message, previousReply, hasImages), auto: true, effort };
  return { think: false, auto: false };
}

// A waiting search is saved to the database, so its prompt loses any image bytes; each image
// message keeps a reference to the message it came from instead (`imageSource`, set by buildPrompt).
function withoutImages(prompt: ChatMessage[], imageSource: WeakMap<ChatMessage, number>) {
  const images: ImageRef[] = [];
  const stripped = prompt.map((message, index): ChatMessage => {
    if (!message.images?.length) return message;
    const { images: bytes, ...rest } = message;
    const messageId = imageSource.get(message);
    if (messageId === undefined) return { ...rest, content: withImageText(rest.content, bytes.length, null) };
    images.push({ index, messageId, count: bytes.length });
    return rest;
  });
  return { prompt: stripped, images };
}

// Puts a waiting search's images back for the model: the bytes if still in memory, else (after a
// restart, say) the description the background job wrote, or a note that they're gone.
function withImagesBack(
  pending: PendingSearch,
  held: { pendingImages: PendingImages; imageSource: WeakMap<ChatMessage, number>; notes: () => Map<number, string | null> },
): ChatMessage[] {
  if (pending.images.length === 0) return pending.prompt;
  const notes = held.notes();
  return pending.prompt.map((message, index) => {
    const ref = pending.images.find((r) => r.index === index);
    if (!ref) return message;
    const inMemory = held.pendingImages.get(ref.messageId);
    if (inMemory) {
      const restored: ChatMessage = { ...message, images: inMemory.images };
      held.imageSource.set(restored, ref.messageId);
      return restored;
    }
    return { ...message, content: withImageText(message.content, ref.count, notes.get(ref.messageId) ?? null) };
  });
}

export function registerChatRoutes(api: Hono<Env>, deps: ChatDeps): void {
  const { db, chat, systemPrompt, numCtx, memoryContext } = deps;
  const notFound = { error: 'Chat not found.' };
  const pendingImages = new PendingImages();
  const pendingSearches = new PendingSearches(db, deps.now);
  // Which message each image-carrying prompt message came from. A waiting search is saved without
  // image bytes (images are never stored), so this is how they're put back when it runs.
  const imageSource = new WeakMap<ChatMessage, number>();

  api.get('/conversations', (c) => c.json(listConversations(db, c.get('user').id)));

  api.get('/search', (c) => c.json(searchMessages(db, c.get('user').id, (c.req.query('q') ?? '').slice(0, 200))));

  api.post('/conversations', (c) => c.json(createConversation(db, c.get('user').id), 201));

  api.get('/conversations/:id', (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, userId, id) : undefined;
    if (!conversation) return c.json(notFound, 404);
    const search = pendingSearches.get(conversation.id, userId);
    return c.json({
      conversation,
      messages: listMessages(db, userId, conversation.id),
      pendingSearch: search ? { query: search.query } : null,
    });
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
    pendingImages.forget(id);
    pendingSearches.forget(id);
    return c.json({ ok: true });
  });

  const budgetFor = (decision: ReplyDecision) => deps.thinkingBudgets?.[decision.effort ?? 'medium'];

  // The prompt for a reply to the chat's latest message. Ordered so the start stays the same from
  // turn to turn (personality, always-remembered memories, the running summary, older history),
  // which lets Ollama reuse its cache and read only what's new. The facts recalled for this message
  // change every time, so they ride on the newest message, in the prompt only; the stored message
  // is left as written. Images go to the model while they're still in memory: until described, and
  // after that only until the next message (so a retry still sees them). Then the description stands in.
  async function buildPrompt(user: SessionUser, conversationId: number, latest: string, decision?: ReplyDecision): Promise<ChatMessage[]> {
    const state = getContextState(db, conversationId);
    const messages = listMessages(db, user.id, conversationId).filter((m) => m.id > state.summary_through_message_id);
    const history: ChatMessage[] = messages.map((m) => {
      const pending = m.image_count > 0 ? pendingImages.get(m.id) : undefined;
      if (pending) {
        const message: ChatMessage = { role: m.role, content: m.content, images: pending.images };
        imageSource.set(message, m.id);
        return message;
      }
      return { role: m.role, content: withSources(withImageText(m.content, m.image_count, m.image_note), m.sources) };
    });
    const { stable, recalled } = await memoryContext(user, latest);
    const last = history.at(-1);
    if (recalled && last?.role === 'user') {
      const withRecall = { ...last, content: `${recalled}\n\n[${user.name}'s message]\n${last.content}` };
      const source = imageSource.get(last);
      if (source !== undefined) imageSource.set(withRecall, source);
      history[history.length - 1] = withRecall;
    }
    const earlier = state.summary ? `## Earlier in this conversation\n\n${state.summary}` : '';
    const tool = deps.webSearch ? searchInstructions(deps.now?.() ?? new Date()) : '';
    const system = [systemPrompt(), tool, stable, earlier].filter(Boolean).join('\n\n');
    const budget = decision?.think ? budgetFor(decision) : undefined;
    const reserve = REPLY_RESERVE + (budget ? thinkingReserve(budget) : 0) + (deps.webSearch ? SEARCH_RESERVE : 0);
    return fitHistory(system, history, numCtx - reserve);
  }

  // Streams a reply as NDJSON: start, optional searching, queued and loading, delta..., then done or error,
  // and after a chat's first reply, title. If the model asks to search instead, it ends with search
  // (the query for the card) and the reply continues from POST /search once the user answers.
  function streamReply(c: Context<Env>, conversationId: number, turnReady: Turn | Promise<Turn>, opts: ReplyOpts) {
    const user = c.get('user');
    const searches = opts.searches ?? 0;
    // Past the limit the tool is withheld, so the model has to answer with what it found.
    const tools = deps.webSearch && searches < MAX_SEARCHES_PER_TURN ? [WEB_SEARCH_TOOL] : undefined;
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return stream(c, async (s) => {
      const startedAt = performance.now();
      const controller = new AbortController();
      s.onAbort(() => controller.abort());
      // One queue for every write: thinking progress arrives from a callback while text streams. A
      // failed write means the client has gone, which the abort signal already handles.
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: object) =>
        (writes = writes.then(() => s.write(`${JSON.stringify(event)}\n`)).catch(() => undefined));
      const think = opts.decision.think && !!deps.thinkingChat;
      const generate = think ? deps.thinkingChat! : chat;
      const effort = think ? (opts.decision.effort ?? 'medium') : undefined;
      const thinkingBudget = think ? budgetFor(opts.decision) : undefined;
      let lastReported = 0;
      let thoughtTokens = 0;
      // Anything from the model (a word, a thought) or the end of the reply: a loading notice would be stale.
      let heard = false;
      const onThinking = (tokens: number) => {
        heard = true;
        thoughtTokens = tokens;
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
        // How hard, and the cap, so the client can show progress against it.
        ...(effort ? { effort } : {}),
        ...(thinkingBudget ? { budget: thinkingBudget } : {}),
        // Why Auto chose to think, so the client can say so.
        ...(think && opts.decision.auto && opts.decision.reason ? { reason: opts.decision.reason } : {}),
      });
      if (opts.searching) await send({ type: 'searching', query: opts.searching });
      const { prompt, sources = [] } = await turnReady;
      noticeLoading(deps.modelLoaded?.(think), () => !heard, send);
      let reply = '';
      let call: { raw: ToolCall; query: string } | undefined;
      const unusable: ToolCall[] = [];
      const onToolCall = (raw: ToolCall) => {
        const query = searchQuery(raw);
        if (query && !call) call = { raw, query };
        else if (!query) unusable.push(raw);
      };
      try {
        // The scheduler (in deps.chat) makes room by preempting background work, or, when every slot
        // holds a reply, queues this one and says so. Ceiling: other Ollama clients are invisible.
        const onQueued = () => void send({ type: 'queued' });
        const callOpts = { onThinking, thinkingBudget, tools, onToolCall, userId: user.id, onQueued };
        const labels = { think: String(think), effort: effort ?? 'none' };
        const sinceStart = () => (performance.now() - startedAt) / 1000;
        for await (const text of generate(prompt, controller.signal, callOpts)) {
          heard = true;
          if (!reply) replyFirstTokenSeconds.observe(labels, sinceStart());
          reply += text;
          // Queued, not awaited: a client that reads slowly (or stops, with the connection still up)
          // mustn't hold a model slot that other replies are waiting for. The text buffers here
          // instead; awaiting `done` below flushes it.
          void send({ type: 'delta', text });
        }
        heard = true; // over, even with no words (a search request, or nothing)
        if (call) {
          // Nothing is searched here. The request waits for the user's tap on the card.
          const saved = withoutImages([...prompt, { role: 'assistant', content: reply, tool_calls: [call.raw] }], imageSource);
          pendingSearches.set(conversationId, {
            userId: user.id,
            userMessageId: opts.userMessageId,
            query: call.query,
            prompt: saved.prompt,
            images: saved.images,
            decision: opts.decision,
            firstMessage: opts.firstMessage,
            searches: searches + 1,
            sources,
          });
          searchCount.inc({ outcome: 'asked' });
          replies.inc({ ...labels, outcome: 'search' });
          replySeconds.observe(labels, sinceStart());
          await send({ type: 'search', query: call.query });
          return;
        }
        if (!reply.trim()) {
          // Rare and not yet reproduced: log enough to tell an unusable tool call from a thinking
          // cut that left the model with nothing to say.
          console.error(
            `empty reply: chat ${conversationId}, think ${think} (${thoughtTokens} reasoning tokens), ` +
              `searches ${searches}, prompt ends with ${prompt.at(-1)?.role}, unusable tool calls ${JSON.stringify(unusable)}`,
          );
          throw new Error('The model returned an empty reply. Retry usually works.');
        }
        reply = plainSymbols(reply);
        const messageId = addMessage(db, conversationId, 'assistant', reply, { sources });
        replies.inc({ ...labels, outcome: 'done' });
        replySeconds.observe(labels, sinceStart());
        await send({
          type: 'done',
          messageId,
          ...(sources.length ? { sources } : {}),
          // A fast reply that caught itself mid-answer ("wait, no, that's wrong") is worth re-asking with thinking.
          ...(!think && SELF_CORRECTION.test(reply) ? { selfCorrected: true } : {}),
        });
      } catch (err) {
        heard = true;
        replies.inc({ think: String(think), effort: effort ?? 'none', outcome: controller.signal.aborted ? 'stopped' : 'error' });
        // Stopped or failed mid-reply: keep what was generated so the chat reads as it happened.
        if (reply.trim()) addMessage(db, conversationId, 'assistant', plainSymbols(reply), { sources });
        if (!controller.signal.aborted) {
          await send({ type: 'error', error: err instanceof Error ? err.message : 'Generation failed.' });
        }
        return;
      }

      if (opts.firstMessage && deps.titleFor && !controller.signal.aborted) {
        try {
          const title = await deps.titleFor(opts.firstMessage, reply);
          if (title && setAutoTitle(db, conversationId, title)) await send({ type: 'title', title });
          job('title', 'ok');
        } catch (err) {
          job('title', isPreempted(err) ? 'preempted' : 'failed');
          // The first-message title stays; a failed or preempted title isn't worth an error.
          if (!isPreempted(err)) console.error(`title: chat ${conversationId} failed:`, err instanceof Error ? err.message : err);
        }
      }
      if (deps.describeImages) {
        const turn = { conversationId, answeredId: opts.userMessageId, prompt, reply };
        describeWaitingImages(db, pendingImages, deps.describeImages, turn);
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
    const parsed = parseImages(body?.images);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const { images } = parsed;
    if (!content && images.length === 0) return c.json({ error: 'Message is empty.' }, 400);
    if (content.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` }, 400);
    }

    const earlier = listMessages(db, user.id, conversation.id);
    const isFirst = earlier.length === 0;
    const previousReply = earlier.findLast((m) => m.role === 'assistant')?.content;
    const decision = decideThinking(body?.think, body?.effort, content, previousReply, images.length > 0);
    pendingImages.moveOn(conversation.id);
    // A search card left unanswered is dropped: the user moved on.
    pendingSearches.forget(conversation.id);
    const userMessageId = addMessage(db, conversation.id, 'user', content, { imageCount: images.length });
    if (images.length > 0) pendingImages.add(userMessageId, conversation.id, images);
    // An image alone has no words for a title yet; the model's title after the reply will name it.
    const firstMessage = content || (images.length === 1 ? '(image)' : `(${images.length} images)`);
    if (!conversation.title) setAutoTitle(db, conversation.id, titleFrom(firstMessage));
    const prompt = await buildPrompt(user, conversation.id, content, decision);
    return streamReply(c, conversation.id, { prompt }, { userMessageId, firstMessage: isFirst ? firstMessage : undefined, decision });
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
    pendingSearches.forget(conversation.id);

    const before = messages.slice(0, messages.indexOf(question));
    const decision = decideThinking(
      body?.think,
      body?.effort,
      question.content,
      before.findLast((m) => m.role === 'assistant')?.content,
      question.image_count > 0,
    );
    const prompt = await buildPrompt(user, conversation.id, question.content, decision);
    return streamReply(c, conversation.id, { prompt }, {
      userMessageId: question.id,
      firstMessage: messages.length <= 2 ? question.content : undefined,
      decision,
    });
  });

  // The user's answer to a search card. This is the only place a web search ever runs: the model
  // can ask, but only an approval here sends the query out. Declining tells the model to answer
  // without it.
  api.post('/conversations/:id/search', async (c) => {
    const body = await c.req.json().catch(() => null);
    const user = c.get('user');
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, user.id, id) : undefined;
    if (!conversation) return c.json(notFound, 404);
    if (typeof body?.approve !== 'boolean') return c.json({ error: 'Say whether to search (approve: true or false).' }, 400);
    const waiting = pendingSearches.take(conversation.id, user.id);
    // Gone if a newer message or a retry replaced it, or it waited longer than a day.
    if (!waiting) {
      return c.json({ error: 'That search request is gone (it expired, or the chat moved on). Tap Retry to ask again.' }, 409);
    }

    const notes = () => new Map(listMessages(db, user.id, conversation.id).map((m) => [m.id, m.image_note]));
    const restored = withImagesBack(waiting, { pendingImages, imageSource, notes });
    const prompt = withTodaysDate(restored, waiting.askedAt, deps.now?.() ?? new Date());
    const pending = { ...waiting, prompt };
    const approved = body.approve === true && !!deps.webSearch;
    searchCount.inc({ outcome: approved ? 'approved' : 'declined' });
    const turn = approved ? searchTurn(pending, deps.webSearch!, conversation.id) : declinedTurn(pending);
    return streamReply(c, conversation.id, turn, {
      userMessageId: pending.userMessageId,
      firstMessage: pending.firstMessage,
      decision: pending.decision,
      searches: pending.searches,
      ...(approved ? { searching: pending.query } : {}),
    });
  });
}
