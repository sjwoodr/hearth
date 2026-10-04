import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** The default: only a proxy on this machine (Caddy-style, or the Vite dev proxy) is trusted. */
export const LOOPBACK_PROXIES = '127.0.0.0/8, ::1/128';

/**
 * Parses HEARTH_TRUSTED_PROXIES: comma-separated addresses or CIDR ranges, IPv4 or IPv6
 * (e.g. "127.0.0.0/8, ::1/128, 10.42.0.0/16" for loopback plus a k3s pod network). Throws on
 * anything it can't read, so a typo stops startup instead of quietly trusting the wrong thing.
 */
export function parseTrustedProxies(spec: string): BlockList {
  const list = new BlockList();
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = parseRange(entry);
    if (!range) throw new Error(`HEARTH_TRUSTED_PROXIES: can't read "${entry}".`);
    list.addSubnet(range.address, range.prefix, range.type);
  }
  return list;
}

// "10.42.0.0/16", "::1/128", or a bare address (a range of one). Undefined if it isn't one.
function parseRange(entry: string): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } | undefined {
  const [address = '', bits] = entry.split('/');
  const type = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : undefined;
  if (!type) return undefined;
  const max = type === 'ipv4' ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : NaN;
  return prefix >= 0 && prefix <= max ? { address, prefix, type } : undefined;
}

const DEFAULT_TRUSTED = parseTrustedProxies(LOOPBACK_PROXIES);

// An IPv4 client on a dual-stack socket shows up as ::ffff:a.b.c.d; treat it as a.b.c.d.
const plain = (ip: string) => (ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

function trusts(list: BlockList, ip: string): boolean {
  if (isIPv4(ip)) return list.check(ip, 'ipv4');
  if (isIPv6(ip)) return list.check(ip, 'ipv6');
  return false;
}

/**
 * The client's address, for the login throttle. X-Forwarded-For counts only when the connection
 * itself comes from a trusted proxy; from anywhere else the header is client-controlled and ignored.
 * Each proxy appends the address it saw, so the client is the rightmost hop we don't trust: a
 * client that sends its own X-Forwarded-For only adds entries to the left of the real one.
 */
export function resolveClientIp(remote: string | undefined, forwardedFor: string | undefined, trusted = DEFAULT_TRUSTED): string {
  const addr = remote ? plain(remote) : 'unknown';
  if (!forwardedFor || !trusts(trusted, addr)) return addr;
  const hops = forwardedFor
    .split(',')
    .map((s) => plain(s.trim()))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusts(trusted, hops[i]!)) return hops[i]!;
  // Every hop is one of our proxies: the leftmost is the closest thing to a client.
  return hops[0] ?? addr;
}
