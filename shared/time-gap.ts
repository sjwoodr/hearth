// How long passed between two messages in a chat, in words. Shared so the model's note (server/pause.ts)
// and the divider the chat shows agree on what counts as a break and how it's described.

/** Gaps shorter than this read as one sitting. */
export const TIME_GAP_AFTER_MS = 3 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const sqliteTime = (sqliteUtc: string) => new Date(`${sqliteUtc.replace(' ', 'T')}Z`).getTime();
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "3 hours", "4 days": the gap from `previous` to `latest` (SQLite UTC times), or '' within one sitting. */
export function timeGap(previous: string, latest: string): string {
  const gap = sqliteTime(latest) - sqliteTime(previous);
  if (!(gap >= TIME_GAP_AFTER_MS)) return '';
  const days = Math.floor(gap / DAY);
  return days >= 1 ? plural(days, 'day') : plural(Math.floor(gap / HOUR), 'hour');
}
