import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Memory, type MemoryKind, type MemorySubject, type Persona } from './api.ts';
import { memoryDate } from '../../shared/chat-span.ts';

const MAX_CHARS = 400;
const MAX_NAME_CHARS = 40;
const MAX_ABOUT_CHARS = 2000;

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

// The same two kinds for what the assistant knows about itself.
const SELF_SECTIONS = (name: string): typeof SECTIONS => [
  {
    kind: 'profile',
    title: `Always part of who ${name} is`,
    blurb: 'Included in every chat, with the description above. Promote one with "Always remember".',
  },
  {
    kind: 'fact',
    title: 'Recalled when relevant',
    blurb: `What you settled about ${name} in your chats (hearth keeps only what you said or agreed to, never what ${name} made up), brought in when it comes up.`,
  },
];

export function MemoriesView({ onOpenChat, onError }: { onOpenChat: (id: number) => void; onError: (err: unknown) => void }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.memories().then(setMemories, onError);
    api.persona().then(setPersona, onError);
  }, [onError]);
  const assistant = persona ? persona.name || persona.defaultName : 'hearth';
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
          What hearth has learned from your chats, or that you added yourself: about you, and about who {assistant} is to
          you. Edit or delete anything that's wrong: a wrong memory comes back in every future chat.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <section className="memories-group" aria-labelledby="memories-you">
          <h2 id="memories-you">About you</h2>
          <AddMemory id="memory-new" placeholder="Tell hearth something to remember…" onAdd={(kind, content) => run(() => api.addMemory(kind, content))} />
          {memories === null ? null : memories.every((m) => m.subject !== 'user') ? (
            <p className="muted">Nothing yet. hearth reads a chat a few minutes after it goes quiet.</p>
          ) : (
            <MemorySections memories={memories} subject="user" sections={SECTIONS} assistant={assistant} onOpenChat={onOpenChat} run={run} />
          )}
        </section>
        <section className="memories-group" aria-labelledby="memories-assistant">
          <h2 id="memories-assistant">About {assistant}</h2>
          {persona && (
            <PersonaEditor
              persona={persona}
              onSave={(name, about) => run(() => api.savePersona(name, about))}
              onRestore={(id) => run(() => api.restorePersona(id))}
            />
          )}
          <AddMemory
            id="memory-new-assistant"
            placeholder={`Something ${assistant} should know about itself…`}
            onAdd={(kind, content) => run(() => api.addMemory(kind, content, 'assistant'))}
          />
          {memories !== null && memories.some((m) => m.subject === 'assistant') && (
            <MemorySections
              memories={memories}
              subject="assistant"
              sections={SELF_SECTIONS(assistant)}
              assistant={assistant}
              onOpenChat={onOpenChat}
              run={run}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** One subject's memories, in its two kinds. */
function MemorySections({
  memories,
  subject,
  sections,
  assistant,
  onOpenChat,
  run,
}: {
  memories: Memory[];
  subject: MemorySubject;
  sections: typeof SECTIONS;
  assistant: string;
  onOpenChat: (id: number) => void;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  return (
    <>
      {sections.map(({ kind, title, blurb }) => {
        const items = memories.filter((m) => m.subject === subject && m.kind === kind);
        const id = `memories-${subject}-${kind}`;
        return (
          <section key={kind} aria-labelledby={id}>
            <h3 id={id}>
              {title} <span className="count">{items.length}</span>
            </h3>
            <p className="muted small">{blurb}</p>
            {items.length === 0 ? (
              <p className="muted small">None.</p>
            ) : (
              <ul className="memory-list">
                {items.map((m) => (
                  <MemoryItem
                    key={m.id}
                    memory={m}
                    assistant={assistant}
                    onOpenChat={onOpenChat}
                    onSave={(content) => run(() => api.updateMemory(m.id, { content }))}
                    onMove={() => run(() => api.updateMemory(m.id, { kind: kind === 'fact' ? 'profile' : 'fact' }))}
                    onMoveSubject={() => run(() => api.updateMemory(m.id, { subject: subject === 'user' ? 'assistant' : 'user' }))}
                    onDelete={() => {
                      if (window.confirm(`Forget "${m.content}"?`)) void run(() => api.deleteMemory(m.id));
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

/** Who the assistant is to this user: its name and their description, with earlier versions to bring back. */
function PersonaEditor({
  persona,
  onSave,
  onRestore,
}: {
  persona: Persona;
  onSave: (name: string, about: string) => Promise<boolean>;
  onRestore: (id: number) => Promise<boolean>;
}) {
  const [name, setName] = useState(persona.name);
  const [about, setAbout] = useState(persona.about);
  // A save or a restore brings new values from the server.
  useEffect(() => {
    setName(persona.name);
    setAbout(persona.about);
  }, [persona.name, persona.about, persona.updated_at]);
  const changed = name.trim() !== persona.name || about.trim() !== persona.about;
  const custom = persona.name !== '' || persona.about !== '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    await onSave(name, about);
  }

  return (
    <form className="persona" onSubmit={submit}>
      <p className="muted small">
        Who {persona.name || persona.defaultName} is with you. This joins hearth's own instructions in every chat: it can add to them,
        not replace them. Leave it empty for the default.
      </p>
      <label htmlFor="persona-name">Name</label>
      <input
        id="persona-name"
        placeholder={persona.defaultName}
        maxLength={MAX_NAME_CHARS}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="persona-about">Who they are to you</label>
      <textarea
        id="persona-about"
        placeholder="A voice, a backstory, how you picture them, what they are to you…"
        maxLength={MAX_ABOUT_CHARS}
        rows={5}
        value={about}
        onChange={(e) => setAbout(e.target.value)}
      />
      <div className="memory-actions">
        <span className="memory-id">
          {about.length} / {MAX_ABOUT_CHARS}
        </span>
        <button type="submit" disabled={!changed}>
          Save
        </button>
        {changed && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setName(persona.name);
              setAbout(persona.about);
            }}
          >
            Undo changes
          </button>
        )}
        {custom && !changed && (
          <button
            type="button"
            className="link"
            onClick={() => {
              if (window.confirm('Go back to the default name and no description? This version stays in Earlier versions.')) void onSave('', '');
            }}
          >
            Reset to default
          </button>
        )}
      </div>
      {persona.instructions && (
        <details className="persona-history">
          <summary>hearth's own instructions (read-only)</summary>
          <p className="muted small">
            What every chat starts with, before the description above. It holds the measured parts (correcting French, plain
            symbols, how replies end), so it can only be changed in hearth's code.
          </p>
          <pre className="persona-instructions">{persona.instructions}</pre>
        </details>
      )}
      {persona.history.length > 0 && (
        <details className="persona-history">
          <summary>Earlier versions ({persona.history.length})</summary>
          <ul className="memory-list">
            {persona.history.map((v) => (
              <li key={v.id} className="memory">
                <p>
                  <strong>{v.name || persona.defaultName}</strong>
                  {v.about ? ` · ${v.about.length > 140 ? `${v.about.slice(0, 140)}…` : v.about}` : ' · (no description)'}
                </p>
                <div className="memory-actions">
                  <span className="memory-id">{memoryDate(v.saved_at, v.saved_at)}</span>
                  <button type="button" className="link" onClick={() => void onRestore(v.id)}>
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}

function AddMemory({
  id,
  onAdd,
  placeholder,
}: {
  id: string;
  onAdd: (kind: MemoryKind, content: string) => Promise<boolean>;
  placeholder: string;
}) {
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (content.trim() && (await onAdd(kind, content.trim()))) setContent('');
  }
  return (
    <form className="memory-add" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={id}>
        New memory
      </label>
      <input
        id={id}
        placeholder={placeholder}
        maxLength={MAX_CHARS}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <label className="visually-hidden" htmlFor={`${id}-kind`}>
        Kind
      </label>
      <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
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
  assistant: string;
  onOpenChat: (id: number) => void;
  onSave: (content: string) => Promise<boolean>;
  onMove: () => void;
  /** Between "About you" and "About <assistant>", for a memory filed under the wrong one. */
  onMoveSubject: () => void;
  onDelete: () => void;
};

function MemoryItem({ memory, assistant, onOpenChat, onSave, onMove, onMoveSubject, onDelete }: ItemProps) {
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
        <span className="memory-id" title="Memory ID, the same one bin/hearth uses">
          #{memory.id}
        </span>
        <span className="memory-id" title="Newest change first: the page is sorted by this">
          {memoryDate(memory.created_at, memory.updated_at)}
        </span>
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
        <button type="button" className="link" onClick={onMoveSubject} title="File it under the other heading">
          {memory.subject === 'user' ? `Move to About ${assistant}` : 'Move to About you'}
        </button>
        <button type="button" className="link" onClick={onDelete}>
          Forget
        </button>
      </div>
    </li>
  );
}
