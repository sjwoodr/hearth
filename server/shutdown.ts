// Graceful shutdown for a server process. A supervisor (Kubernetes, docker stop) sends SIGTERM and,
// about 30 seconds later, kills the process. On SIGTERM (or Ctrl-C) this stops accepting
// connections, lets open requests finish (a reply mid-stream gets to end), then runs `cleanup`
// (close the database) and exits. Whatever is still open after `graceMs` is cut off: keep that
// under the supervisor's own limit (Kubernetes' terminationGracePeriodSeconds, 30 s by default).
import type { ServerType } from '@hono/node-server';

export function closeGracefully(
  server: ServerType,
  opts: { name: string; graceMs: number; beforeClose?: () => void; cleanup?: () => void | Promise<void> },
) {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${opts.name}: ${signal}, finishing open requests (up to ${Math.round(opts.graceMs / 1000)} s)…`);
    opts.beforeClose?.();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Keep-alive connections with no request in flight would otherwise hold the server open.
    if ('closeIdleConnections' in server) server.closeIdleConnections();
    const cutoff = setTimeout(() => {
      console.log(`${opts.name}: grace period over, closing what's still open`);
      if ('closeAllConnections' in server) server.closeAllConnections();
    }, opts.graceMs);
    cutoff.unref();
    await closed;
    clearTimeout(cutoff);
    await opts.cleanup?.();
    console.log(`${opts.name}: stopped`);
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}
