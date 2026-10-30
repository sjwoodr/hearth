import { job, replies, replyFirstTokenSeconds, replySeconds, searches as searchCount, thinkingTokens } from './metrics.ts';
import type { Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ActiveReplies } from './active-replies.ts';
import { fitHistory } from './context.ts';
import { pauseNote } from './pause.ts';
import { contextUse, listFolds } from './summarize.ts';
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
import type { ModelChoice } from './active-model.ts';
import type { ModelInfo } from './ollama.ts';
import { isEffort, type Effort } from '../shared/think-effort.ts';
import type { DB } from './db.ts';
import type { MemorySections } from './memories.ts';
import type { ChatFn, ChatMessage, ToolCall } from './ollama.ts';
import { parsePrivateHistory, PRIVATE_CHAT_ID, PrivateSearches } from './private-chat.ts';
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
  /** Tokens of the context window a prompt may fill (HEARTH_CONTEXT_BUDGET), the reply's room included. */
  contextBudget: number;
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
  /** The model in use (an admin can switch it); replies record their use so an idle switch can revert. */
  modelChoice?: ModelChoice;
  /** What a model can do (Ollama's capabilities: vision, thinking, tools); undefined: can't tell. */
  modelCatalog?: { list(): Promise<ModelInfo[]>; capabilities(name: string): Promise<string[] | undefined> };
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

// On the newest user message only, never stored (like recall), so the prompt start stays cached. The
// system prompt's length line alone left replies ~1,250 characters whatever the message; this halves
// casual ones and leaves explanations full length (CLAUDE.md, "Questions and length").
export const REPLY_LENGTH =
  '[A short message gets a warm, conversational reply of a few sentences. If it asks you to explain, teach, compare or give steps, answer fully.]';

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
  /** The stored message being answered (private chats have none). */
  userMessageId?: number;
  firstMessage?: string;
  decision: ReplyDecision;
  /** Searches already asked for while answering this message. */
  searches?: number;
  /** Set when the user approved a search: the reply first waits for it (the turn promise). */
  searching?: string;
  /** False when the current model can't call tools, so web search isn't offered. */
  search?: boolean;
  /** The model answering, for the client's notice when it changed. */
  model?: string;
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
  const { db, chat, systemPrompt, contextBudget, memoryContext } = deps;
  const notFound = { error: 'Chat not found.' };
  const pendingImages = new PendingImages();
  const pendingSearches = new PendingSearches(db, deps.now);
  const privateSearches = new PrivateSearches(deps.now);
  // Which message each image-carrying prompt message came from. A waiting search is saved without
  // image bytes (images are never stored), so this is how they're put back when it runs.
  const imageSource = new WeakMap<ChatMessage, number>();
  const replying = new ActiveReplies();
  const busy = { error: 'A reply is still being written in this chat. Wait for it, or stop it.' };

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
      replying: replying.running(conversation.id, userId),
      context: contextUse(db, conversation.id, contextBudget),
      folds: listFolds(db, conversation.id),
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
    replying.stop(id, c.get('user').id);
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
  // What the model in use can do. Unknown capabilities (no catalog, Ollama unreachable) allow everything.
  type ModelNow = { name?: string; caps?: string[] };
  async function modelNow(): Promise<ModelNow> {
    const name = deps.modelChoice?.current();
    return { name, caps: name && deps.modelCatalog ? await deps.modelCatalog.capabilities(name) : undefined };
  }
  const can = (m: ModelNow, capability: string) => !m.caps || m.caps.includes(capability);
  const searchFor = (m: ModelNow) => !!deps.webSearch && can(m, 'tools');
  const thinkingFor = (m: ModelNow, decision: ReplyDecision): ReplyDecision => (can(m, 'thinking') ? decision : { think: false, auto: false });

  async function buildPrompt(
    user: SessionUser,
    conversationId: number,
    latest: string,
    decision?: ReplyDecision,
    search = !!deps.webSearch,
  ): Promise<ChatMessage[]> {
    const state = getContextState(db, conversationId);
    const all = listMessages(db, user.id, conversationId);
    const messages = all.filter((m) => m.id > state.summary_through_message_id);
    const history: ChatMessage[] = messages.map((m) => {
      const pending = m.image_count > 0 ? pendingImages.get(m.id) : undefined;
      if (pending) {
        const message: ChatMessage = { role: m.role, content: m.content, images: pending.images };
        imageSource.set(message, m.id);
        return message;
      }
      return { role: m.role, content: withSources(withImageText(m.content, m.image_count, m.image_note), m.sources) };
    });
    // Measured from the message before it even when that one is folded into the summary.
    const [before, newest] = all.slice(-2);
    const pause = before && newest?.role === 'user' ? pauseNote(before.created_at, newest.created_at) : '';
    return assemble(user, history, latest, decision, search, { summary: state.summary, pause });
  }

  // The rest of a prompt, for stored and private chats alike: memory, recall on the newest message,
  // search instructions, and as much history as fits.
  async function assemble(
    user: SessionUser,
    history: ChatMessage[],
    latest: string,
    decision: ReplyDecision | undefined,
    search: boolean,
    extra: { summary?: string | null; pause?: string } = {},
  ): Promise<ChatMessage[]> {
    const { stable, recalled } = await memoryContext(user, latest);
    const last = history.at(-1);
    const notes = [recalled, extra.pause, REPLY_LENGTH].filter(Boolean).join('\n\n');
    if (last?.role === 'user') {
      const withRecall = { ...last, content: `${notes}\n\n[${user.name}'s message]\n${last.content}` };
      const source = imageSource.get(last);
      if (source !== undefined) imageSource.set(withRecall, source);
      history[history.length - 1] = withRecall;
    }
    const earlier = extra.summary ? `## Earlier in this conversation\n\n${extra.summary}` : '';
    const tool = search ? searchInstructions(deps.now?.() ?? new Date()) : '';
    const system = [systemPrompt(), tool, stable, earlier].filter(Boolean).join('\n\n');
    const budget = decision?.think ? budgetFor(decision) : undefined;
    const reserve = REPLY_RESERVE + (budget ? thinkingReserve(budget) : 0) + (search ? SEARCH_RESERVE : 0);
    return fitHistory(system, history, contextBudget - reserve);
  }

  // Where a reply ends up. A stored chat saves it and runs the work after it (title, image
  // descriptions, summary); a private chat (private-chat.ts) keeps nothing, so it needs none of that.
  type ReplyTarget = {
    /** The key for ActiveReplies: a stored chat's id, or a private chat's key. */
    key: number | string;
    /** How log lines name the chat: never its content. */
    label: string;
    /** Saves a finished reply, or what was written before a stop or failure; its id, if it was saved. */
    save: (reply: string, sources: Source[], partial: boolean) => number | undefined;
    /** Holds the model's search request until the user answers the card. */
    holdSearch: (search: Omit<PendingSearch, 'askedAt'>) => void;
    /** More for the `done` event. */
    doneExtras?: () => object;
    /** Work after a finished reply. */
    after?: (send: (event: object) => Promise<unknown>, prompt: ChatMessage[], reply: string, stopped: boolean) => Promise<void>;
    /** Stops the reply when its connection closes, because nobody could come back for it. */
    endsWithConnection?: boolean;
  };

  function storedTarget(user: SessionUser, conversationId: number, opts: { userMessageId: number; firstMessage?: string }): ReplyTarget {
    return {
      key: conversationId,
      label: `chat ${conversationId}`,
      save: (reply, sources, partial) => {
        // Not into a chat deleted mid-reply, which is what stopped it.
        if (partial && !getConversation(db, user.id, conversationId)) return undefined;
        return addMessage(db, conversationId, 'assistant', reply, { sources });
      },
      holdSearch: (search) => {
        const saved = withoutImages(search.prompt, imageSource);
        pendingSearches.set(conversationId, { ...search, prompt: saved.prompt, images: saved.images });
      },
      doneExtras: () => ({
        // Before any fold this reply sets off, so it can read past 100% until the summary is written.
        context: contextUse(db, conversationId, contextBudget),
        // A fold the worker made since the page loaded shows up with the next reply.
        folds: listFolds(db, conversationId),
      }),
      after: async (send, prompt, reply, stopped) => {
        if (opts.firstMessage && deps.titleFor && !stopped) {
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
      },
    };
  }

  // Streams a reply as NDJSON: start, optional searching, queued and loading, delta..., then done or error,
  // and after a chat's first reply, title. If the model asks to search instead, it ends with search
  // (the query for the card) and the reply continues from the search route once the user answers.
  function streamReply(c: Context<Env>, target: ReplyTarget, turnReady: Turn | Promise<Turn>, opts: ReplyOpts) {
    const user = c.get('user');
    const searches = opts.searches ?? 0;
    // Past the limit the tool is withheld, so the model has to answer with what it found.
    const tools = deps.webSearch && opts.search !== false && searches < MAX_SEARCHES_PER_TURN ? [WEB_SEARCH_TOOL] : undefined;
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    // Not tied to the connection: a reply runs to the end even if the browser goes away, and only
    // POST /stop (or deleting the chat) stops it. `release` marks it finished for GET and the busy check.
    const controller = new AbortController();
    const release = replying.start(target.key, user.id, controller);
    return stream(c, async (s) => {
      if (target.endsWithConnection) s.onAbort(() => controller.abort());
      const startedAt = performance.now();
      try {
        // One queue for every write: thinking progress arrives from a callback while text streams. A
        // failed write means the client has gone; the reply carries on and is saved all the same.
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
        // The last count, which progress every 10 tokens would otherwise miss (191 of a 200 cap).
        const onThinkingEnd = (tokens: number, cut: boolean) => {
          thinkingTokens.observe({ effort: effort ?? 'medium', ended: cut ? 'cut' : 'finished' }, tokens);
          if (tokens > 0 && tokens !== lastReported) void send({ type: 'thinking', tokens });
        };

        deps.modelChoice?.touch();
        await send({
          type: 'start',
          ...(opts.userMessageId !== undefined ? { userMessageId: opts.userMessageId } : {}),
          ...(opts.model ? { model: opts.model } : {}),
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
          const callOpts = { onThinking, onThinkingEnd, thinkingBudget, tools, onToolCall, userId: user.id, onQueued };
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
            target.holdSearch({
              userId: user.id,
              userMessageId: opts.userMessageId ?? 0,
              query: call.query,
              prompt: [...prompt, { role: 'assistant', content: reply, tool_calls: [call.raw] }],
              images: [],
              decision: opts.decision,
              firstMessage: opts.firstMessage,
              searches: searches + 1,
              sources,
            });
            release();
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
              `empty reply: ${target.label}, think ${think} (${thoughtTokens} reasoning tokens), ` +
                `searches ${searches}, prompt ends with ${prompt.at(-1)?.role}, unusable tool calls ${JSON.stringify(unusable)}`,
            );
            throw new Error('The model returned an empty reply. Retry usually works.');
          }
          reply = plainSymbols(reply);
          const messageId = target.save(reply, sources, false);
          release(); // saved: before `done`, whose write can wait on a client that's gone quiet
          replies.inc({ ...labels, outcome: 'done' });
          replySeconds.observe(labels, sinceStart());
          await send({
            type: 'done',
            ...(messageId !== undefined ? { messageId } : {}),
            ...target.doneExtras?.(),
            ...(sources.length ? { sources } : {}),
            // A fast reply that caught itself mid-answer ("wait, no, that's wrong") is worth re-asking with thinking.
            ...(!think && SELF_CORRECTION.test(reply) ? { selfCorrected: true } : {}),
          });
        } catch (err) {
          heard = true;
          replies.inc({ think: String(think), effort: effort ?? 'none', outcome: controller.signal.aborted ? 'stopped' : 'error' });
          // Stopped or failed mid-reply: keep what was generated so the chat reads as it happened.
          const messageId = reply.trim() ? target.save(plainSymbols(reply), sources, true) : undefined;
          release();
          if (controller.signal.aborted) await send({ type: 'stopped', ...(messageId ? { messageId } : {}) });
          else await send({ type: 'error', error: err instanceof Error ? err.message : 'Generation failed.' });
          return;
        }

        await target.after?.(send, prompt, reply, controller.signal.aborted);
      } finally {
        release(); // a backstop: every path above releases once the reply is saved or has failed
      }
    });
  }

  api.post('/conversations/:id/messages', async (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, user.id, id) : undefined;
    if (!conversation) return c.json(notFound, 404);
    if (replying.running(conversation.id, user.id)) return c.json(busy, 409);

    const body = await c.req.json().catch(() => null);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    const parsed = parseImages(body?.images);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const { images } = parsed;
    if (!content && images.length === 0) return c.json({ error: 'Message is empty.' }, 400);
    if (content.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` }, 400);
    }

    const model = await modelNow();
    if (images.length > 0 && !can(model, 'vision')) {
      return c.json({ error: `The current model (${model.name}) can't read images. Send the message without them, or ask an admin to switch back.` }, 400);
    }

    const earlier = listMessages(db, user.id, conversation.id);
    const isFirst = earlier.length === 0;
    const previousReply = earlier.findLast((m) => m.role === 'assistant')?.content;
    const decision = thinkingFor(model, decideThinking(body?.think, body?.effort, content, previousReply, images.length > 0));
    const search = searchFor(model);
    pendingImages.moveOn(conversation.id);
    // A search card left unanswered is dropped: the user moved on.
    pendingSearches.forget(conversation.id);
    const userMessageId = addMessage(db, conversation.id, 'user', content, { imageCount: images.length });
    if (images.length > 0) pendingImages.add(userMessageId, conversation.id, images);
    // An image alone has no words for a title yet; the model's title after the reply will name it.
    const firstMessage = content || (images.length === 1 ? '(image)' : `(${images.length} images)`);
    if (!conversation.title) setAutoTitle(db, conversation.id, titleFrom(firstMessage));
    const prompt = await buildPrompt(user, conversation.id, content, decision, search);
    const target = storedTarget(user, conversation.id, { userMessageId, firstMessage: isFirst ? firstMessage : undefined });
    return streamReply(c, target, { prompt }, {
      userMessageId,
      firstMessage: isFirst ? firstMessage : undefined,
      decision,
      search,
      model: model.name,
    });
  });

  // Regenerates the reply to the latest user message, replacing the last reply if there is one
  // (a failed, stopped or unwanted answer).
  api.post('/conversations/:id/retry', async (c) => {
    const body = await c.req.json().catch(() => null);
    const user = c.get('user');
    const id = parseId(c.req.param('id'));
    const conversation = id ? getConversation(db, user.id, id) : undefined;
    if (!conversation) return c.json(notFound, 404);
    if (replying.running(conversation.id, user.id)) return c.json(busy, 409);

    const messages = listMessages(db, user.id, conversation.id);
    const last = messages.at(-1);
    const question = last?.role === 'assistant' ? messages.at(-2) : last;
    if (!question || question.role !== 'user') return c.json({ error: 'There is no message to retry.' }, 400);
    if (last!.role === 'assistant') deleteMessage(db, conversation.id, last!.id);
    pendingSearches.forget(conversation.id);

    const before = messages.slice(0, messages.indexOf(question));
    const model = await modelNow();
    const decision = thinkingFor(
      model,
      decideThinking(
        body?.think,
        body?.effort,
        question.content,
        before.findLast((m) => m.role === 'assistant')?.content,
        question.image_count > 0,
      ),
    );
    const search = searchFor(model);
    const prompt = await buildPrompt(user, conversation.id, question.content, decision, search);
    const firstMessage = messages.length <= 2 ? question.content : undefined;
    return streamReply(c, storedTarget(user, conversation.id, { userMessageId: question.id, firstMessage }), { prompt }, {
      userMessageId: question.id,
      firstMessage,
      decision,
      search,
      model: model.name,
    });
  });

  // Stop is its own request: a closed connection (a locked phone) lets the reply finish.
  api.post('/conversations/:id/stop', (c) => {
    const id = parseId(c.req.param('id'));
    return c.json({ stopped: !!id && replying.stop(id, c.get('user').id) });
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
    if (replying.running(conversation.id, user.id)) return c.json(busy, 409);
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
    // The model may have been switched while the card waited.
    const model = await modelNow();
    const target = storedTarget(user, conversation.id, { userMessageId: pending.userMessageId, firstMessage: pending.firstMessage });
    return streamReply(c, target, turn, {
      userMessageId: pending.userMessageId,
      firstMessage: pending.firstMessage,
      decision: thinkingFor(model, pending.decision),
      searches: pending.searches,
      search: searchFor(model),
      model: model.name,
      ...(approved ? { searching: pending.query } : {}),
    });
  });

  // Private chats (private-chat.ts): the browser sends the whole chat with each message, and nothing
  // here writes to the database. Recall still reads the user's memories; nothing new is learned.
  const privateKey = (userId: number, chatId: string) => `private:${userId}:${chatId}`;
  const privateChat = (c: Context<Env>) => {
    const chatId = c.req.param('chatId') ?? '';
    return PRIVATE_CHAT_ID.test(chatId) ? privateKey(c.get('user').id, chatId) : undefined;
  };
  const privateTarget = (key: string): ReplyTarget => ({
    key,
    label: 'a private chat',
    save: () => undefined,
    holdSearch: (search) => privateSearches.set(key, search),
    // Nobody can come back for a private reply (it isn't saved), so a closed tab stops it.
    endsWithConnection: true,
  });

  api.post('/private/:chatId/messages', async (c) => {
    const user = c.get('user');
    const key = privateChat(c);
    if (!key) return c.json(notFound, 404);
    if (replying.running(key, user.id)) return c.json(busy, 409);
    const body = await c.req.json().catch(() => null);
    const parsed = parsePrivateHistory(body?.messages, MAX_MESSAGE_CHARS);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const parsedImages = parseImages(body?.images);
    if ('error' in parsedImages) return c.json({ error: parsedImages.error }, 400);
    const { images } = parsedImages;
    const { messages } = parsed;
    const latest = messages.at(-1)!;
    if (!latest.content.trim() && images.length === 0) return c.json({ error: 'Message is empty.' }, 400);

    const model = await modelNow();
    if (images.length > 0 && !can(model, 'vision')) {
      return c.json({ error: `The current model (${model.name}) can't read images. Send the message without them, or ask an admin to switch back.` }, 400);
    }
    const previousReply = messages.findLast((m) => m.role === 'assistant')?.content;
    const decision = thinkingFor(model, decideThinking(body?.think, body?.effort, latest.content, previousReply, images.length > 0));
    const search = searchFor(model);
    privateSearches.forget(key);
    // Images go with the message they came with (sent again for a retry); earlier ones are gone.
    const history: ChatMessage[] = messages.map((m, i) =>
      i === messages.length - 1 && images.length
        ? { role: m.role, content: m.content, images }
        : { role: m.role, content: withSources(withImageText(m.content, m.imageCount, null), m.sources) },
    );
    const prompt = await assemble(user, history, latest.content, decision, search);
    return streamReply(c, privateTarget(key), { prompt }, { decision, search, model: model.name });
  });

  api.post('/private/:chatId/stop', (c) => {
    const key = privateChat(c);
    return c.json({ stopped: !!key && replying.stop(key, c.get('user').id) });
  });

  // Ending a private chat: stops its reply and drops a waiting search card.
  api.delete('/private/:chatId', (c) => {
    const key = privateChat(c);
    if (!key) return c.json(notFound, 404);
    replying.stop(key, c.get('user').id);
    privateSearches.forget(key);
    return c.json({ ok: true });
  });

  api.post('/private/:chatId/search', async (c) => {
    const body = await c.req.json().catch(() => null);
    const user = c.get('user');
    const key = privateChat(c);
    if (!key) return c.json(notFound, 404);
    if (replying.running(key, user.id)) return c.json(busy, 409);
    if (typeof body?.approve !== 'boolean') return c.json({ error: 'Say whether to search (approve: true or false).' }, 400);
    const waiting = privateSearches.take(key, user.id);
    if (!waiting) {
      return c.json({ error: 'That search request is gone (it expired, or hearth restarted). Tap Retry to ask again.' }, 409);
    }
    const pending = { ...waiting, prompt: withTodaysDate(waiting.prompt, waiting.askedAt, deps.now?.() ?? new Date()) };
    const approved = body.approve === true && !!deps.webSearch;
    searchCount.inc({ outcome: approved ? 'approved' : 'declined' });
    const turn = approved ? searchTurn(pending, deps.webSearch!, 'a private chat') : declinedTurn(pending);
    const model = await modelNow();
    return streamReply(c, privateTarget(key), turn, {
      decision: thinkingFor(model, pending.decision),
      searches: pending.searches,
      search: searchFor(model),
      model: model.name,
      ...(approved ? { searching: pending.query } : {}),
    });
  });
}
