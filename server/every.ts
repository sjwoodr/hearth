/**
 * Runs `task` every `ms` until the returned function is called. `keepAlive` decides whether the
 * timer alone keeps the process running (the worker needs that; the api has its server for it).
 * `now` also runs it once straight away.
 */
export function every(ms: number, task: () => Promise<unknown>, opts: { keepAlive?: boolean; now?: boolean } = {}): () => void {
  if (opts.now) void task();
  const timer = setInterval(() => void task(), ms);
  if (!opts.keepAlive) timer.unref();
  return () => clearInterval(timer);
}
