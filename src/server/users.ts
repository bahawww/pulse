import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AssignableRole, Role, UserRow } from '../shared/contract.js';
import { getPool } from './db.js';

/**
 * Login accounts in MySQL (table `users`, deploy/sql/001_users.sql).
 *
 * Passwords are scrypt hashes, stored as `scrypt$N$r$p$salt$hash` so the cost
 * can be raised later without breaking old rows. phpMyAdmin can view and edit
 * rows (role, disabled) but cannot make a hash; scripts/user.mjs and the Users
 * view can.
 *
 * Guards that keep the box reachable: the superadmin (the env ADMIN_USER) can
 * never be deleted, disabled, demoted or renamed, and only it may set its own
 * password; the last enabled admin cannot be removed; nobody can do any of
 * that to themselves. ensureSuperadmin restores the superadmin at every start,
 * so a row deleted in phpMyAdmin comes back.
 */

export const ROLES: readonly AssignableRole[] = ['viewer', 'operator', 'admin'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash, extra] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash || extra !== undefined) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length === 0) return false;
  try {
    const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Hashed once, compared against when the username does not exist, so a miss
// costs the same as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

export function isRole(v: unknown): v is AssignableRole {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function validUsername(v: unknown): v is string {
  return typeof v === 'string' && USERNAME_RE.test(v);
}

/** Any non-empty password is accepted: no length or character rules (owner's choice). */
export function passwordProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return 'password required';
  return null;
}

interface Row extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: Date;
  last_login_at: Date | null;
}

function db() {
  const p = getPool();
  if (!p) throw new Error('user database not configured');
  return p;
}

function toUser(r: Row): UserRow {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    disabled: r.disabled === 1,
    createdAt: r.created_at.getTime(),
    lastLoginAt: r.last_login_at ? r.last_login_at.getTime() : null,
  };
}

/** The account for these credentials, or null. Disabled accounts never match. Throws if the DB is down. */
export async function authenticate(username: string, password: string): Promise<UserRow | null> {
  const [rows] = await db().query<Row[]>('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
  const row = rows[0];
  const ok = await verifyPassword(password, row ? row.password_hash : await DUMMY_HASH);
  if (!row || !ok || row.disabled) return null;
  await db().query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
  return toUser(row);
}

export async function getUser(id: number): Promise<UserRow | null> {
  const [rows] = await db().query<Row[]>('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function listUsers(): Promise<UserRow[]> {
  const [rows] = await db().query<Row[]>('SELECT * FROM users ORDER BY username');
  return rows.map(toUser);
}

export async function countUsers(): Promise<number> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

async function enabledAdmins(): Promise<number> {
  const [rows] = await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin', 'superadmin') AND disabled = 0");
  return Number(rows[0]?.n ?? 0);
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function createUser(username: string, password: string, role: AssignableRole): Promise<UserRow> {
  const hash = await hashPassword(password);
  try {
    const [res] = await db().query<ResultSetHeader>('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
    return (await getUser(res.insertId))!;
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new UserError('username already exists', 409);
    throw err;
  }
}

/** Refuses a change that would leave no enabled admin, or that the actor makes to their own account. */
async function guard(actorId: number | null, target: UserRow, losesAdmin: boolean): Promise<void> {
  if (target.role === 'superadmin') throw new UserError('the superadmin cannot be changed or deleted', 403);
  if (actorId !== null && actorId === target.id) throw new UserError('you cannot do this to your own account', 403);
  if (losesAdmin && target.role === 'admin' && !target.disabled && (await enabledAdmins()) <= 1) {
    throw new UserError('this is the last enabled admin', 409);
  }
}

export async function updateUser(actorId: number | null, id: number, change: { role?: AssignableRole; disabled?: boolean }): Promise<UserRow> {
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  const losesAdmin = (change.role !== undefined && change.role !== 'admin') || change.disabled === true;
  await guard(actorId, target, losesAdmin);
  const role = change.role ?? target.role;
  const disabled = change.disabled ?? target.disabled;
  await db().query('UPDATE users SET role = ?, disabled = ? WHERE id = ?', [role, disabled ? 1 : 0, id]);
  return (await getUser(id))!;
}

/** actorId null means a trusted caller (the CLI); the API always passes the logged-in id. */
export async function setPassword(actorId: number | null, id: number, password: string, trusted = false): Promise<void> {
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  if (target.role === 'superadmin' && !trusted && actorId !== id) throw new UserError('only the superadmin can change its own password', 403);
  const hash = await hashPassword(password);
  const [res] = await db().query<ResultSetHeader>('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
  if (res.affectedRows === 0) throw new UserError('no such user', 404);
}

export async function deleteUser(actorId: number | null, id: number): Promise<UserRow> {
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  await guard(actorId, target, true);
  await db().query('DELETE FROM users WHERE id = ?', [id]);
  return target;
}

/**
 * Makes `username` the one superadmin: promotes, re-enables and keeps its row,
 * demotes any other superadmin to admin, and re-creates the row from the env
 * password if it was deleted. Returns what it did, for the start-up log.
 */
export async function ensureSuperadmin(username: string, password: string): Promise<string> {
  await db().query("UPDATE users SET role = 'admin' WHERE role = 'superadmin' AND username <> ?", [username]);
  const [res] = await db().query<ResultSetHeader>("UPDATE users SET role = 'superadmin', disabled = 0 WHERE username = ?", [username]);
  if (res.affectedRows > 0) return res.changedRows > 0 ? `restored superadmin ${username}` : `superadmin ${username}`;
  if (!password) return `no superadmin: ${username} is missing and ADMIN_PASSWORD is not set`;
  await db().query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'superadmin')", [username, await hashPassword(password)]);
  return `created superadmin ${username}`;
}
