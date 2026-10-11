// The model every hearth process talks to. HEARTH_MODEL is the default; an admin can switch to any
// other chat model Ollama has, for everyone at once (one model in memory). The choice lives in the
// `settings` table, so the api and the worker (separate processes, or pods) pick it up without a
// restart. A switch goes back to the default by itself once Ollama has unloaded the other model and
// nobody has used it for a while (see startModelReverter), and memory extraction waits meanwhile.
import type { DB } from './db.ts';

const KEY = 'active_model';
/** How long a read is reused: every model call asks, so this keeps it off the database. */
const CACHE_MS = 2000;
/** Replies record their use at most this often. */
const TOUCH_MS = 30_000;

type Stored = { model: string; since: string; by: string; lastUsed: string };

export type ActiveModel = {
  model: string;
  default: string;
  isDefault: boolean;
  /** For a switch: when, who, and the last reply that used it (ISO times). */
  since?: string;
  by?: string;
  lastUsed?: string;
};

export type ModelChoice = {
  /** The model for the next call. */
  current(): string;
  isDefault(): boolean;
  info(): ActiveModel;
  set(model: string, by: string): void;
  /** Back to the default. */
  reset(): void;
  /** A reply used the current model (keeps a switch from reverting while it's in use). */
  touch(): void;
};

export function createModelChoice(db: DB, defaultModel: string, opts: { now?: () => number } = {}): ModelChoice {
  const now = opts.now ?? Date.now;
  let cached: { at: number; stored: Stored | undefined } | undefined;
  let touchedAt = 0;

  function stored(): Stored | undefined {
    if (cached && now() - cached.at < CACHE_MS) return cached.stored;
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    let value: Stored | undefined;
    try {
      value = row ? (JSON.parse(row.value) as Stored) : undefined;
    } catch {
      value = undefined;
    }
    // A switch back to the default is no switch at all.
    if (value?.model === defaultModel) value = undefined;
    cached = { at: now(), stored: value };
    return value;
  }

  function write(value: Stored | undefined) {
    if (value) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(KEY, JSON.stringify(value));
    } else {
      db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    }
    cached = { at: now(), stored: value };
  }

  return {
    current: () => stored()?.model ?? defaultModel,
    isDefault: () => stored() === undefined,
    info() {
      const s = stored();
      return s
        ? { model: s.model, default: defaultModel, isDefault: false, since: s.since, by: s.by, lastUsed: s.lastUsed }
        : { model: defaultModel, default: defaultModel, isDefault: true };
    },
    set(model, by) {
      const at = new Date(now()).toISOString();
      write(model === defaultModel ? undefined : { model, since: at, by, lastUsed: at });
    },
    reset: () => write(undefined),
    touch() {
      const s = stored();
      if (!s || now() - touchedAt < TOUCH_MS) return;
      touchedAt = now();
      write({ ...s, lastUsed: new Date(now()).toISOString() });
    },
  };
}

/** How long a switched model must go unused, once Ollama has unloaded it, before hearth reverts. */
export const REVERT_IDLE_MS = 5 * 60_000;

/**
 * Reverts a switched model that Ollama no longer has in memory (its keep-alive ran out) and that no
 * reply has used for REVERT_IDLE_MS. Both conditions matter: right after a switch the new model isn't
 * loaded yet, because nothing has asked for it. Returns the model it reverted from, if it did.
 */
export async function revertIfIdle(
  choice: ModelChoice,
  loaded: (model: string) => Promise<boolean | undefined>,
  now = Date.now(),
): Promise<string | undefined> {
  const info = choice.info();
  if (info.isDefault) return undefined;
  const idleFor = now - Date.parse(info.lastUsed ?? info.since ?? '');
  if (!(idleFor >= REVERT_IDLE_MS)) return undefined;
  // Only a definite "not loaded": when Ollama can't be asked, keep the switch.
  if ((await loaded(info.model)) !== false) return undefined;
  choice.reset();
  return info.model;
}

/** Runs revertIfIdle once a minute. */
export function startModelReverter(choice: ModelChoice, loaded: (model: string) => Promise<boolean | undefined>): () => void {
  const timer = setInterval(() => {
    revertIfIdle(choice, loaded)
      .then((from) => from && console.log(`model: ${from} was idle and unloaded; back to ${choice.current()}`))
      .catch(() => {});
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
