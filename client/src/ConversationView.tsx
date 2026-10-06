import { memo, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError, type Message, type Source, type StreamEvent } from './api.ts';
import { imageFiles, MAX_ATTACHMENTS, shrinkImage } from './images.ts';
import { MessageMarkdown } from './Markdown.tsx';
import { plainSymbols } from '../../shared/plain-symbols.ts';
import { pendingText } from '../../shared/pending-text.ts';
import { EFFORT_LABEL, EFFORTS, higherEffort, isEffort, type Effort } from '../../shared/think-effort.ts';

type Props = {
  id: number | undefined;
  name: string;
  /** A message to scroll to and highlight once the chat loads (from search). */
  focusMessageId?: number;
  onCreated: (id: number) => void;
  onChanged: () => void;
  onError: (err: unknown) => void;
};

/**
 * A message as shown here. `note` is this session's timing line ("Answered in 12.3 seconds");
 * `selfCorrected` marks a fast reply that caught itself mid-answer, to offer thinking; `effort`
 * is how hard a reply thought, to offer thinking harder.
 * `previews` are images sent from this page, kept in this tab only: the server never stores
 * them, so after a reload a message shows hearth's description of its images instead.
 */
type ViewMessage = Message & { note?: string; selfCorrected?: boolean; effort?: Effort; previews?: string[] };

const seconds = (ms: number) => (ms / 1000).toFixed(1);

let tempId = 0;
const localMessage = (role: Message['role'], content: string, previews: string[] = []): ViewMessage => ({
  id: --tempId,
  role,
  content,
  image_count: previews.length,
  image_note: null,
  sources: null,
  created_at: '',
  ...(previews.length ? { previews } : {}),
});

const DROPPED = 'The connection dropped before the reply finished. Reload to see what was saved.';

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

export function ConversationView({ id, name, focusMessageId, onCreated, onChanged, onError }: Props) {
  const [messages, setMessages] = useState<ViewMessage[]>([]);
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
  // Set when this view created the conversation itself, so the id arriving via props
  // doesn't trigger a reload that would wipe the reply still streaming in.
  const createdRef = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (id !== undefined && id === createdRef.current) return;
    abortRef.current?.abort();
    createdRef.current = undefined;
    setStreamText(null);
    setError('');
    setMessages([]);
    setSearchRequest(null);
    stickToBottom.current = focusMessageId === undefined;
    if (id === undefined) return;
    let cancelled = false;
    api.conversation(id).then((r) => {
      if (cancelled) return;
      setMessages(r.messages);
      setSearchRequest(r.pendingSearch?.query ?? null);
      if (focusMessageId !== undefined) setHighlight(focusMessageId);
    }, onError);
    return () => {
      cancelled = true;
    };
  }, [id, focusMessageId, onError]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (startedAt === null) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  // Follow the reply as it streams, unless the reader has scrolled up.
  useEffect(() => {
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

  const streaming = streamText !== null;

  /** Reads one reply stream into the message list. Returns false if it was refused up front. */
  async function readReply(events: AsyncIterable<StreamEvent>, controller: AbortController): Promise<boolean> {
    let reply = '';
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
      const message = { ...localMessage('assistant', content), note, selfCorrected, effort: thoughtEffort, sources: sources ?? null };
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
          setStreamText(null);
          setStartedAt(null);
        } else if (event.type === 'error') {
          keepReply();
          setStreamText(null);
          setError(event.error);
        } else if (event.type === 'title') {
          onChanged();
        }
      }
      // The stream ended without done or error: the server went away mid-reply.
      if (reply) {
        keepReply();
        setError(DROPPED);
      }
      return true;
    } catch (err) {
      if (controller.signal.aborted) keepReply(undefined, `Stopped after ${elapsed()} seconds`);
      else if (err instanceof ApiError && err.status !== 401) {
        setError(err.message);
        return false;
      } else if (err instanceof ApiError) onError(err);
      else {
        // Network failure mid-stream: keep what arrived rather than dropping it.
        keepReply();
        setError(DROPPED);
      }
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
      onChanged();
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
    if ((!text && images.length === 0) || streaming) return;
    setDraft('');
    setAttachments([]);
    setSearchRequest(null);
    const pending = localMessage('user', text, images);
    setMessages((m) => [...m, pending]);
    const controller = begin();

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
    if (!(await readReply(api.sendMessage(conversationId, text, images, wire(think), effort, controller.signal), controller))) {
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
    const conversationId = id ?? createdRef.current;
    if (conversationId === undefined || streaming) return;
    setMessages((m) => (m.at(-1)?.role === 'assistant' ? m.slice(0, -1) : m));
    setSearchRequest(null);
    const controller = begin();
    const events = thinkAt ? api.retry(conversationId, true, thinkAt, controller.signal) : api.retry(conversationId, wire(think), effort, controller.signal);
    await readReply(events, controller);
  }

  // The answer to a search card. Only Search sends the query anywhere; the server enforces it.
  async function answerSearch(approve: boolean) {
    const conversationId = id ?? createdRef.current;
    if (conversationId === undefined || streaming) return;
    setSearchRequest(null);
    const controller = begin();
    await readReply(api.answerSearch(conversationId, approve, controller.signal), controller);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="conversation">
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
        aria-busy={streaming}
      >
        <div className="thread">
        {messages.length === 0 && !streaming && <p className="empty">What's on your mind, {name}?</p>}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} highlight={m.id === highlight} />
        ))}
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
        {!streaming && searchRequest && (
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
        {!streaming && !searchRequest && messages.length > 0 && (
          <div className="retry-row">
            <button type="button" className="link" onClick={() => retry()}>
              {messages.at(-1)!.role === 'assistant' ? '↻ Regenerate' : '↻ Retry'}
            </button>
            {messages.at(-1)!.selfCorrected && (
              <button
                type="button"
                className="link"
                title={`This reply corrected itself partway through. Re-answer with thinking on (${EFFORT_LABEL[effort]}).`}
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
          placeholder="Message hearth"
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
        {streaming ? (
          <button type="button" className="stop" onClick={() => abortRef.current?.abort()}>
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
const MessageBubble = memo(function MessageBubble({ message, highlight, streaming = false }: BubbleProps) {
  const { id, role, content } = message;
  // Raw: the text exactly as stored, Markdown and all, to read or copy as sent.
  const [raw, setRaw] = useState(false);
  const className = `message ${role}${highlight ? ' highlight' : ''}`;
  const domId = id !== undefined && id > 0 ? `message-${id}` : undefined;
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
      {!streaming && content && (
        <div className="message-meta">
          {message.note && <p className="reply-note">{message.note}</p>}
          <button
            type="button"
            className="link raw-toggle"
            aria-pressed={raw}
            title={raw ? 'Show this message rendered' : 'Show the exact text of this message, Markdown and all'}
            onClick={() => setRaw((r) => !r)}
          >
            {raw ? 'Rendered' : 'Raw'}
          </button>
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
