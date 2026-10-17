// How long the user was away before the newest message. The model sees today's date but no times on
// the chat history, so a chat picked up days later read as one unbroken exchange ("tomorrow" from
// Monday still sounded like tomorrow on Friday). Like recalled facts, the note rides on the newest
// message in the prompt only, so the prompt start Ollama caches stays the same.
import { timeGap } from '../shared/time-gap.ts';

/** The note for a newest message sent `latest` after `previous` (SQLite UTC times), or '' for a short gap. */
export function pauseNote(previous: string, latest: string): string {
  const away = timeGap(previous, latest);
  return away ? `[Sent about ${away} after the previous message in this chat.]` : '';
}
