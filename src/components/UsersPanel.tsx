import { type FormEvent, type JSX, useCallback, useEffect, useState } from 'react';
import type { AssignableRole, Role, UserRow } from '../shared/contract';
import { formatDay, formatClock } from '../shared/time';
import { postJson } from '../lib/csrf';
import { ConfirmDialog } from './ConfirmDialog';
import { SelectMenu } from './SelectMenu';
import { Bone, Loading } from './Skeleton';
import { RefreshIcon, TrashIcon } from './icons';

/**
 * Login accounts (admin only). Rows live in MySQL (src/server/users.ts) and
 * can also be read in phpMyAdmin. Any change here logs that account out, so a
 * new role or a disable takes effect at once. The server refuses changes to
 * your own account and to the last enabled admin. The superadmin row is
 * locked: only its owner can change its password, nothing else.
 */

interface UsersPanelProps {
  readonly selfId: number | null;
  readonly onNotify: (message: string) => void;
}

const ROLES: readonly AssignableRole[] = ['viewer', 'operator', 'admin'];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r }));
const ROLE_HINT: Readonly<Record<Role, string>> = {
  viewer: 'read-only monitoring and logs',
  operator: 'also start, stop and restart services',
  admin: 'also terminal, files and users',
  superadmin: 'everything; cannot be changed or deleted',
};

const field =
  'tw:rounded-md tw:border tw:border-line-strong tw:bg-surface-2 tw:px-3 tw:py-1.5 tw:text-[13px] tw:text-fg tw:outline-none';

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `failed (${res.status})`;
}

function when(ts: number | null): string {
  return ts === null ? 'never' : `${formatDay(ts)} ${formatClock(ts, false)}`;
}

export function UsersPanel({ selfId, onNotify }: UsersPanelProps): JSX.Element {
  const [users, setUsers] = useState<readonly UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [newRole, setNewRole] = useState<AssignableRole>('viewer');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/users', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      setUsers(((await res.json()) as { users: UserRow[] }).users);
      setError(null);
    } catch {
      setError('server unreachable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (path: string, body: unknown, done: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await postJson(path, body);
        if (!res.ok) {
          onNotify(await errorOf(res));
          return false;
        }
        onNotify(done);
        await load();
        return true;
      } catch {
        onNotify('server unreachable');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onNotify],
  );

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const username = String(data.get('username') ?? '').trim().toLowerCase();
    const ok = await send('/api/users', { username, password: data.get('password'), role: newRole }, `Added ${username}`);
    if (ok) {
      form.reset();
      setNewRole('viewer');
    }
  }

  async function resetPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!resetFor) return;
    const password = new FormData(e.currentTarget).get('password');
    const ok = await send(`/api/users/${resetFor.id}/password`, { password }, `Password changed for ${resetFor.username}`);
    if (ok) setResetFor(null);
  }

  return (
    <section className="card" aria-labelledby="users-h">
      <div className="card-head">
        <div>
          <h3 id="users-h" className="card-title">
            Users
          </h3>
          <p className="card-sub">who can log in, and what they may do. Stored in MySQL.</p>
        </div>
        <button type="button" className="btn btn-icon btn-sm" onClick={() => void load()} aria-label="Refresh" title="Refresh">
          <RefreshIcon size={14} />
        </button>
      </div>

      <form onSubmit={(e) => void create(e)} className="tw:mb-4 tw:flex tw:flex-wrap tw:items-end tw:gap-2">
        <label className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          Username
          <input name="username" required minLength={2} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]+" autoComplete="off" spellCheck={false} className={field} />
        </label>
        <label className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          Password
          <input name="password" type="password" required autoComplete="new-password" className={field} />
        </label>
        <div className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          <span aria-hidden="true">Role</span>
          <SelectMenu label="Role" value={newRole} options={ROLE_OPTIONS} onChange={(v) => setNewRole(v as AssignableRole)} />
        </div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Add user
        </button>
      </form>

      {resetFor && (
        <form onSubmit={(e) => void resetPassword(e)} className="confirm tw:flex tw:flex-wrap tw:items-end tw:gap-2" aria-label={`New password for ${resetFor.username}`}>
          <label className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
            New password for <strong>{resetFor.username}</strong>
            <input name="password" type="password" required autoComplete="new-password" autoFocus className={field} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Set password
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setResetFor(null)}>
            Cancel
          </button>
        </form>
      )}

      {error && <p className="result is-error">{error}</p>}
      {!users && !error && (
        <Loading what="users">
          <Bone h={28} />
          <Bone h={28} />
        </Loading>
      )}

      {users && (
        // No overflow wrapper: a scroll container would clip the role dropdown.
        <div>
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th className="tw:max-sm:hidden">Last login</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === selfId;
                const locked = u.role === 'superadmin';
                return (
                  <tr key={u.id}>
                    <td>
                      {u.username}
                      {self && <span className="muted"> (you)</span>}
                    </td>
                    <td>
                      {locked ? (
                        <span className="pill is-warn" title={ROLE_HINT.superadmin}>
                          superadmin
                        </span>
                      ) : (
                      <SelectMenu
                        label={`Role of ${u.username}`}
                        value={u.role}
                        options={ROLE_OPTIONS}
                        disabled={busy || self}
                        title={self ? 'You cannot change your own role' : ROLE_HINT[u.role]}
                        onChange={(v) => {
                          if (v !== u.role) void send(`/api/users/${u.id}`, { role: v }, `${u.username} is now ${v}`);
                        }}
                      />
                      )}
                    </td>
                    <td>
                      <span className={`pill ${u.disabled ? 'is-crit' : 'is-ok'}`}>{u.disabled ? 'disabled' : 'active'}</span>
                    </td>
                    <td className="muted tw:max-sm:hidden">{when(u.lastLoginAt)}</td>
                    <td>
                      <span className="tw:flex tw:justify-end tw:gap-1">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy || (locked && !self)}
                          title={locked && !self ? 'Only the superadmin can change this password' : undefined}
                          onClick={() => setResetFor(u)}
                        >
                          Password
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy || self || locked}
                          onClick={() => void send(`/api/users/${u.id}`, { disabled: !u.disabled }, `${u.username} ${u.disabled ? 'enabled' : 'disabled'}`)}
                        >
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon btn-sm btn-danger-ghost"
                          disabled={busy || self || locked}
                          aria-label={`Delete ${u.username}`}
                          title="Delete"
                          onClick={() => setConfirmDelete(u)}
                        >
                          <TrashIcon size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.username ?? ''}?`}
        message="The account is removed and logged out everywhere. This cannot be undone."
        confirmLabel="Delete user"
        onConfirm={() => {
          const u = confirmDelete;
          setConfirmDelete(null);
          if (u) void send(`/api/users/${u.id}/delete`, {}, `Deleted ${u.username}`);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}
