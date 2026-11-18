// How long the user was away before the newest message, and what time it is for them. The model sees
// today's date but no times on the chat history, so a chat picked up days later read as one unbroken
// exchange ("tomorrow" from Monday still sounded like tomorrow on Friday), and an evening "hello" got
// "I hope your Tuesday is off to a decent start". Like recalled facts, these notes ride on the newest
// message in the prompt only, so the prompt start Ollama caches stays the same.
import { timeGap } from '../shared/time-gap.ts';

/** The note for a newest message sent `latest` after `previous` (SQLite UTC times), or '' for a short gap. */
export function pauseNote(previous: string, latest: string): string {
  const away = timeGap(previous, latest);
  return away ? `[Sent about ${away} after the previous message in this chat.]` : '';
}

/**
 * The person's weekday and time, for the turns where a greeting guesses it: a chat's first message and
 * the first after a break. In the server's time zone (the chart sets the household's `TZ`), like the
 * date in the search instructions.
 */
export function timeNote(name: string, now: Date, timeZone?: string): string {
  const when = now.toLocaleString('en-US', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit' });
  return `[It's ${when} for ${name}.]`;
}
