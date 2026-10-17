// How long the user was away before the newest message. The model sees today's date but no times on
// the chat history, so a chat picked up days later read as one unbroken exchange ("tomorrow" from
// Monday still sounded like tomorrow on Friday). Like recalled facts, the note rides on the newest
// message in the prompt only, so the prompt start Ollama caches stays the same.

/** Gaps shorter than this read as one sitting: no note. */
export const PAUSE_NOTE_AFTER_MS = 3 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const sqliteTime = (sqliteUtc: string) => new Date(`${sqliteUtc.replace(' ', 'T')}Z`).getTime();
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The note for a newest message sent `latest` after `previous` (SQLite UTC times), or '' for a short gap. */
export function pauseNote(previous: string, latest: string): string {
  const gap = sqliteTime(latest) - sqliteTime(previous);
  if (!(gap >= PAUSE_NOTE_AFTER_MS)) return '';
  const days = Math.floor(gap / DAY);
  const away = days >= 1 ? plural(days, 'day') : plural(Math.floor(gap / HOUR), 'hour');
  return `[Sent about ${away} after the previous message in this chat.]`;
}
