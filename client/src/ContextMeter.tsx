import { useState } from 'react';
import type { ContextUse } from './api.ts';

/** From here the meter turns to the warning colour. */
const NEAR = 80;

/**
 * How full the chat is: its unsummarized history against the point where the oldest of it is folded
 * into the running summary (auto-compact). The details show on hover, or on a tap on a phone.
 */
export function ContextMeter({ context }: { context: ContextUse }) {
  const [open, setOpen] = useState(false);
  const percent = Math.round((context.used / context.foldAt) * 100);
  const detail =
    percent >= 100
      ? 'Auto-compact is due: the oldest messages are being folded into a summary.'
      : `${100 - percent}% until auto-compact, when the oldest messages are folded into a summary.`;
  return (
    <button
      type="button"
      className={`context-meter${percent >= NEAR ? ' near' : ''}${open ? ' open' : ''}`}
      aria-label={`Context ${percent}% used. ${detail}`}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onBlur={() => setOpen(false)}
    >
      {percent}%
      <span className="context-detail" role="tooltip">
        {detail}
      </span>
    </button>
  );
}
