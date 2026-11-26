// "For now" memories: true for days or weeks, then over (a trip, a visit, a sick week). A memory with
// `until` set (the last day it holds, YYYY-MM-DD in the server's time zone) rides on every reply until
// then; afterwards it's rewritten as something that happened and becomes an ordinary memory
// (server/for-now.ts). Dates are plain calendar days, so the arithmetic is done in UTC.

/** The end date a situation gets when the user doesn't say how long it lasts (owner's call, 2026-11-25). */
export const FOR_NOW_DEFAULT_DAYS = 7;
/** Further out than this, it isn't "for now": the date is dropped and it's judged as a lasting memory. */
export const MAX_FOR_NOW_DAYS = 60;
/** How far ahead a user may set one by hand on the Memories page. */
export const MAX_FOR_NOW_DAYS_BY_HAND = 365;
/** At most this many ride on each reply, the most recently changed first. */
export const MAX_ACTIVE_FOR_NOW = 5;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today (or `at`) as YYYY-MM-DD in this process's time zone (en-CA formats that way). */
export const localDay = (at: Date = new Date()): string => at.toLocaleDateString('en-CA');

/** A real calendar day as YYYY-MM-DD, or undefined ("2026-02-30" isn't one). */
export function calendarDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DAY.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : undefined;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whether a memory with this `until` still rides on replies on `today` (it holds through its last day). */
export const isForNow = (until: string | null | undefined, today: string): boolean => !!until && until >= today;

/** "Nov 29", or "Nov 29, 2027" outside `today`'s year. */
export function dayLabel(day: string, today: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Wednesday 2026-11-25", for prompts that need to work out "this week" or "until Sunday". */
export function dayWithWeekday(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
  return `${weekday} ${day}`;
}

/** "November 2026": when an ended situation happened, for its past-tense rewrite. */
export const monthYear = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
