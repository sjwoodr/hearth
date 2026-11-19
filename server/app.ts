import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { registerChatRoutes, type ChatDeps } from './chat.ts';
import { registerMemoryRoutes } from './memory-routes.ts';
import { registerModelRoutes } from './model-routes.ts';
import { assistantNameFor } from './persona.ts';
import type { DB } from './db.ts';
import { registerHealthRoutes, type ModelsProbe } from './health.ts';
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
import { VERSION } from './version.ts';
import { registerSpeechRoutes, type SpeechDeps } from './speech.ts';
import { registerWordRoutes, type LookupWord } from './word-lookup.ts';

const MINUTE = 60_000;

export type AppOptions = Omit<ChatDeps, 'db'> & {
  db: DB;
  origin: string;
  clientIp: (c: Context) => string;
  // 5 misses on one username from one address, or 20 from one address, locks for 15 minutes.
  pairThrottle?: LoginThrottle;
  ipThrottle?: LoginThrottle;
  /** For /readyz: whether the models are reachable (reported, never failing readiness). */
  checkModels?: ModelsProbe;
  /** The translation popup's lookup; without one the route doesn't exist. */
  lookupWord?: LookupWord;
  /** Reading aloud (speech.ts); without it the routes don't exist and the app shows no play buttons. */
  speech?: SpeechDeps;
};

type Env = { Variables: { user: SessionUser } };

export function createApp(opts: AppOptions) {
  const { db, origin, clientIp } = opts;
  const pairThrottle = opts.pairThrottle ?? new LoginThrottle(5, 15 * MINUTE, 15 * MINUTE);
  const ipThrottle = opts.ipThrottle ?? new LoginThrottle(20, 15 * MINUTE, 15 * MINUTE);
  const secure = origin.startsWith('https://');
  // Who's signed in, and the name their assistant goes by (persona.ts): the chat box and the other places
  // where the assistant itself acts use it ("Message Gemma"), while the app stays hearth.
  const meOf = (id: number, username: string, name: string, role: string) => ({
    username,
    name,
    role,
    isAdmin: role === 'admin',
    assistantName: assistantNameFor(db, id, opts.assistantName ?? 'hearth'),
  });

  const app = new Hono<Env>();
  registerHealthRoutes(app, { db, models: opts.checkModels });
  app.use('/api/*', csrf({ origin }));
  // Every answer says which build the server is, so an open page notices a deploy (client/src/api.ts).
  app.use('/api/*', async (c, next) => {
    c.header('X-Hearth-Version', VERSION);
    await next();
  });

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
    return c.json(meOf(user.id, user.username, nameOf(user), user.role));
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
    // Every answer says which model is in use, so the client notices an admin's switch on its next request.
    const model = opts.modelChoice?.info();
    if (model) {
      c.header('X-Hearth-Model', model.model);
      c.header('X-Hearth-Model-Default', model.isDefault ? '1' : '0');
    }
    await next();
  });
  authed.get('/me', (c) => {
    const user = c.get('user');
    return c.json(meOf(user.id, user.username, user.name, user.role));
  });
  registerChatRoutes(authed, opts);
  registerMemoryRoutes(authed, db, opts.assistantName, opts.systemPrompt);
  registerModelRoutes(authed, opts);
  registerWordRoutes(authed, opts.lookupWord);
  registerSpeechRoutes(authed, db, opts.speech);

  app.route('/api', authed);
  return app;
}
