import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError, type ContextUse, type Message, type PrivateMessage, type Source, type StreamEvent, type SummaryFold } from './api.ts';
import { imageFiles, MAX_ATTACHMENTS, shrinkImage } from './images.ts';
import { MessageMarkdown } from './Markdown.tsx';
import { plainSymbols } from '../../shared/plain-symbols.ts';
import { pendingText } from '../../shared/pending-text.ts';
import { EFFORT_LABEL, EFFORTS, higherEffort, isEffort, type Effort } from '../../shared/think-effort.ts';
import { timeGap } from '../../shared/time-gap.ts';

type Props = {
  id: number | undefined;
  name: string;
  /** A message to scroll to and highlight once the chat loads (from search). */
  focusMessageId?: number;
  onCreated: (id: number) => void;
  onChanged: () => void;
  onError: (err: unknown) => void;
  /** How full the chat's context is, for the meter in the title bar; null when there's no chat. */
  onContext: (context: ContextUse | null) => void;
  /**
   * A private chat: held in this page only and sent whole with each message; the server saves none
   * of it. `id` is ignored. Leaving the view (or the page) ends it.
   */
  privateChat?: boolean;
  /** A private chat reports whether it has messages, so leaving it can ask first. */
  onPrivateMessages?: (has: boolean) => void;
  /** When the chat ran (its first and last message, SQLite UTC), for the title bar; null when empty. */
  onSpan?: (span: { first: string; last: string } | null) => void;
};

/**
 * A message as shown here. `note` is this session's timing line ("Answered in 12.3 seconds");
 * `fast` marks a reply that answered without thinking, to offer re-answering with thinking;
 * `selfCorrected` marks a fast reply that caught itself mid-answer, the strongest case for it;
 * `effort` is how hard a reply thought, to offer thinking harder. All three are known only for
 * replies that arrived on this page (the server doesn't store them).
 * `previews` are images sent from this page, kept in this tab only: the server never stores
 * them, so after a reload a message shows hearth's description of its images instead.
 */
type ViewMessage = Message & {
  note?: string;
  fast?: boolean;
  selfCorrected?: boolean;
  effort?: Effort;
  previews?: string[];
};

const seconds = (ms: number) => (ms / 1000).toFixed(1);

let tempId = 0;
const localMessage = (role: Message['role'], content: string, previews: string[] = []): ViewMessage => ({
  id: --tempId,
  role,
  content,
  image_count: previews.length,
  image_note: null,
  sources: null,
  // Now, in the server's format (SQLite UTC), so a break before a message just sent shows at once.
  created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  ...(previews.length ? { previews } : {}),
});

/** What the chat says where older messages were folded into the summary; the nth fold gets the nth line. */
const FOLD_LINES = [
  'This chat is going strong! I folded the earliest messages into my notes to make room.',
  "Still going! The early part of our chat now lives in my summary, so I can keep up.",
  "We've covered a lot of ground. I tucked the oldest messages into my notes and carried on.",
  'Making room again: the start of this chat is now a summary I keep in mind.',
];
const foldLine = (n: number) => FOLD_LINES[n % FOLD_LINES.length]!;
const foldDetail = (fold: SummaryFold) =>
  `${fold.folded} message${fold.folded === 1 ? '' : 's'} folded into hearth's summary of this chat. They're still here to read; hearth now works from the summary instead.`;

const DROPPED = 'The connection dropped before the reply finished. Reload to see what was saved.';
const PRIVATE_DROPPED = "The connection dropped before the reply finished. A private reply isn't kept anywhere, so it's lost: Retry to ask again.";

/** A private chat's id: random, made here. Not crypto.randomUUID, which needs HTTPS (hearth runs on plain HTTP on a LAN). */
const newPrivateId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** The chat as a private request sends it: no ids, dates or image bytes. */
const privateHistory = (messages: ViewMessage[]): PrivateMessage[] =>
  messages.map((m) => ({ role: m.role, content: m.content, imageCount: m.image_count, sources: m.sources }));
/** How often a page that lost its stream checks whether the reply is saved yet. */
const CATCH_UP_POLL_MS = 2000;

// The Think setting is a per-browser preference; storage can be unavailable (private mode).
// Auto lets the server decide per message; On and Off override it.
type ThinkSetting = 'auto' | 'on' | 'off';
const THINK_KEY = 'hearth.think';
const NEXT_SETTING: Record<ThinkSetting, ThinkSetting> = { auto: 'on', on: 'off', off: 'auto' };
const loadThink = (): ThinkSetting => {
  try {
    const v = localStorage.getItem(THINK_KEY);
    // Before Auto existed: '1' was On, and '0' was the old default, which Auto replaces.
    return v === 'on' || v === '1' ? 'on' : v === 'off' ? 'off' : 'auto';
  } catch {
    return 'auto';
  }
};
const saveThink = (setting: ThinkSetting) => {
  try {
    localStorage.setItem(THINK_KEY, setting);
  } catch {}
};
const wire = (s: ThinkSetting) => (s === 'auto' ? 'auto' : s === 'on');

// How hard to think when hearth thinks (On, or Auto deciding to): also per browser.
const EFFORT_KEY = 'hearth.effort';
const loadEffort = (): Effort => {
  try {
    const v = localStorage.getItem(EFFORT_KEY);
    return isEffort(v) ? v : 'medium';
  } catch {
    return 'medium';
  }
};
const saveEffort = (effort: Effort) => {
  try {
    localStorage.setItem(EFFORT_KEY, effort);
  } catch {}
};
const EFFORT_HELP: Record<Effort, string> = {
  medium: 'Thinking effort: Medium. The tested default, enough for checking French; about 10 seconds of thinking at most.',
  high: 'Thinking effort: High. Twice the thinking room, for harder questions; up to about 20 seconds more.',
  max: 'Thinking effort: Max. Four times the room, for the hardest questions; up to about 40 seconds more.',
};
const THINK_HELP: Record<ThinkSetting, string> = {
  auto: 'Think: Auto. hearth thinks first when you ask it to check or grade French, answer a quiz, or explain a grammar rule; otherwise it answers fast.',
  on: 'Think: On. Every reply reasons first: slower (up to about half a minute), more careful.',
  off: 'Think: Off. Every reply is fast, with no reasoning first.',
};

export function ConversationView({ id: storedId, name, focusMessageId, onCreated, onChanged, onError, onContext, privateChat = false, onPrivateMessages, onSpan }: Props) {
  const id = privateChat ? undefined : storedId;
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  // A private chat's id for the server (its reply, stop and search card), for the life of this view.
  const [privateId] = useState(newPrivateId);
  // When the current reply was asked for, and a clock that ticks while it's pending.
  const startedRef = useRef(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [loading, setLoading] = useState(false);
  const [think, setThink] = useState<ThinkSetting>(loadThink);
  const [effort, setEffort] = useState<Effort>(loadEffort);
  const [thinkingTokens, setThinkingTokens] = useState(0);
  // The cap and effort of the reply in progress, when it thinks.
  const [thinkingBudget, setThinkingBudget] = useState<number | null>(null);
  const [replyEffort, setReplyEffort] = useState<Effort | null>(null);
  // Why Auto chose to think for the reply in progress, if it did.
  const [autoReason, setAutoReason] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Images waiting to be sent with the draft, already shrunk, as data URLs.
  const [attachments, setAttachments] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState<number | undefined>(undefined);
  // A web search the model asked for, waiting on the user's answer; and the one running now.
  const [searchRequest, setSearchRequest] = useState<string | null>(null);
  const [searchingFor, setSearchingFor] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Set while the page waits for a reply the server kept writing after the stream dropped.
  const [catchingUp, setCatchingUp] = useState(false);
  // Where older messages were folded into the chat's summary (auto-compact), each shown as a line.
  const [folds, setFolds] = useState<SummaryFold[]>([]);
  // Bumped whenever the view changes chats, so a catch-up for the old one stops.
  const viewRef = useRef(0);
  // Set when this view created the conversation itself, so the id arriving via props
  // doesn't trigger a reload that would wipe the reply still streaming in.
  const createdRef = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (id !== undefined && id === createdRef.current) return;
    abortRef.current?.abort();
    viewRef.current++;
    setCatchingUp(false);
    createdRef.current = undefined;
    setStreamText(null);
    setError('');
    setMessages([]);
    setSearchRequest(null);
    setFolds([]);
    stickToBottom.current = focusMessageId === undefined;
    onContext(null);
    if (id === undefined) return;
    let cancelled = false;
    api.conversation(id).then((r) => {
      if (cancelled) return;
      setMessages(r.messages);
      setSearchRequest(r.pendingSearch?.query ?? null);
      onContext(r.context);
      setFolds(r.folds);
      if (focusMessageId !== undefined) setHighlight(focusMessageId);
      // Opened (or reloaded) while a reply is still being written: wait for it.
      if (r.replying) void catchUp(id);
    }, onError);
    return () => {
      cancelled = true;
    };
  }, [id, focusMessageId, onError, onContext]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Leaving a private chat ends it: the server stops its reply and drops a waiting search.
  useEffect(() => {
    if (!privateChat) return;
    return () => void api.endPrivate(privateId).catch(() => undefined);
  }, [privateChat, privateId]);

  const first = messages[0]?.created_at;
  const last = messages.at(-1)?.created_at;
  useEffect(() => onSpan?.(first && last ? { first, last } : null), [first, last, onSpan]);

  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!privateChat) return;
    onPrivateMessages?.(hasMessages);
    if (!hasMessages) return;
    // Closing or reloading the tab loses it: browsers that allow it ask first.
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [privateChat, hasMessages, onPrivateMessages]);

  useEffect(() => {
    if (startedAt === null) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  // Follow the reply as it streams, unless the reader has scrolled up. A layout effect, so it runs
  // before the browser paints: as a plain effect, a chat opened on reload showed its top for a frame
  // before jumping to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamText]);

  // A message opened from search: bring it into view, and let the highlight fade.
  useEffect(() => {
    if (highlight === undefined) return;
    document.getElementById(`message-${highlight}`)?.scrollIntoView({ block: 'center' });
    const timer = setTimeout(() => setHighlight(undefined), 2500);
    return () => clearTimeout(timer);
  }, [highlight]);

  /**
   * The folds to show after messages[i]: made after it and before the next stored message. This page's
   * own messages have negative ids until it reloads, so a fold is never placed after one of those.
   */
  function foldsAfter(i: number) {
    const m = messages[i]!;
    const next = messages[i + 1]?.id ?? Infinity;
    if (m.id < 0) return [];
    return folds.flatMap((f, n) => (f.afterMessageId >= m.id && (next < 0 || f.afterMessageId < next) ? [{ f, n }] : []));
  }
  const foldNote = ({ f, n }: { f: SummaryFold; n: number }) => (
    <p key={`fold-${n}`} className="fold-note" role="note" title={foldDetail(f)}>
      {foldLine(n)}
    </p>
  );

  const streaming = streamText !== null;
  const busy = streaming || catchingUp;

  /**
   * The stream dropped (a locked phone, a network change) but the server carries on with the reply.
   * Waits until the page is visible again, then checks every couple of seconds until the reply is
   * saved, and shows the chat as stored.
   */
  async function catchUp(conversationId: number) {
    const view = viewRef.current;
    setError('');
    setCatchingUp(true);
    try {
      for (;;) {
        if (document.hidden) await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
        if (viewRef.current !== view) return;
        const r = await api.conversation(conversationId);
        if (viewRef.current !== view) return;
        if (!r.replying) {
          setMessages(r.messages);
          setSearchRequest(r.pendingSearch?.query ?? null);
          onContext(r.context);
          setFolds(r.folds);
          onChanged();
          return;
        }
        await new Promise((r) => setTimeout(r, CATCH_UP_POLL_MS));
      }
    } catch (err) {
      if (viewRef.current !== view) return;
      if (err instanceof ApiError && err.status === 401) onError(err);
      else setError(DROPPED);
    } finally {
      if (viewRef.current === view) setCatchingUp(false);
    }
  }

  /** Stop asks the server; closing the stream alone would let the reply carry on. */
  async function stop() {
    if (privateChat) {
      await api.privateStop(privateId).catch(() => abortRef.current?.abort());
      return;
    }
    const conversationId = id ?? createdRef.current;
    if (conversationId === undefined) return abortRef.current?.abort();
    try {
      await api.stop(conversationId);
    } catch {
      abortRef.current?.abort();
    }
  }

  /** Reads one reply stream into the message list. Returns false if it was refused up front. */
  async function readReply(events: AsyncIterable<StreamEvent>, controller: AbortController, conversationId?: number): Promise<boolean> {
    let reply = '';
    // The stream ended early, but the server keeps writing: catch up once this stream is cleaned up.
    let dropped = false;
    // Moves the streamed text into the message list. The text is copied first: setMessages
    // runs its updater later, and by then `reply` has been reset.
    const elapsed = () => seconds(performance.now() - startedRef.current);
    let thought = false;
    let reason: string | undefined;
    let thoughtEffort: Effort | undefined;
    const keepReply = (messageId?: number, note?: string, selfCorrected?: boolean, sources?: Source[]) => {
      const content = reply;
      reply = '';
      if (!content.trim()) return;
      const message = {
        ...localMessage('assistant', content),
        note,
        fast: !thought,
        selfCorrected,
        effort: thoughtEffort,
        sources: sources ?? null,
      };
      setMessages((m) => [...m, messageId === undefined ? message : { ...message, id: messageId }]);
    };
    try {
      for await (const event of events) {
        if (event.type === 'start') {
          thought = event.think === true;
          reason = event.reason;
          thoughtEffort = thought ? (event.effort ?? 'medium') : undefined;
          setAutoReason(event.reason ?? null);
          setThinkingBudget(event.budget ?? null);
          setReplyEffort(thoughtEffort ?? null);
        } else if (event.type === 'queued') setQueued(true);
        else if (event.type === 'loading') setLoading(true);
        else if (event.type === 'searching') setSearchingFor(event.query);
        else if (event.type === 'search') {
          // The model wants to search: the reply waits for the user's answer on the card.
          reply = '';
          setStreamText(null);
          setSearchRequest(event.query);
        }
        else if (event.type === 'thinking') {
          setQueued(false);
          setLoading(false);
          setThinkingTokens(event.tokens);
        } else if (event.type === 'delta') {
          setQueued(false);
          setLoading(false);
          reply += event.text;
          setStreamText(reply);
        } else if (event.type === 'done') {
          const how = thought
            ? ` · thought first (${EFFORT_LABEL[thoughtEffort ?? 'medium']}${reason ? `, auto: ${reason}` : ''})`
            : '';
          keepReply(event.messageId, `Answered in ${elapsed()} seconds${how}`, event.selfCorrected, event.sources);
          if (event.context) onContext(event.context);
          if (event.folds) setFolds(event.folds);
          setStreamText(null);
          setStartedAt(null);
        } else if (event.type === 'stopped') {
          keepReply(event.messageId, `Stopped after ${elapsed()} seconds`);
          setStreamText(null);
        } else if (event.type === 'error') {
          keepReply();
          setStreamText(null);
          setError(event.error);
        } else if (event.type === 'title') {
          onChanged();
        }
      }
      // The stream ended without done, stopped or error: the connection dropped mid-reply.
      if (reply) dropped = true;
      return true;
    } catch (err) {
      if (controller.signal.aborted) keepReply(undefined, `Stopped after ${elapsed()} seconds`);
      else if (err instanceof ApiError && err.status !== 401) {
        setError(err.message);
        return false;
      } else if (err instanceof ApiError) onError(err);
      // Network failure mid-stream: the server finishes the reply; fetch it when the page is back.
      else dropped = true;
      return true;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setQueued(false);
      setLoading(false);
      setThinkingTokens(0);
      setThinkingBudget(null);
      setReplyEffort(null);
      setAutoReason(null);
      setSearchingFor(null);
      setStreamText(null);
      setStartedAt(null);
      // After a drop the sidebar refresh would fail too; catching up refreshes it once the reply is in.
      // A private reply can't be caught up on: the server never kept it.
      if (dropped && conversationId === undefined) setError(PRIVATE_DROPPED);
      else if (dropped) void catchUp(conversationId!);
      else if (!privateChat) onChanged();
    }
  }

  function begin(): AbortController {
    setError('');
    stickToBottom.current = true;
    setStreamText('');
    startedRef.current = performance.now();
    setStartedAt(startedRef.current);
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }

  async function attach(files: File[]) {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (files.length > room) setError(`At most ${MAX_ATTACHMENTS} images per message.`);
    try {
      const shrunk = await Promise.all(files.slice(0, Math.max(room, 0)).map(shrinkImage));
      setAttachments((a) => [...a, ...shrunk].slice(0, MAX_ATTACHMENTS));
    } catch {
      setError("That image couldn't be opened.");
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFiles(e.clipboardData.files);
    if (files.length === 0) return;
    // Some apps put both the picture and its file name on the clipboard: keep only the picture.
    e.preventDefault();
    void attach(files);
  }

  function onDrop(e: DragEvent<HTMLFormElement>) {
    const files = imageFiles(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    const images = attachments;
    if ((!text && images.length === 0) || busy) return;
    setDraft('');
    setAttachments([]);
    setSearchRequest(null);
    const pending = localMessage('user', text, images);
    setMessages((m) => [...m, pending]);
    const controller = begin();
    if (privateChat) {
      const events = api.privateMessage(privateId, privateHistory([...messages, pending]), images, wire(think), effort, controller.signal);
      if (!(await readReply(events, controller))) {
        setMessages((m) => m.filter((msg) => msg !== pending));
        setDraft(text);
        setAttachments(images);
      }
      return;
    }

    let conversationId = id ?? createdRef.current;
    try {
      if (conversationId === undefined) {
        conversationId = (await api.createConversation()).id;
        createdRef.current = conversationId;
        onCreated(conversationId);
      }
    } catch (err) {
      setStreamText(null);
      setMessages((m) => m.filter((msg) => msg !== pending));
      setDraft(text);
      setAttachments(images);
      onError(err);
      return;
    }
    if (!(await readReply(api.sendMessage(conversationId, text, images, wire(think), effort, controller.signal), controller, conversationId))) {
      // Refused before it was saved: take the message back out and restore the draft.
      setMessages((m) => m.filter((msg) => msg !== pending));
      setDraft(text);
      setAttachments(images);
    }
  }

  // Regenerates the answer to the last question, replacing the last reply if there is one.
  // `thinkAt` forces thinking at that effort regardless of the settings (the self-correction offer,
  // and "think harder" after a reply that thought).
  async function retry(thinkAt?: Effort) {
    if (privateChat) {
      if (busy) return;
      const asked = messages.at(-1)?.role === 'assistant' ? messages.slice(0, -1) : messages;
      setMessages(asked);
      setSearchRequest(null);
      const controller = begin();
      // The question's images, if this page still has them, go again.
      const images = asked.at(-1)?.previews ?? [];
      const history = privateHistory(asked);
      const events = thinkAt
        ? api.privateMessage(privateId, history, images, true, thinkAt, controller.signal)
        : api.privateMessage(privateId, history, images, wire(think), effort, controller.signal);
      await readReply(events, controller);
      return;
    }
    const conversationId = id ?? createdRef.current;
    if (conversationId === undefined || busy) return;
    setMessages((m) => (m.at(-1)?.role === 'assistant' ? m.slice(0, -1) : m));
    setSearchRequest(null);
    const controller = begin();
    const events = thinkAt ? api.retry(conversationId, true, thinkAt, controller.signal) : api.retry(conversationId, wire(think), effort, controller.signal);
    await readReply(events, controller, conversationId);
  }

  // The answer to a search card. Only Search sends the query anywhere; the server enforces it.
  async function answerSearch(approve: boolean) {
    if (privateChat) {
      if (busy) return;
      setSearchRequest(null);
      const controller = begin();
      await readReply(api.privateSearch(privateId, approve, controller.signal), controller);
      return;
    }
    const conversationId = id ?? createdRef.current;
    if (conversationId === undefined || busy) return;
    setSearchRequest(null);
    const controller = begin();
    await readReply(api.answerSearch(conversationId, approve, controller.signal), controller, conversationId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className={`conversation${privateChat ? ' private' : ''}`}>
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
        aria-busy={busy}
      >
        <div className="thread">
        {privateChat && (
          <p className="private-note" role="note">
            Private chat: not saved and not remembered. hearth still knows what it remembers about you, but
            nothing from here is kept. It ends when you leave or reload this page.
          </p>
        )}
        {messages.length === 0 && !streaming && <p className="empty">{privateChat ? `Just between us, ${name}.` : `What's on your mind, ${name}?`}</p>}
        {messages.map((m, i) => {
          // A break in the chat ("3 days later"): the model is told the same about the newest message.
          const gap = i > 0 ? timeGap(messages[i - 1]!.created_at, m.created_at) : '';
          // Folds after this message and before the next one; after the last, they go below its buttons.
          const foldsHere = i < messages.length - 1 ? foldsAfter(i) : [];
          return (
            <Fragment key={m.id}>
              {gap && (
                <p className="time-gap" role="separator">
                  <span>{gap} later</span>
                </p>
              )}
              <MessageBubble message={m} highlight={m.id === highlight} />
              {foldsHere.map(foldNote)}
            </Fragment>
          );
        })}
        {streaming &&
          (streamText ? (
            <>
              <MessageBubble message={{ role: 'assistant', content: streamText }} streaming />
              <p className="reply-note" aria-hidden="true">
                {seconds(now - (startedAt ?? now))}s
              </p>
            </>
          ) : (
            <div className="message assistant pending">
              {pendingText({
                searchingFor,
                queued,
                loading,
                thinkingTokens,
                thinkingBudget,
                effortLabel: replyEffort ? EFFORT_LABEL[replyEffort] : null,
                autoReason,
                waitedMs: now - (startedAt ?? now),
              })}
              {/* Hidden from screen readers: a number changing ten times a second would drown them out. */}
              <span className="elapsed" aria-hidden="true">
                {seconds(now - (startedAt ?? now))}s
              </span>
            </div>
          ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {catchingUp && !streaming && (
          <div className="message assistant pending">Still writing… the reply carried on while you were away</div>
        )}
        {!busy && searchRequest && (
          <div className="search-card" role="group" aria-label="Web search request">
            <p>hearth wants to search the web for:</p>
            <p className="search-query">{searchRequest}</p>
            <p className="small muted">
              Nothing is searched unless you say so. The query goes to your SearXNG, which asks Google, Bing and other engines.
            </p>
            <div className="search-actions">
              <button type="button" onClick={() => answerSearch(true)}>
                Search
              </button>
              <button type="button" className="link" onClick={() => answerSearch(false)}>
                Answer without searching
              </button>
            </div>
          </div>
        )}
        {!busy && !searchRequest && messages.length > 0 && (
          <div className="retry-row">
            <button type="button" className="link" onClick={() => retry()}>
              {messages.at(-1)!.role === 'assistant' ? '↻ Regenerate' : '↻ Retry'}
            </button>
            {(messages.at(-1)!.fast || messages.at(-1)!.selfCorrected) && (
              <button
                type="button"
                className="link"
                title={
                  messages.at(-1)!.selfCorrected
                    ? `This reply corrected itself partway through. Re-answer with thinking on (${EFFORT_LABEL[effort]}).`
                    : `This reply answered without thinking. Re-answer with thinking on (${EFFORT_LABEL[effort]}): slower, and better at checking details.`
                }
                onClick={() => retry(effort)}
              >
                ↻ Re-answer with thinking
              </button>
            )}
            {(() => {
              // After a reply that thought: offer the next level up, until Max.
              const used = messages.at(-1)!.effort;
              const harder = used && higherEffort(used);
              return harder ? (
                <button
                  type="button"
                  className="link"
                  title={`This reply thought at ${EFFORT_LABEL[used]}. Re-answer with more room to think: ${EFFORT_LABEL[harder]}. Slower.`}
                  onClick={() => retry(harder)}
                >
                  ↻ Think harder ({EFFORT_LABEL[harder]})
                </button>
              ) : null;
            })()}
          </div>
        )}
        {messages.length > 0 && foldsAfter(messages.length - 1).map(foldNote)}
        </div>
      </div>

      <form className="composer" onSubmit={submit} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {attachments.length > 0 && (
          <ul className="attachments" aria-label="Images to send">
            {attachments.map((src, i) => (
              <li key={i}>
                <img src={src} alt={`Image ${i + 1} to send`} />
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove image ${i + 1}`}
                  onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="visually-hidden" htmlFor="composer-input">
          Message
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attach(imageFiles(e.target.files));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="attach"
          title="Add images (or paste or drop them here). hearth describes them after replying and keeps only the description."
          aria-label="Add images"
          disabled={attachments.length >= MAX_ATTACHMENTS}
          onClick={() => fileInputRef.current?.click()}
        >
          +
        </button>
        <textarea
          id="composer-input"
          rows={1}
          placeholder={privateChat ? 'Message hearth privately' : 'Message hearth'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          autoFocus
        />
        <button
          type="button"
          className={`think-toggle ${think}`}
          title={`${THINK_HELP[think]} Click to change.`}
          aria-label={THINK_HELP[think]}
          onClick={() => {
            const next = NEXT_SETTING[think];
            setThink(next);
            saveThink(next);
          }}
        >
          Think: {think === 'auto' ? 'Auto' : think === 'on' ? 'On' : 'Off'}
        </button>
        {think !== 'off' && (
          <button
            type="button"
            className={`effort-toggle ${effort}`}
            title={`${EFFORT_HELP[effort]} Click to change.`}
            aria-label={EFFORT_HELP[effort]}
            onClick={() => {
              const next = EFFORTS[(EFFORTS.indexOf(effort) + 1) % EFFORTS.length]!;
              setEffort(next);
              saveEffort(next);
            }}
          >
            {EFFORT_LABEL[effort]}
          </button>
        )}
        {busy ? (
          <button type="button" className="stop" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim() && attachments.length === 0}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

type BubbleProps = {
  message: Pick<ViewMessage, 'role' | 'content'> & Partial<ViewMessage>;
  highlight?: boolean;
  /** The reply still arriving: no Raw button yet. */
  streaming?: boolean;
};

// Memoized: every keystroke in the composer re-renders this view, and re-parsing every message's
// Markdown made typing lag in long chats (~36 ms a key at 166 messages). A message re-renders only
// when it, or its highlight, changes.
/** A fenced code block (``` or ~~~) anywhere in the text: the only replies that get Show raw. */
const hasCodeFence = (text: string) => /^ {0,3}(`{3,}|~{3,})/m.test(text);

const MessageBubble = memo(function MessageBubble({ message, highlight, streaming = false }: BubbleProps) {
  const { id, role, content } = message;
  // Raw: a reply's text exactly as stored, Markdown and all, to read or copy as sent.
  const [raw, setRaw] = useState(false);
  const className = `message ${role}${highlight ? ' highlight' : ''}`;
  const domId = id !== undefined && id > 0 ? `message-${id}` : undefined;
  // Replies only (your own messages show as you typed them), and only with a code block: on plain
  // prose, raw just shows the same words with asterisks (owner's call).
  const canShowRaw = role === 'assistant' && !streaming && hasCodeFence(content);
  const body = raw ? (
    <pre className="raw">{content}</pre>
  ) : (
    <MessageMarkdown text={role === 'user' ? content : plainSymbols(content)} typed={role === 'user'} />
  );
  return (
    <div className={`bubble ${role}`}>
      <div id={domId} className={className}>
        {role === 'user' && <MessageImages message={message} />}
        {body}
        {role === 'assistant' && message.sources?.length ? <Sources sources={message.sources} /> : null}
      </div>
      {(canShowRaw || (role === 'assistant' && message.note)) && (
        <div className="message-meta">
          {message.note && <p className="reply-note">{message.note}</p>}
          {canShowRaw && (
          <button
            type="button"
            className={`link raw-toggle${raw ? ' on' : ''}`}
            title={raw ? 'Showing the exact text. Show this message rendered' : 'Show the exact text of this message, Markdown and all'}
            onClick={() => setRaw((r) => !r)}
          >
            {/* Names what a tap does, and says so: a bare "Rendered" read as the current state. */}
            {raw ? 'Show rendered' : 'Show raw'}
          </button>
          )}
        </div>
      )}
    </div>
  );
});

const site = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** The pages a reply drew on, one pill per site (its first page). */
function Sources({ sources }: { sources: Source[] }) {
  const bySite = new Map<string, Source>();
  for (const s of sources) if (!bySite.has(site(s.url))) bySite.set(site(s.url), s);
  return (
    <ul className="sources" aria-label="Sources">
      {[...bySite].map(([name, s]) => (
        <li key={name}>
          <a href={s.url} title={s.title} target="_blank" rel="noreferrer noopener">
            {name}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Images sent from this tab, or else what hearth kept of them: its description. */
function MessageImages({ message }: { message: BubbleProps['message'] }) {
  const count = message.image_count ?? 0;
  if (message.previews?.length) {
    return (
      <div className="message-images">
        {message.previews.map((src, i) => (
          <img key={i} src={src} alt={`Sent image ${i + 1}`} />
        ))}
      </div>
    );
  }
  if (count === 0) return null;
  const images = count === 1 ? 'Image' : `${count} images`;
  if (!message.image_note) return <p className="image-note muted">{images}, not kept and not described</p>;
  return (
    <details className="image-note">
      <summary>{images}, as hearth described {count === 1 ? 'it' : 'them'}</summary>
      {message.image_note}
    </details>
  );
}
