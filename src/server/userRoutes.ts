import type { Express, Request, RequestHandler, Response } from 'express';
import { recordAction } from './store.js';
import {
  createUser,
  deleteUser,
  getUser,
  isRole,
  listUsers,
  passwordProblem,
  setPassword,
  updateUser,
  UserError,
  validUsername,
} from './users.js';

/**
 * /api/users: list, create, change role or disabled, reset password, delete.
 * Mounted behind the session and CSRF gates in index.ts plus an admin role
 * check. Every write lands in the action log, and any change to an account
 * ends that account's open sessions so a new role or a revoked login takes
 * effect at once.
 */

type EndSessions = (userId: number) => number;

function actorId(res: Response): number | null {
  return (res.locals.actorId as number | null | undefined) ?? null;
}

function audit(action: string, name: string, started: number, ok: boolean, message: string): void {
  recordAction({ ts: Date.now(), target: 'users', name, action, ok, message, durationMs: Date.now() - started });
}

function idParam(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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

export function registerUserRoutes(app: Express, limiter: RequestHandler, admin: RequestHandler, endSessions: EndSessions, whoAmI: (req: Request) => number | null): void {
  const gate = [limiter, admin, (req: Request, res: Response, next: () => void) => {
    res.locals.actorId = whoAmI(req);
    next();
  }];

  app.get('/api/users', ...gate, wrap('list', async (_req, res) => {
    res.json({ users: await listUsers() });
    return '';
  }));

  app.post('/api/users', ...gate, wrap('create', async (req, res) => {
    const body = req.body as { username?: unknown; password?: unknown; role?: unknown };
    if (!validUsername(body.username)) throw new UserError('username: 2-64 chars, a-z 0-9 . _ - , starting with a letter or digit');
    if (!isRole(body.role)) throw new UserError('role must be viewer, operator or admin');
    const problem = passwordProblem(body.password);
    if (problem) throw new UserError(problem);
    const user = await createUser(body.username, body.password as string, body.role);
    res.status(201).json({ user });
    return `${user.username} as ${user.role}`;
  }));

  app.post('/api/users/:id', ...gate, wrap('update', async (req, res) => {
    const id = idParam(req);
    if (!id) throw new UserError('bad id');
    const body = req.body as { role?: unknown; disabled?: unknown };
    if (body.role !== undefined && !isRole(body.role)) throw new UserError('role must be viewer, operator or admin');
    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') throw new UserError('disabled must be true or false');
    const user = await updateUser(actorId(res), id, { role: body.role, disabled: body.disabled });
    endSessions(id);
    res.json({ user });
    return `${user.username}: role ${user.role}${user.disabled ? ', disabled' : ''}`;
  }));

  app.post('/api/users/:id/password', ...gate, wrap('password', async (req, res) => {
    const id = idParam(req);
    if (!id) throw new UserError('bad id');
    const password = (req.body as { password?: unknown }).password;
    const problem = passwordProblem(password);
    if (problem) throw new UserError(problem);
    await setPassword(actorId(res), id, password as string);
    // Your own reset keeps this session; everyone else is logged out.
    if (id !== actorId(res)) endSessions(id);
    const user = await getUser(id);
    res.json({ ok: true });
    return user?.username ?? String(id);
  }));

  app.post('/api/users/:id/delete', ...gate, wrap('delete', async (req, res) => {
    const id = idParam(req);
    if (!id) throw new UserError('bad id');
    const user = await deleteUser(actorId(res), id);
    endSessions(id);
    res.json({ ok: true });
    return user.username;
  }));
}
