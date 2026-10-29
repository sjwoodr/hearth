import { describe, expect, it } from 'vitest';
import { chatSpan, memoryDate } from '../shared/chat-span.ts';

const now = new Date('2026-10-28T12:00:00Z');
const span = (first: string, last: string, timeZone = 'America/New_York') => chatSpan(first, last, { now, locale: 'en-US', timeZone });

describe('chatSpan', () => {
  it('shows the first and last day of a chat that ran over several days', () => {
    expect(span('2026-10-24 14:00:00', '2026-10-27 18:30:00')).toBe('Oct 24 – Oct 27');
  });

  it('shows one day and the times for a chat within a day, in local time', () => {
    // 01:14 UTC on the 28th is still the evening of the 27th in New York.
    expect(span('2026-10-27 22:14:00', '2026-10-28 01:02:00')).toBe('Oct 27, 6:14 PM – 9:02 PM');
    expect(span('2026-10-27 22:14:00', '2026-10-28 01:02:00', 'Europe/Paris')).toBe('Oct 27 – Oct 28'); // past midnight in Paris: two days
  });

  it('shows a single time when the chat lasted under a minute', () => {
    expect(span('2026-10-27 22:14:05', '2026-10-27 22:14:40')).toBe('Oct 27, 6:14 PM');
  });

  it('adds the year only to dates outside this year', () => {
    expect(span('2025-12-30 15:00:00', '2026-01-02 15:00:00')).toBe('Dec 30, 2025 – Jan 2');
    expect(span('2025-03-01 15:00:00', '2025-03-01 16:00:00')).toBe('Mar 1, 2025, 10:00 AM – 11:00 AM');
  });

  it('gives nothing for a time it cannot read', () => {
    expect(span('yesterday', '2026-10-27 22:14:00')).toBe('');
  });
});

describe('memoryDate', () => {
  const date = (created: string, updated: string) => memoryDate(created, updated, { now, locale: 'en-US', timeZone: 'America/New_York' });

  it('says when a memory was added if it never changed', () => {
    expect(date('2026-10-24 14:00:00', '2026-10-24 14:00:00')).toBe('added Oct 24');
  });

  it('says when it last changed, in local time, with the year only when it is not this year', () => {
    expect(date('2026-10-24 14:00:00', '2026-10-28 01:02:00')).toBe('changed Oct 27');
    expect(date('2025-03-01 15:00:00', '2025-03-01 15:00:00')).toBe('added Mar 1, 2025');
  });

  it('gives nothing for a time it cannot read', () => {
    expect(date('', '2026-10-24 14:00:00')).toBe('');
  });
});
