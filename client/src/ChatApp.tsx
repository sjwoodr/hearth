import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, onModelHeader, type ContextUse, type Conversation, type Me, type ModelHeader, type SearchHit } from './api.ts';
import { chatSpan } from '../../shared/chat-span.ts';
import { ContextMeter } from './ContextMeter.tsx';
import { ConversationView } from './ConversationView.tsx';
import { MemoriesView } from './MemoriesView.tsx';
import { ModelPicker } from './ModelPicker.tsx';

const readHash = (): number | undefined => {
  const match = /^#\/c\/(\d+)$/.exec(location.hash);
  return match ? Number(match[1]) : undefined;
};
const onMemoriesPage = () => location.hash === '#/memories';
const onPrivatePage = () => location.hash === '#/private';
const LEAVE_PRIVATE = "Leave this private chat? It isn't saved anywhere, so it will be gone.";

/** A search snippet with its \u0002…\u0003 matches as <mark>, never as HTML. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split('\u0002').map((part, i) => {
        if (i === 0) return part;
        const [match, rest] = part.split('\u0003');
        return (
          <span key={i}>
            <mark>{match}</mark>
            {rest}
          </span>
        );
      })}
    </>
  );
}

export function ChatApp({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState(readHash);
  const [showMemories, setShowMemories] = useState(onMemoriesPage);
  // A private chat in progress: a fresh number per private chat, so starting another starts clean.
  const [privateChat, setPrivateChat] = useState<number | null>(() => (onPrivatePage() ? 1 : null));
  const privateHasMessages = useRef(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [focusMessageId, setFocusMessageId] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState('');
  // The model in use, from the X-Hearth-Model header on every answer. An admin's switch shows up on
  // this browser's next request with a notice, unless this browser made it.
  const [model, setModel] = useState<ModelHeader | undefined>(undefined);
  const [modelNotice, setModelNotice] = useState('');
  const [picking, setPicking] = useState(false);
  const [revealChange, setRevealChange] = useState(false);
  // The open chat's context use, reported by ConversationView.
  const [context, setContext] = useState<ContextUse | null>(null);
  // When the open chat ran, from its first and last message (reported by ConversationView).
  const [span, setSpan] = useState<{ first: string; last: string } | null>(null);
  const seenModel = useRef<string | undefined>(undefined);

  useEffect(
    () =>
      onModelHeader((m) => {
        setModel((prev) => (prev?.model === m.model && prev.isDefault === m.isDefault ? prev : m));
        const before = seenModel.current;
        seenModel.current = m.model;
        if (before === undefined || before === m.model) return;
        setModelNotice(
          m.isDefault
            ? `Back to ${m.model}, the default model.`
            : `The model is now ${m.model} (changed by an admin). The next reply may take about 15 s while it loads.`,
        );
      }),
    [],
  );

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(err instanceof Error ? err.message : String(err));
    },
    [onSignedOut],
  );

  const refresh = useCallback(() => {
    api.conversations().then(setConversations, handleError);
  }, [handleError]);

  useEffect(refresh, [refresh]);

  // Search as you type, a moment after the last keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.search(q).then((r) => !cancelled && setHits(r), handleError);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, handleError]);

  useEffect(() => {
    const onHash = () => {
      setActiveId(readHash());
      setShowMemories(onMemoriesPage());
      setPrivateChat((p) => (onPrivatePage() ? (p ?? 1) : null));
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  /** True when it's fine to leave the current view: not a private chat with messages, or the user agreed. */
  const mayLeave = () => privateChat === null || !privateHasMessages.current || window.confirm(LEAVE_PRIVATE);
  const leavePrivate = () => {
    privateHasMessages.current = false;
    setPrivateChat(null);
  };

  const open = (id: number | undefined, messageId?: number) => {
    setNewMenuOpen(false);
    if (!mayLeave()) return;
    leavePrivate();
    history.pushState(null, '', id ? `#/c/${id}` : location.pathname);
    setActiveId(id);
    setFocusMessageId(messageId);
    setShowMemories(false);
    setSidebarOpen(false);
    setError('');
  };

  const openPrivate = () => {
    setNewMenuOpen(false);
    if (!mayLeave()) return;
    privateHasMessages.current = false;
    history.pushState(null, '', '#/private');
    setPrivateChat((p) => (p ?? 0) + 1);
    setActiveId(undefined);
    setShowMemories(false);
    setSidebarOpen(false);
    setError('');
  };

  const openMemories = () => {
    if (!mayLeave()) return;
    leavePrivate();
    history.pushState(null, '', '#/memories');
    setActiveId(undefined);
    setShowMemories(true);
    setSidebarOpen(false);
    setError('');
  };

  async function rename(c: Conversation) {
    const title = window.prompt('Rename chat', c.title ?? '')?.trim();
    if (!title || title === c.title) return;
    await api.renameConversation(c.id, title).catch(handleError);
    refresh();
  }

  async function remove(c: Conversation) {
    if (!window.confirm(`Delete "${c.title ?? 'New chat'}"? This can't be undone.`)) return;
    await api.deleteConversation(c.id).catch(handleError);
    if (c.id === activeId) open(undefined);
    refresh();
  }

  const onPrivateMessages = useCallback((has: boolean) => {
    privateHasMessages.current = has;
  }, []);

  const active = conversations.find((c) => c.id === activeId);
  const spanText = span ? chatSpan(span.first, span.last) : '';

  return (
    <div className={`chat-app${sidebarOpen ? ' sidebar-open' : ''}`}>
      <aside className="sidebar" aria-label="Chats">
        <div className="sidebar-head">
          <h1 className="brand">
            {/* Tapping the name reloads (the open chat is in the URL hash, so it stays open): the only
                way to reload in the Home Screen app, which has no browser toolbar. */}
            <button type="button" title="Reload hearth" onClick={() => location.reload()}>
              {/* Decorative next to the name: the favicon's small-size version of the app icon. */}
              <img src="/favicon.svg" alt="" width="28" height="28" />
              hearth
            </button>
          </h1>
          {/* New chat, with a menu (▾) for a private one. */}
          <div className="new-chat" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setNewMenuOpen(false)}>
            <button type="button" onClick={() => open(undefined)}>
              New chat
            </button>
            <button
              type="button"
              className="new-chat-more"
              aria-label="More ways to start a chat"
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen((o) => !o)}
            >
              ▾
            </button>
            {newMenuOpen && (
              <div className="new-chat-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => open(undefined)}>
                  New chat
                </button>
                <button type="button" role="menuitem" onClick={openPrivate}>
                  New private chat
                  <span className="small muted">Not saved, not remembered</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="search">
          <label className="visually-hidden" htmlFor="chat-search">
            Search chats
          </label>
          <input
            id="chat-search"
            type="search"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </div>
        <nav>
          {hits !== null ? (
            hits.length === 0 ? (
              <p className="muted">No matches.</p>
            ) : (
              <ul className="hits">
                {hits.map((h) => (
                  <li key={h.messageId}>
                    <a
                      href={`#/c/${h.conversationId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        open(h.conversationId, h.messageId);
                      }}
                    >
                      <span className="hit-title">{h.title ?? 'New chat'}</span>
                      <span className="hit-snippet">
                        <Snippet text={h.snippet} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )
          ) : (
            conversations.length === 0 && <p className="muted">No chats yet.</p>
          )}
          <ul hidden={hits !== null}>
            {conversations.map((c) => (
              <li key={c.id} className={c.id === activeId ? 'active' : undefined}>
                <a
                  href={`#/c/${c.id}`}
                  aria-current={c.id === activeId ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    open(c.id);
                  }}
                >
                  {c.title ?? 'New chat'}
                </a>
                <button type="button" className="icon" title="Rename" aria-label={`Rename ${c.title ?? 'chat'}`} onClick={() => rename(c)}>
                  ✎
                </button>
                <button type="button" className="icon" title="Delete" aria-label={`Delete ${c.title ?? 'chat'}`} onClick={() => remove(c)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {model && (
          // The whole name shows; an admin's Change appears over its end on hover (or keyboard focus),
          // and on a touch screen a tap on the line reveals it.
          <div
            className={`sidebar-model${me.isAdmin ? ' admin' : ''}${revealChange ? ' revealed' : ''}`}
            onClick={me.isAdmin ? () => setRevealChange((r) => !r) : undefined}
          >
            <span className="muted model-label" title={`${model.model}: ${model.isDefault ? 'the default model' : 'switched by an admin'}`}>
              Model: <span className={model.isDefault ? undefined : 'switched'}>{model.model}</span>
            </span>
            {me.isAdmin && (
              <button
                type="button"
                className="link change"
                onClick={(e) => {
                  e.stopPropagation();
                  setRevealChange(false);
                  setPicking(true);
                }}
              >
                Change
              </button>
            )}
          </div>
        )}
        <div className="sidebar-foot">
          <button
            type="button"
            className={`link${showMemories ? ' current' : ''}`}
            aria-current={showMemories ? 'page' : undefined}
            onClick={openMemories}
          >
            Memories
          </button>
          <span title={`Signed in as ${me.username}`}>{me.name}</span>
          <button type="button" className="link" onClick={() => api.logout().finally(onSignedOut)}>
            Sign out
          </button>
        </div>
      </aside>
      <button type="button" className="scrim" aria-label="Close chat list" tabIndex={-1} onClick={() => setSidebarOpen(false)} />

      <main className={`chat-main${privateChat !== null && !showMemories ? ' private' : ''}`}>
        <header className="chat-top">
          <button
            type="button"
            className="icon menu-toggle"
            aria-label="Show chats"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((o) => !o)}
          >
            ☰
          </button>
          <span className="chat-title">
            {showMemories ? 'Memories' : privateChat !== null ? 'Private chat' : (active?.title ?? 'New chat')}
            {!showMemories && spanText && <span className="chat-span"> ({spanText})</span>}
          </span>
          {!showMemories && privateChat === null && context && <ContextMeter context={context} />}
          {/* Shown only when hearth runs as a Home Screen app (no browser toolbar, so no reload); the
              name at the top of the chat list reloads too. */}
          <button type="button" className="icon reload" aria-label="Reload hearth" title="Reload" onClick={() => location.reload()}>
            ↻
          </button>
        </header>
        {error && (
          <p className="error banner" role="alert">
            {error}
          </p>
        )}
        {modelNotice && (
          <p className="notice banner" role="status">
            {modelNotice}
            <button type="button" className="icon" aria-label="Dismiss" onClick={() => setModelNotice('')}>
              ✕
            </button>
          </p>
        )}
        {picking && (
          <ModelPicker
            onClose={() => setPicking(false)}
            onSwitched={(active) => {
              // This browser made the switch, so the next header showing it isn't news.
              seenModel.current = active.model;
              setModel({ model: active.model, isDefault: active.isDefault });
              setModelNotice('');
            }}
          />
        )}
        {showMemories ? (
          <MemoriesView onOpenChat={open} onError={handleError} />
        ) : (
          <ConversationView
            key={privateChat !== null ? `private-${privateChat}` : 'stored'}
            privateChat={privateChat !== null}
            onPrivateMessages={onPrivateMessages}
            id={activeId}
            focusMessageId={focusMessageId}
            name={me.name}
            onCreated={(id) => {
              history.pushState(null, '', `#/c/${id}`);
              setActiveId(id);
            }}
            onChanged={refresh}
            onError={handleError}
            onContext={setContext}
            onSpan={setSpan}
          />
        )}
      </main>
    </div>
  );
}
