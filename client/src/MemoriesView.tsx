import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Memory, type MemoryKind, type MemorySubject, type Persona } from './api.ts';
import { memoryDate } from '../../shared/chat-span.ts';
import { alwaysUse, MEMORY_BUDGET_CHARS } from '../../shared/memory-budget.ts';

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

type Tab = MemorySubject;
const TAB_HASH: Record<Tab, string> = { user: '#/memories', assistant: '#/memories/assistant' };
const tabFromHash = (): Tab => (location.hash === TAB_HASH.assistant ? 'assistant' : 'user');

export function MemoriesView({
  onOpenChat,
  onError,
  onAssistantName,
}: {
  onOpenChat: (id: number) => void;
  onError: (err: unknown) => void;
  /** The assistant's name after every load, save, restore or reset, so the chat box follows a rename. */
  onAssistantName?: (name: string) => void;
}) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(tabFromHash);
  // After "Move to About …" the memory leaves the tab you're on, so say where it went.
  const [moved, setMoved] = useState<{ content: string; to: Tab } | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ user: null, assistant: null });

  const load = useCallback(() => {
    api.memories().then(setMemories, onError);
    api.persona().then(setPersona, onError);
  }, [onError]);
  const assistant = persona ? persona.name || persona.defaultName : 'hearth';
  useEffect(load, [load]);
  useEffect(() => {
    if (persona) onAssistantName?.(assistant);
  }, [persona, assistant, onAssistantName]);

  // The tab is in the URL, so a reload stays on it. Replaced, not pushed: Back leaves the page.
  const select = (next: Tab, focus = false) => {
    setTab(next);
    setMoved(null);
    if (location.hash !== TAB_HASH[next]) history.replaceState(null, '', TAB_HASH[next]);
    if (focus) tabRefs.current[next]?.focus();
  };

  // Field errors (too long, empty) show here; anything else goes up to the app.
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    setMoved(null);
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

  const count = (subject: Tab) => (memories ?? []).filter((m) => m.subject === subject).length;
  const label = (t: Tab) => (t === 'user' ? 'About you' : `About ${assistant}`);
  const tabs: Tab[] = ['user', 'assistant'];
  const onMoved = (content: string, to: Tab) => setMoved({ content, to });

  return (
    <div className="memories">
      <div className="memories-inner">
        <p className="muted">
          What hearth has learned from your chats, or that you added yourself: about you, and about who {assistant} is to
          you. Edit or delete anything that's wrong: a wrong memory comes back in every future chat.
        </p>
        <div className="memories-tabs" role="tablist" aria-label="Memories">
          {tabs.map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`memories-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`memories-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              title={label(t)}
              onClick={() => select(t)}
              onKeyDown={(e) => {
                // Arrow keys move between tabs (the WAI-ARIA tabs pattern); there are two, so either way is the other.
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') select(t === 'user' ? 'assistant' : 'user', true);
                if (e.key === 'Home') select('user', true);
                if (e.key === 'End') select('assistant', true);
              }}
            >
              <span className="tab-label">{label(t)}</span>
              {memories !== null && <span className="count">{count(t)}</span>}
            </button>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small moved" role="status">
          {moved && (
            <>
              Moved “{moved.content.length > 80 ? `${moved.content.slice(0, 80)}…` : moved.content}” to{' '}
              <button type="button" className="link" onClick={() => select(moved.to)}>
                {label(moved.to)}
              </button>
              .
            </>
          )}
        </p>
        <section
          className="memories-group"
          role="tabpanel"
          id="memories-panel-user"
          aria-labelledby="memories-tab-user"
          hidden={tab !== 'user'}
        >
          <AddMemory id="memory-new" placeholder="Tell hearth something to remember…" onAdd={(kind, content) => run(() => api.addMemory(kind, content))} />
          {memories === null ? null : count('user') === 0 ? (
            <p className="muted">Nothing yet. hearth reads a chat a few minutes after it goes quiet.</p>
          ) : (
            <MemorySections
              memories={memories}
              subject="user"
              sections={SECTIONS}
              assistant={assistant}
              onOpenChat={onOpenChat}
              run={run}
              onMoved={onMoved}
            />
          )}
        </section>
        <section
          className="memories-group"
          role="tabpanel"
          id="memories-panel-assistant"
          aria-labelledby="memories-tab-assistant"
          hidden={tab !== 'assistant'}
        >
          {persona && (
            <PersonaEditor
              persona={persona}
              onSave={(name, about) => run(() => api.savePersona(name, about))}
              onRestore={(id) => run(() => api.restorePersona(id))}
              onForget={(id) => run(() => api.forgetPersonaVersion(id))}
            />
          )}
          <h3>Memories about {assistant}</h3>
          <AddMemory
            id="memory-new-assistant"
            placeholder={`Something ${assistant} should know about itself…`}
            onAdd={(kind, content) => run(() => api.addMemory(kind, content, 'assistant'))}
          />
          {memories === null ? null : count('assistant') === 0 ? (
            <p className="muted small">
              None yet. hearth keeps what you set or agree to about {assistant} in a chat, never what {assistant} makes up about
              itself. A memory under About you that's really about {assistant} can be moved here.
            </p>
          ) : (
            <MemorySections
              memories={memories}
              subject="assistant"
              sections={SELF_SECTIONS(assistant)}
              assistant={assistant}
              onOpenChat={onOpenChat}
              run={run}
              onMoved={onMoved}
            />
          )}
          {persona?.instructions && <Instructions text={persona.instructions} />}
        </section>
      </div>
    </div>
  );
}

/** hearth's fixed prompt, shown but not editable: the measured behaviour every persona builds on. */
function Instructions({ text }: { text: string }) {
  return (
    <details className="persona-history">
      <summary>hearth's own instructions (read-only)</summary>
      <p className="muted small">
        What every chat starts with, before the description above. It holds the measured parts (correcting French, plain symbols,
        how replies end), so it can only be changed in hearth's code.
      </p>
      <pre className="persona-instructions">{text}</pre>
    </details>
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
  onMoved,
}: {
  memories: Memory[];
  subject: MemorySubject;
  sections: typeof SECTIONS;
  assistant: string;
  onOpenChat: (id: number) => void;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onMoved: (content: string, to: MemorySubject) => void;
}) {
  const other: MemorySubject = subject === 'user' ? 'assistant' : 'user';
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
            {kind === 'profile' && <AlwaysBudget memories={memories} other={other === 'user' ? 'About you' : `About ${assistant}`} />}
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
                    onMoveSubject={() =>
                      void run(() => api.updateMemory(m.id, { subject: other })).then((ok) => ok && onMoved(m.content, other))
                    }
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

const BUDGET_NOTE = {
  ok: '',
  crowding: ' That leaves less room for recalled memories, so fewer reach each chat.',
  over: ' Over the limit: some of these are left out of chats.',
};

/**
 * How much of a reply's memory allowance the always-remembered memories use. Both tabs' count against
 * the same allowance (shared/memory-budget.ts), so each shows the total.
 */
function AlwaysBudget({ memories, other }: { memories: Memory[]; other: string }) {
  const { chars, state } = alwaysUse(memories.filter((m) => m.kind === 'profile').map((m) => m.content));
  return (
    <p className={`muted small always-budget ${state}`}>
      Uses {chars.toLocaleString('en-US')} of about {MEMORY_BUDGET_CHARS.toLocaleString('en-US')} characters, shared with {other}.
      {BUDGET_NOTE[state]}
    </p>
  );
}

/** Who the assistant is to this user: its name and their description, with earlier versions to bring back. */
function PersonaEditor({
  persona,
  onSave,
  onRestore,
  onForget,
}: {
  persona: Persona;
  onSave: (name: string, about: string) => Promise<boolean>;
  onRestore: (id: number) => Promise<boolean>;
  onForget: (id: number) => Promise<boolean>;
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
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      if (window.confirm(`Forget this earlier version (${v.name || persona.defaultName})? It can't be brought back.`)) void onForget(v.id);
                    }}
                  >
                    Forget
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
