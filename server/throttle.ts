type Entry = { windowStart: number; failures: number; lockedUntil: number };

// Counts failed logins per key within a window and locks the key once the limit is hit.
// Ceiling: state is in memory, so a restart clears lockouts. Fine for a home server;
// persist it in SQLite before exposing hearth to the internet.
export class LoginThrottle {
  private entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(maxFailures: number, windowMs: number, lockMs: number, now: () => number = Date.now) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.now = now;
  }

  /** Milliseconds until the key may try again, or 0 if it's not locked. */
  retryAfter(key: string): number {
    const lockedUntil = this.entries.get(key)?.lockedUntil ?? 0;
    return Math.max(0, lockedUntil - this.now());
  }

  fail(key: string): void {
    const t = this.now();
    let e = this.entries.get(key);
    if (!e || (t - e.windowStart > this.windowMs && e.lockedUntil <= t)) {
      e = { windowStart: t, failures: 0, lockedUntil: 0 };
    }
    e.failures++;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = t + this.lockMs;
      e.failures = 0;
      e.windowStart = t;
    }
    this.entries.set(key, e);
    if (this.entries.size > 10_000) this.prune(t);
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  private prune(t: number): void {
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= t && t - e.windowStart > this.windowMs) this.entries.delete(key);
    }
  }
}
