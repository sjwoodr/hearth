import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Memory, type MemoryKind } from './api.ts';

const MAX_CHARS = 400;

const SECTIONS: { kind: MemoryKind; title: string; blurb: string }[] = [
  {
    kind: 'profile',
    title: 'Always remembered',
    blurb: 'Included in every chat. hearth never adds these itself: promote a memory with "Always remember". Keep these few.',
  },
  {
    kind: 'fact',
    title: 'Recalled when relevant',
    blurb: 'Learned from your chats, and brought in when a message is about the same thing.',
  },
];

export function MemoriesView({ onOpenChat, onError }: { onOpenChat: (id: number) => void; onError: (err: unknown) => void }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.memories().then(setMemories, onError);
  }, [onError]);
  useEffect(load, [load]);

  // Field errors (too long, empty) show here; anything else goes up to the app.
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      load();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setError(err.message);
      else onError(err);
      return false;
    }
  };

  return (
    <div className="memories">
      <div className="memories-inner">
        <p className="muted">
          What hearth has learned about you from your chats, or that you added yourself. Edit or delete anything that's
          wrong: a wrong memory comes back in every future chat.
        </p>
        <AddMemory onAdd={(kind, content) => run(() => api.addMemory(kind, content))} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {memories === null ? null : memories.length === 0 ? (
          <p className="muted">Nothing yet. hearth reads a chat a few minutes after it goes quiet.</p>
        ) : (
          SECTIONS.map(({ kind, title, blurb }) => {
            const items = memories.filter((m) => m.kind === kind);
            return (
              <section key={kind} aria-labelledby={`memories-${kind}`}>
                <h2 id={`memories-${kind}`}>
                  {title} <span className="count">{items.length}</span>
                </h2>
                <p className="muted small">{blurb}</p>
                {items.length === 0 ? (
                  <p className="muted small">None.</p>
                ) : (
                  <ul className="memory-list">
                    {items.map((m) => (
                      <MemoryItem
                        key={m.id}
                        memory={m}
                        onOpenChat={onOpenChat}
                        onSave={(content) => run(() => api.updateMemory(m.id, { content }))}
                        onMove={() => run(() => api.updateMemory(m.id, { kind: kind === 'fact' ? 'profile' : 'fact' }))}
                        onDelete={() => {
                          if (window.confirm(`Forget "${m.content}"?`)) void run(() => api.deleteMemory(m.id));
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function AddMemory({ onAdd }: { onAdd: (kind: MemoryKind, content: string) => Promise<boolean> }) {
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (content.trim() && (await onAdd(kind, content.trim()))) setContent('');
  }
  return (
    <form className="memory-add" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="memory-new">
        New memory
      </label>
      <input
        id="memory-new"
        placeholder="Tell hearth something to remember…"
        maxLength={MAX_CHARS}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <label className="visually-hidden" htmlFor="memory-new-kind">
        Kind
      </label>
      <select id="memory-new-kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
        <option value="fact">When relevant</option>
        <option value="profile">Always</option>
      </select>
      <button type="submit" disabled={!content.trim()}>
        Add
      </button>
    </form>
  );
}

type ItemProps = {
  memory: Memory;
  onOpenChat: (id: number) => void;
  onSave: (content: string) => Promise<boolean>;
  onMove: () => void;
  onDelete: () => void;
};

function MemoryItem({ memory, onOpenChat, onSave, onMove, onDelete }: ItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (draft.trim() === memory.content || (await onSave(draft.trim()))) setEditing(false);
  }

  if (editing) {
    return (
      <li className="memory editing">
        <form onSubmit={save}>
          <label className="visually-hidden" htmlFor={`memory-${memory.id}`}>
            Edit memory
          </label>
          <textarea
            id={`memory-${memory.id}`}
            value={draft}
            maxLength={MAX_CHARS}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && !e.shiftKey) void save(e);
            }}
          />
          <div className="memory-actions">
            <button type="submit">Save</button>
            <button type="button" className="link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="memory">
      <p>{memory.content}</p>
      <div className="memory-actions">
        {memory.source_conversation_id !== null ? (
          <a
            href={`#/c/${memory.source_conversation_id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpenChat(memory.source_conversation_id!);
            }}
          >
            from a chat
          </a>
        ) : (
          <span className="muted small">added by hand</span>
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            setDraft(memory.content);
            setEditing(true);
          }}
        >
          Edit
        </button>
        <button type="button" className="link" onClick={onMove}>
          {memory.kind === 'fact' ? 'Always remember' : 'Only when relevant'}
        </button>
        <button type="button" className="link" onClick={onDelete}>
          Forget
        </button>
      </div>
    </li>
  );
}
