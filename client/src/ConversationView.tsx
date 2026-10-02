import { Fragment, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError, type Message, type StreamEvent } from './api.ts';
import { imageFiles, MAX_ATTACHMENTS, shrinkImage } from './images.ts';

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
 * `selfCorrected` marks a fast reply that caught itself mid-answer, to offer thinking.
 * `previews` are images sent from this page, kept in this tab only: the server never stores
 * them, so after a reload a message shows hearth's description of its images instead.
 */
type ViewMessage = Message & { note?: string; selfCorrected?: boolean; previews?: string[] };

const seconds = (ms: number) => (ms / 1000).toFixed(1);

let tempId = 0;
const localMessage = (role: Message['role'], content: string, previews: string[] = []): ViewMessage => ({
  id: --tempId,
  role,
  content,
  image_count: previews.length,
  image_note: null,
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
  const [think, setThink] = useState<ThinkSetting>(loadThink);
  const [thinkingTokens, setThinkingTokens] = useState(0);
  // Why Auto chose to think for the reply in progress, if it did.
  const [autoReason, setAutoReason] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Images waiting to be sent with the draft, already shrunk, as data URLs.
  const [attachments, setAttachments] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState<number | undefined>(undefined);
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
    stickToBottom.current = focusMessageId === undefined;
    if (id === undefined) return;
    let cancelled = false;
    api.conversation(id).then((r) => {
      if (cancelled) return;
      setMessages(r.messages);
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
    const keepReply = (messageId?: number, note?: string, selfCorrected?: boolean) => {
      const content = reply;
      reply = '';
      if (!content.trim()) return;
      const message = { ...localMessage('assistant', content), note, selfCorrected };
      setMessages((m) => [...m, messageId === undefined ? message : { ...message, id: messageId }]);
    };
    try {
      for await (const event of events) {
        if (event.type === 'start') {
          thought = event.think === true;
          reason = event.reason;
          setAutoReason(event.reason ?? null);
        } else if (event.type === 'queued') setQueued(true);
        else if (event.type === 'thinking') {
          setQueued(false);
          setThinkingTokens(event.tokens);
        } else if (event.type === 'delta') {
          setQueued(false);
          reply += event.text;
          setStreamText(reply);
        } else if (event.type === 'done') {
          const how = thought ? (reason ? ` · thought first (auto: ${reason})` : ' · thought first') : '';
          keepReply(event.messageId, `Answered in ${elapsed()} seconds${how}`, event.selfCorrected);
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
      setThinkingTokens(0);
      setAutoReason(null);
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
    if (!(await readReply(api.sendMessage(conversationId, text, images, wire(think), controller.signal), controller))) {
      // Refused before it was saved: take the message back out and restore the draft.
      setMessages((m) => m.filter((msg) => msg !== pending));
      setDraft(text);
      setAttachments(images);
    }
  }

  // Regenerates the answer to the last question, replacing the last reply if there is one.
  // `withThinking` forces thinking regardless of the setting (the self-correction offer).
  async function retry(withThinking = false) {
    const conversationId = id ?? createdRef.current;
    if (conversationId === undefined || streaming) return;
    setMessages((m) => (m.at(-1)?.role === 'assistant' ? m.slice(0, -1) : m));
    const controller = begin();
    await readReply(api.retry(conversationId, withThinking ? true : wire(think), controller.signal), controller);
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
          <Fragment key={m.id}>
            <MessageBubble message={m} highlight={m.id === highlight} />
            {m.note && <p className="reply-note">{m.note}</p>}
          </Fragment>
        ))}
        {streaming &&
          (streamText ? (
            <>
              <MessageBubble message={{ role: 'assistant', content: streamText }} />
              <p className="reply-note" aria-hidden="true">
                {seconds(now - (startedAt ?? now))}s
              </p>
            </>
          ) : (
            <div className="message assistant pending">
              {queued
                ? 'Waiting for the model to finish another reply…'
                : thinkingTokens > 0
                  ? `Thinking… ${thinkingTokens}${autoReason ? ` · auto: ${autoReason}` : ''}`
                  : '…'}
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
        {!streaming && messages.length > 0 && (
          <div className="retry-row">
            <button type="button" className="link" onClick={() => retry()}>
              {messages.at(-1)!.role === 'assistant' ? '↻ Regenerate' : '↻ Retry'}
            </button>
            {messages.at(-1)!.selfCorrected && (
              <button
                type="button"
                className="link"
                title="This reply corrected itself partway through. Re-answer with thinking on."
                onClick={() => retry(true)}
              >
                ↻ Re-answer with thinking
              </button>
            )}
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
        {streaming ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>
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
};

function MessageBubble({ message, highlight }: BubbleProps) {
  const { id, role, content } = message;
  const className = `message ${role}${highlight ? ' highlight' : ''}`;
  const domId = id !== undefined && id > 0 ? `message-${id}` : undefined;
  if (role === 'user') {
    return (
      <div id={domId} className={className}>
        <MessageImages message={message} />
        {content}
      </div>
    );
  }
  return (
    <div id={domId} className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {content}
      </Markdown>
    </div>
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
