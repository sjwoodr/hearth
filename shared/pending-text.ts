// What the chat shows while a reply hasn't produced its first word yet. One place for the wording
// and the order of precedence, so the view stays simple and the choice is testable.

/** After this long with nothing to show, say the reply is still on its way (a long chat being read). */
export const STILL_WORKING_MS = 5000;

export type PendingState = {
  searchingFor: string | null;
  queued: boolean;
  loading: boolean;
  thinkingTokens: number;
  autoReason: string | null;
  waitedMs: number;
};

export function pendingText(p: PendingState): string {
  if (p.searchingFor) return `Searching the web for “${p.searchingFor}”…`;
  if (p.queued) return 'Waiting for the model to finish another reply…';
  if (p.thinkingTokens > 0) return `Thinking… ${p.thinkingTokens}${p.autoReason ? ` · auto: ${p.autoReason}` : ''}`;
  if (p.loading) return 'Loading the model… the first message after a quiet spell takes about 15 seconds';
  if (p.waitedMs >= STILL_WORKING_MS) return 'Still working… a long chat can take a moment to read';
  return '…';
}
