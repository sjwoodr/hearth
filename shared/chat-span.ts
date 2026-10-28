// When a chat ran, for the title bar: "Oct 24 – Oct 27", or "Oct 27, 9:14 PM – 11:02 PM" within a day.
// Times come from SQLite in UTC ("2026-10-27 21:14:05") and are shown in the reader's own time zone.

const sqliteTime = (sqliteUtc: string) => new Date(`${sqliteUtc.replace(' ', 'T')}Z`);

type Options = { now?: Date; locale?: string; timeZone?: string };

/** From the first message to the last; the year only when it isn't this year. */
export function chatSpan(first: string, last: string, { now = new Date(), locale, timeZone }: Options = {}): string {
  const start = sqliteTime(first);
  const end = sqliteTime(last);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const year = (d: Date) => new Intl.DateTimeFormat('en', { year: 'numeric', timeZone }).format(d);
  const day = (d: Date) =>
    d.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone, ...(year(d) !== year(now) ? { year: 'numeric' } : {}) });
  const time = (d: Date) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  if (day(start) !== day(end)) return `${day(start)} – ${day(end)}`;
  return time(start) === time(end) ? `${day(start)}, ${time(start)}` : `${day(start)}, ${time(start)} – ${time(end)}`;
}
