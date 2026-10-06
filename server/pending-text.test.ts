import { describe, expect, it } from 'vitest';
import { pendingText, STILL_WORKING_MS, type PendingState } from '../shared/pending-text.ts';

const idle: PendingState = { searchingFor: null, queued: false, loading: false, thinkingTokens: 0, autoReason: null, waitedMs: 0 };

describe("the text shown before a reply's first word", () => {
  it('is a quiet ellipsis at first', () => {
    expect(pendingText(idle)).toBe('…');
    expect(pendingText({ ...idle, waitedMs: STILL_WORKING_MS - 1 })).toBe('…');
  });

  it('says the model is loading when Ollama had unloaded it', () => {
    expect(pendingText({ ...idle, loading: true })).toMatch(/^Loading the model/);
  });

  it('says it is still working after five seconds with nothing else to show', () => {
    expect(pendingText({ ...idle, waitedMs: STILL_WORKING_MS })).toMatch(/^Still working/);
  });

  it('shows thinking progress against the cap, with the effort and why Auto chose to think', () => {
    expect(pendingText({ ...idle, thinkingTokens: 12 })).toBe('Thinking… 12');
    expect(pendingText({ ...idle, thinkingTokens: 12, thinkingBudget: 400, effortLabel: 'High' })).toBe('Thinking… 12 of 400 · High');
    expect(pendingText({ ...idle, thinkingTokens: 3, thinkingBudget: 200, effortLabel: 'Medium', autoReason: 'checking your French' })).toBe(
      'Thinking… 3 of 200 · Medium · auto: checking your French',
    );
  });

  it('prefers the specific reasons over the general ones', () => {
    // Loading explains the wait better than "still working"; thinking means the model is already loaded.
    expect(pendingText({ ...idle, loading: true, waitedMs: 20_000 })).toMatch(/^Loading the model/);
    expect(pendingText({ ...idle, loading: true, thinkingTokens: 12 })).toBe('Thinking… 12');
    expect(pendingText({ ...idle, queued: true, loading: true })).toMatch(/^Waiting for the model/);
    expect(pendingText({ ...idle, searchingFor: 'tour dates', queued: true })).toBe('Searching the web for “tour dates”…');
  });
});
