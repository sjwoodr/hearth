// When a chat ran, for the title bar: "Oct 24 – Oct 27", or "Oct 27, 9:14 PM – 11:02 PM" within a day;
// when a memory was added or last changed, for the memories page.
// Times come from SQLite in UTC ("2026-10-27 21:14:05") and are shown in the reader's own time zone.

const sqliteTime = (sqliteUtc: string) => new Date(`${sqliteUtc.replace(' ', 'T')}Z`);

type Options = { now?: Date; locale?: string; timeZone?: string };

const dayFormat = ({ now = new Date(), locale, timeZone }: Options) => {
  const year = (d: Date) => new Intl.DateTimeFormat('en', { year: 'numeric', timeZone }).format(d);
  return (d: Date) =>
    d.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone, ...(year(d) !== year(now) ? { year: 'numeric' } : {}) });
};

/** "changed Oct 27" once a memory was edited, rewritten or moved, else "added Oct 24": the page is sorted by it. */
export function memoryDate(created: string, updated: string, options: Options = {}): string {
  const added = sqliteTime(created);
  const changed = sqliteTime(updated);
  if (Number.isNaN(added.getTime()) || Number.isNaN(changed.getTime())) return '';
  const day = dayFormat(options);
  return changed.getTime() > added.getTime() ? `changed ${day(changed)}` : `added ${day(added)}`;
}

/** From the first message to the last; the year only when it isn't this year. */
export function chatSpan(first: string, last: string, { now = new Date(), locale, timeZone }: Options = {}): string {
  const start = sqliteTime(first);
  const end = sqliteTime(last);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const day = dayFormat({ now, locale, timeZone });
  const time = (d: Date) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  if (day(start) !== day(end)) return `${day(start)} – ${day(end)}`;
  return time(start) === time(end) ? `${day(start)}, ${time(start)}` : `${day(start)}, ${time(start)} – ${time(end)}`;
}
