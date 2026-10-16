import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { recordAction } from './store.js';
import {
  changeOwnPassword,
  createUser,
  deleteUser,
  isRole,
  listUsers,
  passwordProblem,
  renameUser,
  setPassword,
  updateUser,
  UserError,
  validUsername,
  type Actor,
} from './users.js';
import type { SessionUser } from './session.js';

/**
 * /api/users: list, create, update (role, status, permissions), username,
 * password, delete; and /api/auth/password for everyone's own password.
 * Mounted behind the session and CSRF gates in index.ts. The rules for who may
 * change whom live in users.ts; any change to an account ends its sessions, so
 * a new role or permission list applies at once.
 */

type EndSessions = (userId: number) => number;

function actor(res: Response): Actor {
  return res.locals.actor as Actor;
}

function audit(action: string, name: string, started: number, ok: boolean, message: string): void {
  recordAction({ ts: Date.now(), target: 'users', name, action, ok, message, durationMs: Date.now() - started });
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new UserError('bad id');
  return id;
}

/** Runs a handler that returns the audit line ('' = nothing to log), and turns errors into answers. */
function wrap(action: string, fn: (req: Request, res: Response) => Promise<string>): RequestHandler {
  return (req, res) => {
    const started = Date.now();
    fn(req, res)
      .then((name) => {
        if (name) audit(action, name, started, true, 'done');
      })
      .catch((err: unknown) => {
        const status = err instanceof UserError ? err.status : 503;
        const message = err instanceof UserError ? err.message : 'user database unavailable';
        if (!(err instanceof UserError)) console.warn(`[users] ${action} failed:`, err instanceof Error ? err.message : err);
        audit(action, String(req.params.id ?? (req.body as { username?: unknown })?.username ?? '?').slice(0, 64), started, false, message);
        if (!res.headersSent) res.status(status).json({ error: message });
      });
  };
}

function permissionList(v: unknown): readonly unknown[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 64) throw new UserError('permissions must be a list');
  return v;
}

export function registerUserRoutes(app: Express, limiter: RequestHandler, endSessions: EndSessions, who: (req: Request) => SessionUser | null): void {
  // Who is asking. Anyone logged in passes; the rules in users.ts decide the rest.
  const gate = [
    limiter,
    (req: Request, res: Response, next: NextFunction) => {
      const u = who(req);
      if (!u) {
        res.status(401).json({ error: 'login required' });
        return;
      }
      res.locals.actor = { id: u.id, role: u.role, permissions: u.permissions } satisfies Actor;
      next();
    },
  ];
  const manager = (_req: Request, res: Response, next: NextFunction) => {
    const a = actor(res);
    if (a.role === 'superadmin' || a.permissions.includes('users:manage')) next();
    else res.status(403).json({ error: 'you may not manage users', code: 'permission' });
  };

  app.get(
    '/api/users',
    ...gate,
    manager,
    wrap('list', async (_req, res) => {
      res.json({ users: await listUsers() });
      return '';
    }),
  );

  app.post(
    '/api/users',
    ...gate,
    manager,
    wrap('create', async (req, res) => {
      const body = req.body as { username?: unknown; password?: unknown; role?: unknown; permissions?: unknown };
      if (!validUsername(body.username)) throw new UserError('username: 2-64 chars, a-z 0-9 . _ - , starting with a letter or digit');
      if (!isRole(body.role)) throw new UserError('role must be viewer, operator or admin');
      const problem = passwordProblem(body.password);
      if (problem) throw new UserError(problem);
      const user = await createUser(actor(res), body.username, body.password as string, body.role, permissionList(body.permissions) ?? null);
      res.status(201).json({ user });
      return `${user.username} as ${user.role}`;
    }),
  );

  app.post(
    '/api/users/:id',
    ...gate,
    manager,
    wrap('update', async (req, res) => {
      const id = idParam(req);
      const body = req.body as { role?: unknown; disabled?: unknown; permissions?: unknown };
      if (body.role !== undefined && !isRole(body.role)) throw new UserError('role must be viewer, operator or admin');
      if (body.disabled !== undefined && typeof body.disabled !== 'boolean') throw new UserError('disabled must be true or false');
      const user = await updateUser(actor(res), id, { role: body.role, disabled: body.disabled, permissions: permissionList(body.permissions) });
      endSessions(id);
      res.json({ user });
      return `${user.username}: ${user.role}${user.disabled ? ', disabled' : ''}, ${user.permissions.length} permissions`;
    }),
  );

  app.post(
    '/api/users/:id/username',
    ...gate,
    wrap('rename', async (req, res) => {
      const id = idParam(req);
      const username = (req.body as { username?: unknown }).username;
      if (!validUsername(username)) throw new UserError('username: 2-64 chars, a-z 0-9 . _ - , starting with a letter or digit');
      const user = await renameUser(actor(res), id, username);
      // The session holds the old name; the person logs in again with the new one.
      endSessions(id);
      res.json({ user });
      return `#${id} -> ${user.username}`;
    }),
  );

  app.post(
    '/api/users/:id/password',
    ...gate,
    wrap('password', async (req, res) => {
      const id = idParam(req);
      const password = (req.body as { password?: unknown }).password;
      const problem = passwordProblem(password);
      if (problem) throw new UserError(problem);
      const user = await setPassword(actor(res), id, password as string);
      // The superadmin's own reset keeps this session; everyone else is logged out.
      if (id !== actor(res).id) endSessions(id);
      res.json({ ok: true });
      return user.username;
    }),
  );

  app.post(
    '/api/users/:id/delete',
    ...gate,
    manager,
    wrap('delete', async (req, res) => {
      const id = idParam(req);
      const user = await deleteUser(actor(res), id);
      endSessions(id);
      res.json({ ok: true });
      return user.username;
    }),
  );

  app.post(
    '/api/auth/password',
    ...gate,
    wrap('own password', async (req, res) => {
      const a = actor(res);
      if (a.id === null) throw new UserError('the break-glass login has no account to change', 400);
      const body = req.body as { current?: unknown; next?: unknown };
      if (typeof body.current !== 'string') throw new UserError('current password required');
      const problem = passwordProblem(body.next);
      if (problem) throw new UserError(problem);
      await changeOwnPassword(a.id, body.current, body.next as string);
      res.json({ ok: true });
      return `#${a.id}`;
    }),
  );
}
