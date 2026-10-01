import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { registerChatRoutes, type ChatDeps } from './chat.ts';
import { registerMemoryRoutes } from './memory-routes.ts';
import type { DB } from './db.ts';
import { getDummyHash, verifyPassword } from './passwords.ts';
import {
  createSession,
  deleteSession,
  getSessionUser,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionUser,
} from './sessions.ts';
import { LoginThrottle } from './throttle.ts';
import { findUser, nameOf } from './users.ts';

const MINUTE = 60_000;

export type AppOptions = Omit<ChatDeps, 'db'> & {
  db: DB;
  origin: string;
  clientIp: (c: Context) => string;
  // 5 misses on one username from one address, or 20 from one address, locks for 15 minutes.
  pairThrottle?: LoginThrottle;
  ipThrottle?: LoginThrottle;
};

type Env = { Variables: { user: SessionUser } };

export function createApp(opts: AppOptions) {
  const { db, origin, clientIp } = opts;
  const pairThrottle = opts.pairThrottle ?? new LoginThrottle(5, 15 * MINUTE, 15 * MINUTE);
  const ipThrottle = opts.ipThrottle ?? new LoginThrottle(20, 15 * MINUTE, 15 * MINUTE);
  const secure = origin.startsWith('https://');

  const app = new Hono<Env>();
  app.use('/api/*', csrf({ origin }));

  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) return c.json({ error: 'Username and password are required.' }, 400);

    const ip = clientIp(c);
    const pairKey = `${ip}|${username.toLowerCase()}`;
    const wait = Math.max(pairThrottle.retryAfter(pairKey), ipThrottle.retryAfter(ip));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      c.header('Retry-After', String(seconds));
      return c.json({ error: 'Too many failed attempts. Try again later.', retryAfterSeconds: seconds }, 429);
    }

    const user = findUser(db, username);
    // Always run one scrypt verify so unknown and disabled users take as long as a wrong password.
    const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok || user.disabled) {
      pairThrottle.fail(pairKey);
      ipThrottle.fail(ip);
      return c.json({ error: 'Invalid username or password.' }, 401);
    }

    pairThrottle.succeed(pairKey);
    setCookie(c, SESSION_COOKIE, createSession(db, user.id), {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ username: user.username, name: nameOf(user) });
  });

  app.post('/api/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure });
    return c.json({ ok: true });
  });

  // Everything under /api registered on `authed` requires a live session.
  const authed = new Hono<Env>();
  authed.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? getSessionUser(db, token) : undefined;
    if (!user) return c.json({ error: 'Not signed in.' }, 401);
    c.set('user', user);
    await next();
  });
  authed.get('/me', (c) => c.json({ username: c.get('user').username, name: c.get('user').name }));
  registerChatRoutes(authed, opts);
  registerMemoryRoutes(authed, db);

  app.route('/api', authed);
  return app;
}
