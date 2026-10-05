import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Conversation, type Me, type SearchHit } from './api.ts';
import { ConversationView } from './ConversationView.tsx';
import { MemoriesView } from './MemoriesView.tsx';

const readHash = (): number | undefined => {
  const match = /^#\/c\/(\d+)$/.exec(location.hash);
  return match ? Number(match[1]) : undefined;
};
const onMemoriesPage = () => location.hash === '#/memories';

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
  const [focusMessageId, setFocusMessageId] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState('');

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
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  const open = (id: number | undefined, messageId?: number) => {
    history.pushState(null, '', id ? `#/c/${id}` : location.pathname);
    setActiveId(id);
    setFocusMessageId(messageId);
    setShowMemories(false);
    setSidebarOpen(false);
    setError('');
  };

  const openMemories = () => {
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

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className={`chat-app${sidebarOpen ? ' sidebar-open' : ''}`}>
      <aside className="sidebar" aria-label="Chats">
        <div className="sidebar-head">
          <h1 className="brand">
            {/* Decorative next to the name: the favicon's small-size version of the app icon. */}
            <img src="/favicon.svg" alt="" width="28" height="28" />
            hearth
          </h1>
          <button type="button" onClick={() => open(undefined)}>
            New chat
          </button>
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

      <main className="chat-main">
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
          <span className="chat-title">{showMemories ? 'Memories' : (active?.title ?? 'New chat')}</span>
        </header>
        {error && (
          <p className="error banner" role="alert">
            {error}
          </p>
        )}
        {showMemories ? (
          <MemoriesView onOpenChat={open} onError={handleError} />
        ) : (
          <ConversationView
            id={activeId}
            focusMessageId={focusMessageId}
            name={me.name}
            onCreated={(id) => {
              history.pushState(null, '', `#/c/${id}`);
              setActiveId(id);
            }}
            onChanged={refresh}
            onError={handleError}
          />
        )}
      </main>
    </div>
  );
}
