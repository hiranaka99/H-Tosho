import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { getDb, schema } from '../db/index.js';

const AUTH_KEY = 'app-auth';
const COOKIE_NAME = 'htosho_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_SESSIONS = 1000;
const PASSWORD_MIN_LENGTH = 8;

interface StoredCredentials {
  username: string;
  salt: string;
  passwordHash: string;
}

interface Session {
  username: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

/**
 * Parsed credentials cache: credentials() runs on every authenticated request
 * via requireAuth. `undefined` = not yet loaded; storeCredentials is the only
 * writer of the 'app-auth' key (grep-verified), so it keeps the cache in sync.
 */
let cachedCredentials: StoredCredentials | null | undefined;
 
function credentials(): StoredCredentials | null {
  if (cachedCredentials !== undefined) return cachedCredentials;
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, AUTH_KEY)).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.valueJson) as Partial<StoredCredentials>;
    if (typeof parsed.username === 'string' && typeof parsed.salt === 'string' && typeof parsed.passwordHash === 'string') {
      cachedCredentials = parsed as StoredCredentials;
    }
    return cachedCredentials ?? null;
  } catch {
    return null;
  }
}

function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

async function storeCredentials(username: string, password: string): Promise<void> {
  const salt = randomBytes(16);
  const passwordHash = (await hashPassword(password, salt)).toString('base64');
  const value: StoredCredentials = {
    username,
    salt: salt.toString('base64'),
    passwordHash,
  };
  getDb().insert(schema.keyValueStore)
    .values({ key: AUTH_KEY, valueJson: JSON.stringify(value) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(value) } })
    .run();
  cachedCredentials = value;
}

async function validPassword(password: string, stored: StoredCredentials): Promise<boolean> {
  const expected = Buffer.from(stored.passwordHash, 'base64');
  const actual = await hashPassword(password, Buffer.from(stored.salt, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function authenticatedUsername(c: Context): string | null {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.username;
}

function setSession(c: Context, username: string): void {
  const now = Date.now();
  if (sessions.size >= MAX_SESSIONS) {
    for (const [key, value] of sessions) {
      if (value.expiresAt <= now) sessions.delete(key);
    }
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { username, expiresAt: now + SESSION_TTL_MS });
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(c.req.url).protocol === 'https:' || forwardedProto === 'https',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function clearSession(c: Context): void {
  const token = getCookie(c, COOKIE_NAME);
  if (token) sessions.delete(token);
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

function validateCredentialsInput(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !username.trim()) return 'Username is required';
  if (username.trim().length > 100) return 'Username must be 100 characters or fewer';
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > 1024) return 'Password is too long';
  return null;
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/api/auth/status' || c.req.path === '/api/auth/setup' || c.req.path === '/api/auth/login') {
    await next();
    return;
  }
  if (!credentials()) return c.json({ error: 'Setup required' }, 403);
  if (!authenticatedUsername(c)) return c.json({ error: 'Authentication required' }, 401);
  await next();
};

/** The authenticated principal for the current request (null when unauthenticated).
 *  Search sessions bind to this so cursors are never transferable. */
export function currentPrincipal(c: Context): string | null {
  return authenticatedUsername(c);
}

export function authStatus(c: Context) {
  const stored = credentials();
  const username = authenticatedUsername(c);
  return c.json({ setupRequired: stored === null, authenticated: username !== null, username });
}

export async function setup(c: Context) {
  const body = await c.req.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  if (credentials()) return c.json({ error: 'Setup has already been completed' }, 409);
  const error = validateCredentialsInput(body?.username, body?.password);
  if (error) return c.json({ error }, 400);
  const username = (body!.username as string).trim();
  await storeCredentials(username, body!.password as string);
  setSession(c, username);
  return c.json({ authenticated: true, username }, 201);
}

export async function login(c: Context) {
  const stored = credentials();
  if (!stored) return c.json({ error: 'Setup required' }, 403);
  const body = await c.req.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  if (typeof body?.username !== 'string' || typeof body.password !== 'string' || body.username.trim() !== stored.username || !(await validPassword(body.password, stored))) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  setSession(c, stored.username);
  return c.json({ authenticated: true, username: stored.username });
}

export function logout(c: Context) {
  clearSession(c);
  return c.json({ authenticated: false });
}

export async function changeCredentials(c: Context) {
  const stored = credentials();
  if (!stored) return c.json({ error: 'Setup required' }, 403);
  const body = await c.req.json().catch(() => null) as { currentPassword?: unknown; username?: unknown; password?: unknown } | null;
  if (typeof body?.currentPassword !== 'string' || !(await validPassword(body.currentPassword, stored))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }
  const username = body.username === undefined ? stored.username : body.username;
  const password = body.password;
  const error = validateCredentialsInput(username, password);
  if (error) return c.json({ error }, 400);
  const nextUsername = (username as string).trim();
  await storeCredentials(nextUsername, password as string);
  sessions.clear();
  setSession(c, nextUsername);
  return c.json({ authenticated: true, username: nextUsername });
}
