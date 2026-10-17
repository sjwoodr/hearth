import { describe, expect, it } from 'vitest';
import { pauseNote } from './pause.ts';

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

  it('ignores times it cannot read, or out of order', () => {
    expect(pauseNote('not a time', '2026-10-16 09:00:00')).toBe('');
    expect(pauseNote('2026-10-17 09:00:00', '2026-10-16 09:00:00')).toBe('');
  });
});
