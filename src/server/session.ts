import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { roleCeiling, type Permission, type Role } from '../shared/contract.js';
import { authenticate } from './users.js';

/**
 * Login and sessions.
 *
 * Accounts live in MySQL (users.ts), each with a role: viewer, operator or
 * admin. The env account (ADMIN_USER, default `admin`, password from
 * ADMIN_PASSWORD or the older TERMINAL_PASSWORD) seeds the first admin row and
 * stays as a break-glass login used only while the database is unreachable,
 * so a stopped MySQL container cannot lock the owner out of the box. With
 * neither a database nor a password nobody can log in; the dashboard fails
 * closed rather than open.
 *
 * Sessions are server-side. The cookie holds a random token; only its SHA-256
 * is kept (in memory and in data/sessions.json), so a leaked file cannot be
 * replayed as a cookie. Logout deletes the record, which also closes any open
 * terminal for that session.
 */

export const ADMIN_USER = process.env.ADMIN_USER?.trim() || 'admin';
export const COOKIE = 'vps_session';
const TTL_MS = 7 * 24 * 3_600_000;

const PASSWORD = process.env.ADMIN_PASSWORD ?? process.env.TERMINAL_PASSWORD ?? '';
const PASSWORD_DIGEST = PASSWORD ? sha256(PASSWORD) : null;
const USER_DIGEST = sha256(ADMIN_USER);

const FILE = path.join(process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data'), 'sessions.json');

interface Record {
  readonly user: string;
  readonly role: Role;
  /** Copied at login; any change to the account ends its sessions, so it never goes stale. */
  readonly permissions: readonly Permission[];
  /** Row id in `users`; null for the break-glass env login. */
  readonly userId: number | null;
  readonly created: number;
  expires: number;
  readonly ip: string;
  readonly ua: string;
}

const sessions = new Map<string, Record>();
const endListeners: Array<(hash: string) => void> = [];

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Array<[string, Record]>;
    // Records from before roles existed have no role: drop them, the user logs in again.
    for (const [hash, rec] of raw) if (rec.expires > Date.now() && rec.role && Array.isArray(rec.permissions)) sessions.set(hash, rec);
  } catch {
    /* no file yet, or unreadable: start with no sessions */
  }
}

function persist(): void {
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...sessions]), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[session] could not persist sessions:', err instanceof Error ? err.message : err);
  }
}

load();

/** True when the env break-glass account can log in. */
export function passwordConfigured(): boolean {
  return PASSWORD_DIGEST !== null;
}

/** The env account's password, for seeding the first admin row. */
export function envAdminPassword(): string {
  return PASSWORD;
}

/** A password this short falls to an online guess run far sooner than the lockout suggests. */
export function passwordWeak(): boolean {
  return PASSWORD.length > 0 && PASSWORD.length < 12;
}

/** Both fields are always compared, so timing does not reveal which was wrong. */
function verifyEnvLogin(username: string, password: string): boolean {
  if (!PASSWORD_DIGEST) return false;
  const userOk = timingSafeEqual(sha256(username), USER_DIGEST);
  const passOk = timingSafeEqual(sha256(password), PASSWORD_DIGEST);
  return userOk && passOk;
}

export interface LoginUser {
  readonly id: number | null;
  readonly name: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
  /** True when the database was down and the env account let this login in. */
  readonly breakGlass: boolean;
}

/**
 * The account for these credentials, or null. The database decides whenever
 * it answers; the env account is tried only when it cannot be reached.
 */
export async function verifyLogin(username: unknown, password: unknown): Promise<LoginUser | null> {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (username.length > 64) return null;
  try {
    const user = await authenticate(username, password);
    return user ? { id: user.id, name: user.username, role: user.role, permissions: user.permissions, breakGlass: false } : null;
  } catch (err) {
    console.warn('[auth] user database unreachable:', err instanceof Error ? err.message : err);
    return verifyEnvLogin(username, password)
      ? { id: null, name: ADMIN_USER, role: 'superadmin', permissions: roleCeiling('superadmin'), breakGlass: true }
      : null;
  }
}

export function createSession(req: IncomingMessage, user: LoginUser): { token: string; hash: string; maxAgeSeconds: number } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const hash = sha256(token).toString('hex');
  sessions.set(hash, {
    user: user.name,
    role: user.role,
    permissions: user.permissions,
    userId: user.id,
    created: now,
    expires: now + TTL_MS,
    ip: peerAddress(req),
    ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
  });
  persist();
  return { token, hash, maxAgeSeconds: TTL_MS / 1000 };
}

function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Hash of a valid session for this request, or null. Expired ones are removed. */
export function sessionHash(req: IncomingMessage): string | null {
  const token = cookieToken(req.headers.cookie);
  if (!token) return null;
  const hash = sha256(token).toString('hex');
  return isValid(hash) ? hash : null;
}

export function isValid(hash: string): boolean {
  const rec = sessions.get(hash);
  if (!rec) return false;
  if (rec.expires <= Date.now()) {
    destroy(hash);
    return false;
  }
  return true;
}

export interface SessionUser {
  readonly id: number | null;
  readonly name: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export function userOf(hash: string): SessionUser | null {
  const rec = sessions.get(hash);
  return rec ? { id: rec.userId, name: rec.user, role: rec.role, permissions: rec.permissions } : null;
}

/** Ends every session of one account: after a role change, disable, password reset or delete. */
export function destroyUserSessions(userId: number): number {
  let n = 0;
  for (const [hash, rec] of sessions) {
    if (rec.userId === userId) {
      destroy(hash);
      n += 1;
    }
  }
  return n;
}

export function destroy(hash: string): void {
  if (!sessions.delete(hash)) return;
  persist();
  for (const fn of endListeners) fn(hash);
}

/** Called when a session ends (logout or expiry), e.g. to close its terminals. */
export function onSessionEnd(fn: (hash: string) => void): void {
  endListeners.push(fn);
}

export function setCookie(res: Response, req: Request, token: string, maxAgeSeconds: number): void {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (req.secure) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${flags.join('; ')}`);
}

/**
 * Sliding expiry: a session in use is pushed out to a full TTL again (at most
 * once an hour), with a fresh cookie, so a phone that keeps coming back is
 * never logged out mid-week. An unused one still ends TTL_MS after last use.
 */
export function renewSession(req: Request, res: Response): void {
  const token = cookieToken(req.headers.cookie);
  if (!token) return;
  const hash = sha256(token).toString('hex');
  const rec = sessions.get(hash);
  const now = Date.now();
  if (!rec || rec.expires <= now || rec.expires - now > TTL_MS - 3_600_000) return;
  rec.expires = now + TTL_MS;
  persist();
  setCookie(res, req, token, TTL_MS / 1000);
}

export function clearCookie(res: Response, req: Request): void {
  setCookie(res, req, '', 0);
}

/**
 * Strict same-origin check for state-changing requests. Browsers send Origin on
 * every POST and Sec-Fetch-Site on every request; either one from another site
 * refuses the request, and a request with neither is refused too (no browser
 * page sends that, so it is a script with a stolen cookie or a misconfigured proxy).
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return typeof site === 'string';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The real client address. Cloudflare's CF-Connecting-IP is believed only when
 * the connection itself comes from loopback (cloudflared runs on this host).
 * Anyone reaching port 80 directly (LAN, Tailscale) could otherwise send a new
 * fake address with every login attempt and never hit the lockout.
 */
export function peerAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const cf = req.headers['cf-connecting-ip'];
  if (LOOPBACK.has(peer) && typeof cf === 'string' && cf.length > 0 && cf.length <= 45) return cf;
  return peer || '?';
}

/** Gate for every API route except the few that must work logged out. */
export function requireSession(open: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (open.has(req.path)) {
      next();
      return;
    }
    const hash = sessionHash(req);
    if (!hash) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    res.locals.sessionHash = hash;
    next();
  };
}

/**
 * Gate for routes that need a permission. Mount after requireSession, which
 * leaves the session hash in res.locals.
 */
export function requirePerm(perm: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hash = (res.locals.sessionHash as string | undefined) ?? sessionHash(req);
    const user = hash ? userOf(hash) : null;
    if (!user) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    if (!user.permissions.includes(perm)) {
      res.status(403).json({ error: `you do not have the "${perm}" permission`, code: 'permission' });
      return;
    }
    next();
  };
}

// Login throttle: per client, so one attacker cannot lock the owner out.
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;
const fails = new Map<string, { n: number; since: number }>();

export function clientKey(req: Request): string {
  return peerAddress(req);
}

export function loginLocked(key: string): boolean {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.since > FAIL_WINDOW_MS) {
    fails.delete(key);
    return false;
  }
  return f.n >= MAX_FAILS;
}

export function loginFailed(key: string): void {
  const f = fails.get(key);
  if (!f || Date.now() - f.since > FAIL_WINDOW_MS) fails.set(key, { n: 1, since: Date.now() });
  else f.n += 1;
}

export function loginSucceeded(key: string): void {
  fails.delete(key);
}
