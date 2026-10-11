import { useEffect, useRef, useState } from 'react';
import { api, type ActiveModel, type ModelInfo } from './api.ts';

const CAPABILITIES = ['vision', 'thinking', 'tools'] as const;
const LABELS: Record<(typeof CAPABILITIES)[number], string> = { vision: 'photos', thinking: 'Think', tools: 'web search' };

/**
 * Admin only: switch the model every user talks to. One model fits in memory, so a switch is for
 * everyone, and the first reply after it waits ~15 s while the model loads. hearth goes back to the
 * default on its own once the other model has been idle and unloaded.
 */
export function ModelPicker({ onClose, onSwitched }: { onClose: () => void; onSwitched: (active: ActiveModel) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<{ active: ActiveModel; models: ModelInfo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    api.models().then(setData, (err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function choose(run: () => Promise<{ active: ActiveModel }>) {
    setBusy(true);
    setError('');
    try {
      const { active } = await run();
      onSwitched(active);
      dialog.current?.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="model-picker" onClose={onClose} aria-labelledby="model-picker-title">
      <h2 id="model-picker-title">Model</h2>
      <p className="muted">
        Switches every user at once. The next reply waits about 15 s while the model loads, then rereads the chat. Memory
        extraction waits until the default is back, and hearth returns to it by itself once the other model sits idle.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading Ollama's models…</p>}
      {data && (
        <ul className="model-list">
          {data.models.map((m) => {
            const current = m.name === data.active.model;
            return (
              <li key={m.name} className={current ? 'current' : undefined}>
                <button
                  type="button"
                  disabled={busy || current}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => choose(() => (m.name === data.active.default ? api.resetModel() : api.setModel(m.name)))}
                >
                  <span className="model-name">
                    {m.name}
                    {m.name === data.active.default && <span className="muted"> · default</span>}
                    {current && <span className="muted"> · in use</span>}
                  </span>
                  <span className="model-meta">
                    {(m.size / 1e9).toFixed(1)} GB
                    {CAPABILITIES.map((c) => (
                      <span key={c} className={`chip${m.capabilities.includes(c) ? '' : ' missing'}`}>
                        {m.capabilities.includes(c) ? LABELS[c] : `no ${LABELS[c]}`}
                      </span>
                    ))}
                  </span>
                  {m.aliases && <span className="model-aliases muted">also tagged {m.aliases.join(', ')}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" className="link" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
