const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The backend listens on localhost behind a reverse proxy, which sets X-Forwarded-For
// to the real client address. Trust that header only when the connection itself is from
// localhost; from anywhere else it's client-controlled and ignored.
export function resolveClientIp(remote: string | undefined, forwardedFor: string | undefined): string {
  const addr = remote ?? 'unknown';
  if (!LOOPBACK.has(addr) || !forwardedFor) return addr;
  return forwardedFor.split(',').at(-1)?.trim() || addr;
}
