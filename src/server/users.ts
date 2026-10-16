import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  effectivePermissions,
  isPermission,
  ROLE_RANK,
  roleCeiling,
  type AssignableRole,
  type Permission,
  type Role,
  type UserRow,
} from '../shared/contract.js';
import { getPool } from './db.js';

/**
 * Login accounts in MySQL (table `users`, deploy/sql/).
 *
 * Passwords are scrypt hashes, stored as `scrypt$N$r$p$salt$hash` so the cost
 * can be raised later without breaking old rows. phpMyAdmin can view and edit
 * rows but cannot make a hash; scripts/user.mjs and the Users view can.
 *
 * Each user has a role (a ceiling) and a permission list within it
 * (`permissions` JSON, NULL = the role's defaults). Who may change whom:
 *  - the superadmin: anyone else, everything, including username and password;
 *    its own username and password too. It cannot be deleted, disabled or demoted.
 *  - an admin with `users:manage`: only viewers and operators (role up to
 *    operator, permissions, disabled, delete). Not usernames or passwords.
 *  - everyone: their own password, with the current one.
 * Nobody changes their own role, permissions or status, and the last enabled
 * admin-or-above is never removed. ensureSuperadmin keeps exactly one
 * superadmin, re-created from the env account if it goes missing.
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
  permissions: unknown;
  disabled: number;
  created_at: Date;
  last_login_at: Date | null;
}

function db() {
  const p = getPool();
  if (!p) throw new Error('user database not configured');
  return p;
}

/** The stored list (mysql2 parses JSON columns), or null for "role defaults". */
function storedPermissions(v: unknown): string[] | null {
  let list = v;
  if (typeof v === 'string') {
    try {
      list = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : null;
}

function toUser(r: Row): UserRow {
  const stored = storedPermissions(r.permissions);
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    disabled: r.disabled === 1,
    permissions: effectivePermissions(r.role, stored),
    customized: stored !== null && r.role !== 'superadmin',
    createdAt: r.created_at.getTime(),
    lastLoginAt: r.last_login_at ? r.last_login_at.getTime() : null,
  };
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
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
  const [rows] = await db().query<Row[]>("SELECT * FROM users ORDER BY FIELD(role, 'superadmin', 'admin', 'operator', 'viewer'), username");
  return rows.map(toUser);
}

async function enabledAdmins(): Promise<number> {
  const [rows] = await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin', 'superadmin') AND disabled = 0");
  return Number(rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------ who may do what

/** The logged-in person making a change. id null = the break-glass env login (acts as superadmin). */
export interface Actor {
  readonly id: number | null;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

function isSuper(a: Actor): boolean {
  return a.role === 'superadmin';
}

function mayManageUsers(a: Actor): void {
  if (!isSuper(a) && !a.permissions.includes('users:manage')) throw new UserError('you may not manage users', 403);
}

/** May `a` manage `target` at all (status, role, permissions, delete)? */
function mayManage(a: Actor, target: UserRow): void {
  mayManageUsers(a);
  if (a.id !== null && a.id === target.id) throw new UserError('you cannot change your own role, permissions or status', 403);
  if (target.role === 'superadmin') throw new UserError('the superadmin cannot be changed this way', 403);
  if (!isSuper(a) && ROLE_RANK[target.role] >= ROLE_RANK.admin) throw new UserError('only the superadmin manages admins', 403);
}

/** May `a` give out `role`? Admins only up to operator. */
function mayAssign(a: Actor, role: AssignableRole): void {
  if (!isSuper(a) && ROLE_RANK[role] >= ROLE_RANK.admin) throw new UserError('only the superadmin can make admins', 403);
}

/** Keeps a requested list to known keys within the role's ceiling. */
function cleanPermissions(role: Role, wanted: readonly unknown[]): Permission[] {
  const ceiling = new Set<string>(roleCeiling(role));
  return wanted.filter((p): p is Permission => isPermission(p) && ceiling.has(p));
}

// ------------------------------------------------------------------ changes

export async function createUser(a: Actor, username: string, password: string, role: AssignableRole, permissions: readonly unknown[] | null): Promise<UserRow> {
  mayManageUsers(a);
  mayAssign(a, role);
  const perms = permissions === null ? null : JSON.stringify(cleanPermissions(role, permissions));
  const hash = await hashPassword(password);
  try {
    const [res] = await db().query<ResultSetHeader>('INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)', [username, hash, role, perms]);
    return (await getUser(res.insertId))!;
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new UserError('username already exists', 409);
    throw err;
  }
}

export interface UserChange {
  readonly role?: AssignableRole;
  readonly disabled?: boolean;
  /** A list, or null to go back to the role's defaults. */
  readonly permissions?: readonly unknown[] | null;
}

export async function updateUser(a: Actor, id: number, change: UserChange): Promise<UserRow> {
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  mayManage(a, target);
  const role = change.role ?? (target.role as AssignableRole);
  if (change.role !== undefined) mayAssign(a, change.role);
  const losesAdmin = role !== 'admin' || change.disabled === true;
  if (losesAdmin && target.role === 'admin' && !target.disabled && (await enabledAdmins()) <= 1) {
    throw new UserError('this is the last enabled admin', 409);
  }
  const disabled = change.disabled ?? target.disabled;
  // A role change without a new list resets to the new role's defaults: the old list was for another ceiling.
  let perms: string | null | undefined;
  if (change.permissions !== undefined) perms = change.permissions === null ? null : JSON.stringify(cleanPermissions(role, change.permissions));
  else if (change.role !== undefined && change.role !== target.role) perms = null;
  if (perms === undefined) await db().query('UPDATE users SET role = ?, disabled = ? WHERE id = ?', [role, disabled ? 1 : 0, id]);
  else await db().query('UPDATE users SET role = ?, disabled = ?, permissions = ? WHERE id = ?', [role, disabled ? 1 : 0, perms, id]);
  return (await getUser(id))!;
}

/** Superadmin only (any account, its own included). */
export async function renameUser(a: Actor, id: number, username: string): Promise<UserRow> {
  if (!isSuper(a)) throw new UserError('only the superadmin can change usernames', 403);
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  try {
    await db().query('UPDATE users SET username = ? WHERE id = ?', [username, id]);
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new UserError('username already exists', 409);
    throw err;
  }
  return (await getUser(id))!;
}

/** Superadmin only, for any account. Everyone else uses changeOwnPassword. */
export async function setPassword(a: Actor, id: number, password: string): Promise<UserRow> {
  if (!isSuper(a)) throw new UserError("only the superadmin can set other people's passwords", 403);
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  await db().query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), id]);
  return target;
}

/** Anyone, for their own account, with the current password. */
export async function changeOwnPassword(id: number, current: string, next: string): Promise<void> {
  const [rows] = await db().query<Row[]>('SELECT * FROM users WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) throw new UserError('no such user', 404);
  if (!(await verifyPassword(current, row.password_hash))) throw new UserError('current password is wrong', 403);
  await db().query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), id]);
}

export async function deleteUser(a: Actor, id: number): Promise<UserRow> {
  const target = await getUser(id);
  if (!target) throw new UserError('no such user', 404);
  mayManage(a, target);
  if (target.role === 'admin' && !target.disabled && (await enabledAdmins()) <= 1) throw new UserError('this is the last enabled admin', 409);
  await db().query('DELETE FROM users WHERE id = ?', [id]);
  return target;
}

/**
 * Keeps exactly one superadmin. If one exists (under any name: the superadmin
 * may rename itself) it is re-enabled and kept; extra ones are made admins.
 * With none, the env account's row is promoted, or re-created from the env
 * password if it was deleted. Returns what it did, for the start-up log.
 */
export async function ensureSuperadmin(username: string, password: string): Promise<string> {
  const [supers] = await db().query<Row[]>("SELECT * FROM users WHERE role = 'superadmin' ORDER BY id");
  const keep = supers[0];
  if (keep) {
    if (supers.length > 1) await db().query("UPDATE users SET role = 'admin' WHERE role = 'superadmin' AND id <> ?", [keep.id]);
    if (keep.disabled) await db().query('UPDATE users SET disabled = 0 WHERE id = ?', [keep.id]);
    return keep.disabled || supers.length > 1 ? `restored superadmin ${keep.username}` : `superadmin ${keep.username}`;
  }
  const [res] = await db().query<ResultSetHeader>("UPDATE users SET role = 'superadmin', disabled = 0, permissions = NULL WHERE username = ?", [username]);
  if (res.affectedRows > 0) return `restored superadmin ${username}`;
  if (!password) return `no superadmin: ${username} is missing and ADMIN_PASSWORD is not set`;
  await db().query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'superadmin')", [username, await hashPassword(password)]);
  return `created superadmin ${username}`;
}
