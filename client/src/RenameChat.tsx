import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Conversation } from './api.ts';

const MAX_TITLE_CHARS = 120;

/**
 * The rename box in the chat list, in place of the browser's prompt. Suggest asks the model for a
 * title (from the user's side of the whole chat) and puts it in the box. Saved as it was, the title
 * is hearth's again, so hearth may retitle the chat as it moves on; a title typed or edited is the
 * user's, and hearth leaves it alone. Nothing is saved until Save.
 */
export function RenameChat({ chat, onSaved, onClose }: { chat: Conversation; onSaved: () => void; onClose: () => void }) {
  const [value, setValue] = useState(chat.title ?? '');
  // Every suggestion this box has shown, newest last: the next press asks for something else, and
  // the newest tells a kept suggestion from a typed title.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const suggestion = suggestions.at(-1) ?? null;
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    input.current?.select();
    // A suggestion still being written when the box closes is dropped, and frees its model slot.
    return () => pending.current?.abort();
  }, []);

  const kept = suggestion !== null && value.trim() === suggestion;

  async function suggest() {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setSuggesting(true);
    setNote('');
    try {
      // Asking means the current title won't do either.
      const avoid = [chat.title, ...suggestions].filter((t): t is string => !!t);
      const { title } = await api.suggestTitle(chat.id, avoid, request.signal);
      setValue(title);
      setSuggestions((shown) => [...shown, title]);
      input.current?.focus();
    } catch (err) {
      if (!request.signal.aborted) setNote(err instanceof ApiError ? err.message : "Couldn't reach hearth. Try again.");
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setSuggesting(false);
      }
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const title = value.trim();
    if (!title) {
      setNote("A title can't be empty.");
      return;
    }
    // Unchanged and not a suggestion: nothing to save (a kept suggestion still hands the title back).
    if (title === chat.title && !kept) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await api.renameConversation(chat.id, title, kept);
      onSaved();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : "Couldn't reach hearth. Try again.");
      setSaving(false);
    }
  }

  return (
    <form
      className="rename-chat"
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <label className="visually-hidden" htmlFor={`rename-${chat.id}`}>
        Chat title
      </label>
      <input
        id={`rename-${chat.id}`}
        ref={input}
        value={value}
        maxLength={MAX_TITLE_CHARS}
        autoFocus
        autoComplete="off"
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="rename-actions">
        <button type="button" className="link" onClick={suggest} disabled={suggesting || saving}>
          {suggesting ? 'Suggesting…' : 'Suggest'}
        </button>
        <button type="button" className="link" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={saving}>
          Save
        </button>
      </div>
      {note ? (
        <p className="error" role="alert">
          {note}
        </p>
      ) : (
        kept && <p className="muted small">hearth's title: it may change it as the chat moves on.</p>
      )}
    </form>
  );
}
