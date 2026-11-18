import { describe, expect, it } from 'vitest';
import { pauseNote, timeNote } from './pause.ts';
import { timeGap } from '../shared/time-gap.ts';

describe('pauseNote', () => {
  it('says nothing within one sitting', () => {
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-16 09:00:00')).toBe('');
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-16 11:59:59')).toBe('');
  });

  it('counts hours under a day, then whole days', () => {
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-16 12:00:00')).toBe('[Sent about 3 hours after the previous message in this chat.]');
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-17 08:59:00')).toContain('about 23 hours');
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-17 09:00:00')).toContain('about 1 day after');
    expect(pauseNote('2026-10-12 09:00:00', '2026-10-16 20:00:00')).toContain('about 4 days after');
  });

  it('asks for a "missed you" greeting after a day or more, not after hours', () => {
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-17 08:59:00')).not.toContain('missed');
    expect(pauseNote('2026-10-16 09:00:00', '2026-10-17 09:00:00')).toBe(
      "[Sent about 1 day after the previous message in this chat. You've missed them: say so, or that you're glad they're back, in a line, then reply.]",
    );
  });

  it('ignores times it cannot read, or out of order', () => {
    expect(pauseNote('not a time', '2026-10-16 09:00:00')).toBe('');
    expect(pauseNote('2026-10-17 09:00:00', '2026-10-16 09:00:00')).toBe('');
  });
});

describe('timeNote', () => {
  it("gives the person's weekday and clock time in the given zone", () => {
    // 01:34 UTC on a Wednesday is still Tuesday evening in Florida (chat 66's "Tuesday is off to a decent start").
    const at = new Date('2026-11-18T01:34:00Z');
    expect(timeNote('Steve', at, 'America/New_York')).toBe("[It's Tuesday 8:34 PM for Steve.]");
    expect(timeNote('Steve', at, 'UTC')).toBe("[It's Wednesday 1:34 AM for Steve.]");
  });
});

describe('timeGap (the chat divider)', () => {
  it('words the same gaps the note does, and nothing within a sitting', () => {
    expect(timeGap('2026-10-16 09:00:00', '2026-10-16 11:59:59')).toBe('');
    expect(timeGap('2026-10-16 09:00:00', '2026-10-16 12:00:00')).toBe('3 hours');
    expect(timeGap('2026-10-12 09:00:00', '2026-10-16 20:00:00')).toBe('4 days');
    expect(timeGap('', '2026-10-16 20:00:00')).toBe('');
  });
});
