import { type FormEvent, type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import {
  PASSWORD_MIN,
  PERMISSIONS,
  ROLE_RANK,
  roleCeiling,
  type AssignableRole,
  type Permission,
  type Role,
  type UserRow,
} from '../shared/contract';
import { formatDay, formatClock } from '../shared/time';
import { postJson } from '../lib/csrf';
import type { AuthUser } from '../hooks/useAuth';
import { ConfirmDialog } from './ConfirmDialog';
import { SelectMenu } from './SelectMenu';
import { Bone, Loading } from './Skeleton';
import { PencilIcon, RefreshIcon } from './icons';

/**
 * Login accounts and what each one may open or do. Rows live in MySQL
 * (src/server/users.ts); the server applies the same rules shown here:
 *  - the superadmin edits anyone: username, password, role, status, permissions;
 *  - an admin with "Manage users" edits viewers and operators (not their
 *    username or password), and can create them;
 *  - permissions are picked per user, within what the role allows.
 * A saved change logs that account out, so it applies at once.
 */

interface UsersPanelProps {
  readonly me: AuthUser;
  readonly onNotify: (message: string) => void;
}

const ROLE_HINT: Readonly<Record<Role, string>> = {
  viewer: 'can be given views only',
  operator: 'views and service control',
  admin: 'everything, incl. terminal, files and managing viewers/operators',
  superadmin: 'everything; the one account that manages admins',
};

const GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))];

const field =
  'tw:w-full tw:rounded-md tw:border tw:border-line-strong tw:bg-surface-2 tw:px-3 tw:py-1.5 tw:text-[13px] tw:text-fg tw:outline-none tw:disabled:opacity-60';

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `failed (${res.status})`;
}

function when(ts: number | null): string {
  return ts === null ? 'never' : `${formatDay(ts)} ${formatClock(ts, false)}`;
}

/** The editor's working copy. id null = a new user. */
interface Draft {
  readonly id: number | null;
  readonly username: string;
  readonly password: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly permissions: ReadonlySet<Permission>;
}

export function UsersPanel({ me, onNotify }: UsersPanelProps): JSX.Element {
  const [users, setUsers] = useState<readonly UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);

  const isSuper = me.role === 'superadmin';
  /** Roles I may give out. */
  const assignable: readonly AssignableRole[] = isSuper ? ['viewer', 'operator', 'admin'] : ['viewer', 'operator'];

  /** May I change this account's role, status, permissions, or delete it? (Same rule as the server.) */
  const mayManage = useCallback(
    (u: UserRow) => u.id !== me.id && u.role !== 'superadmin' && (isSuper || ROLE_RANK[u.role] < ROLE_RANK.admin),
    [isSuper, me.id],
  );

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

  const edit = (u: UserRow) =>
    setDraft({ id: u.id, username: u.username, password: '', role: u.role, disabled: u.disabled, permissions: new Set(u.permissions) });
  /** What I may hand out; null = anything (the superadmin). Same rule as the server. */
  const mine = useMemo(() => (isSuper ? null : new Set<Permission>(me.permissions)), [isSuper, me.permissions]);
  const create = () =>
    setDraft({ id: null, username: '', password: '', role: 'viewer', disabled: false, permissions: new Set(roleCeiling('viewer').filter((p) => !mine || mine.has(p))) });

  const original = draft?.id != null ? (users?.find((u) => u.id === draft.id) ?? null) : null;

  /** Sends the changes in order: details, username, password. Stops at the first refusal. */
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const perms = PERMISSIONS.map((p) => p.key).filter((k) => draft.permissions.has(k));
      const name = draft.username.trim().toLowerCase();
      if (draft.id === null) {
        const res = await postJson('/api/users', { username: name, password: draft.password, role: draft.role, permissions: perms });
        if (!res.ok) return onNotify(await errorOf(res));
        onNotify(`Added ${name}`);
      } else if (original) {
        if (mayManage(original)) {
          const changed = draft.role !== original.role || draft.disabled !== original.disabled || perms.join() !== original.permissions.join();
          if (changed) {
            const body: { role?: Role; disabled: boolean; permissions: Permission[] } = { disabled: draft.disabled, permissions: perms };
            if (draft.role !== original.role) body.role = draft.role;
            const res = await postJson(`/api/users/${original.id}`, body);
            if (!res.ok) return onNotify(await errorOf(res));
          }
        }
        if (isSuper && name !== original.username) {
          const res = await postJson(`/api/users/${original.id}/username`, { username: name });
          if (!res.ok) return onNotify(await errorOf(res));
        }
        if (isSuper && draft.password) {
          const res = await postJson(`/api/users/${original.id}/password`, { password: draft.password });
          if (!res.ok) return onNotify(await errorOf(res));
        }
        onNotify(`Saved ${name}${original.id === me.id ? '' : ' · they were logged out to apply it'}`);
      }
      setDraft(null);
      await load();
    } catch {
      onNotify('server unreachable');
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: UserRow) {
    setBusy(true);
    try {
      const res = await postJson(`/api/users/${u.id}/delete`, {});
      onNotify(res.ok ? `Deleted ${u.username}` : await errorOf(res));
      if (res.ok) {
        setDraft(null);
        await load();
      }
    } catch {
      onNotify('server unreachable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="users-h">
      <div className="card-head">
        <div>
          <h3 id="users-h" className="card-title">
            Users
          </h3>
          <p className="card-sub">who can log in, and what each one may see and do</p>
        </div>
        <span className="tw:flex tw:gap-2">
          <button type="button" className="btn btn-icon btn-sm" onClick={() => void load()} aria-label="Refresh" title="Refresh">
            <RefreshIcon size={14} />
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={create} disabled={busy}>
            Add user
          </button>
        </span>
      </div>

      {error && <p className="result is-error">{error}</p>}
      {!users && !error && (
        <Loading what="users">
          <Bone h={28} />
          <Bone h={28} />
        </Loading>
      )}

      {users && (
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th className="tw:max-sm:hidden">Access</th>
              <th className="tw:max-md:hidden">Last login</th>
              <th aria-label="Edit" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === me.id;
              const editable = mayManage(u) || isSuper;
              return (
                <tr key={u.id} className={draft?.id === u.id ? 'tw:bg-surface-2' : undefined}>
                  <td>
                    {u.username}
                    {self && <span className="muted"> (you)</span>}
                    {u.disabled && <span className="pill is-crit tw:ml-2">disabled</span>}
                  </td>
                  <td>
                    <span className={`pill${u.role === 'superadmin' ? ' is-warn' : ''}`} title={ROLE_HINT[u.role]}>
                      {u.role}
                    </span>
                  </td>
                  <td className="muted tw:max-sm:hidden">
                    {u.role === 'superadmin'
                      ? 'everything'
                      : `${u.permissions.length} of ${roleCeiling(u.role).length}${u.customized ? ' · custom' : ' · role default'}`}
                  </td>
                  <td className="muted tw:max-md:hidden">{when(u.lastLoginAt)}</td>
                  <td>
                    <span className="tw:flex tw:justify-end">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy || !editable}
                        title={editable ? 'Edit' : self ? 'Change your own password from the profile menu' : 'Only the superadmin can edit this account'}
                        onClick={() => edit(u)}
                      >
                        <PencilIcon size={13} />
                        Edit
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {draft && (
        <Editor
          draft={draft}
          original={original}
          isSuper={isSuper}
          mine={mine}
          passwordMin={!isSuper || (draft.id !== null && draft.id === me.id) ? PASSWORD_MIN : undefined}
          canManage={draft.id === null || (original !== null && mayManage(original))}
          assignable={assignable}
          busy={busy}
          onChange={setDraft}
          onSave={(e) => void save(e)}
          onCancel={() => setDraft(null)}
          onDelete={original && mayManage(original) ? () => setConfirmDelete(original) : undefined}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.username ?? ''}?`}
        message="The account is removed and logged out everywhere. This cannot be undone."
        confirmLabel="Delete user"
        onConfirm={() => {
          const u = confirmDelete;
          setConfirmDelete(null);
          if (u) void remove(u);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}

interface EditorProps {
  readonly draft: Draft;
  readonly original: UserRow | null;
  readonly isSuper: boolean;
  /** The permissions I may grant or take away; null = all of them. Others stay as they are. */
  readonly mine: ReadonlySet<Permission> | null;
  /** Length rule for the password typed here; undefined when the superadmin sets someone else's (free). */
  readonly passwordMin: number | undefined;
  /** Role, status and permissions can be changed (or this is a new user). */
  readonly canManage: boolean;
  readonly assignable: readonly AssignableRole[];
  readonly busy: boolean;
  readonly onChange: (d: Draft) => void;
  readonly onSave: (e: FormEvent) => void;
  readonly onCancel: () => void;
  readonly onDelete?: () => void;
}

function Editor({ draft, original, isSuper, mine, passwordMin, canManage, assignable, busy, onChange, onSave, onCancel, onDelete }: EditorProps): JSX.Element {
  const creating = draft.id === null;
  const ceiling = useMemo(() => new Set<Permission>(roleCeiling(draft.role)), [draft.role]);
  const held = (p: Permission) => !mine || mine.has(p);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const toggle = (p: Permission) => {
    const next = new Set(draft.permissions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    set({ permissions: next });
  };
  /** `pick` for what I hold; the rest keeps its current state (the server does the same). */
  const choose = (role: Role, pick: (p: Permission) => boolean) =>
    new Set(roleCeiling(role).filter((p) => (held(p) ? pick(p) : draft.permissions.has(p))));
  // A new role starts from its defaults, like the server does.
  const changeRole = (role: Role) => set({ role, permissions: choose(role, () => true) });
  const lockedPerms = !canManage || draft.role === 'superadmin';
  const granted = [...draft.permissions].filter((p) => ceiling.has(p)).length;

  return (
    <form onSubmit={onSave} className="tw:mt-4 tw:rounded-lg tw:border tw:border-line tw:p-4" aria-label={creating ? 'New user' : `Edit ${original?.username ?? ''}`}>
      <h4 className="tw:mb-3 tw:text-[14px] tw:font-semibold tw:text-fg">{creating ? 'New user' : `Edit ${original?.username}`}</h4>

      <div className="tw:grid tw:gap-3 tw:sm:grid-cols-2 tw:lg:grid-cols-4">
        <label className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          Username
          <input
            className={field}
            value={draft.username}
            onChange={(e) => set({ username: e.currentTarget.value })}
            required
            minLength={2}
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]+"
            autoComplete="off"
            spellCheck={false}
            disabled={!creating && !isSuper}
            title={!creating && !isSuper ? 'Only the superadmin can change usernames' : undefined}
          />
        </label>
        <label className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          {creating ? 'Password' : 'New password'}
          <input
            className={field}
            type="password"
            value={draft.password}
            onChange={(e) => set({ password: e.currentTarget.value })}
            required={creating}
            minLength={passwordMin}
            autoComplete="new-password"
            placeholder={creating ? (passwordMin ? `min ${passwordMin} characters` : '') : isSuper ? 'leave blank to keep' : 'superadmin only'}
            disabled={!creating && !isSuper}
          />
        </label>
        <div className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          <span aria-hidden="true">Role</span>
          {draft.role === 'superadmin' || !canManage ? (
            <span className={`pill${draft.role === 'superadmin' ? ' is-warn' : ''}`} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
              {draft.role}
            </span>
          ) : (
            <SelectMenu label="Role" value={draft.role} options={assignable.map((r) => ({ value: r, label: r }))} onChange={(v) => changeRole(v as Role)} />
          )}
          <span className="tw:text-[11px]">{ROLE_HINT[draft.role]}</span>
        </div>
        <div className="tw:flex tw:flex-col tw:gap-1 tw:text-[12px] tw:text-fg-3">
          <span aria-hidden="true">Status</span>
          <label className="tw:flex tw:items-center tw:gap-2 tw:text-[13px] tw:text-fg">
            <input type="checkbox" checked={!draft.disabled} disabled={!canManage || draft.role === 'superadmin'} onChange={(e) => set({ disabled: !e.currentTarget.checked })} />
            Can log in
          </label>
        </div>
      </div>

      <fieldset className="tw:m-0 tw:mt-4 tw:min-w-0 tw:border-0 tw:border-t tw:border-line tw:p-0 tw:pt-3" disabled={lockedPerms}>
        <legend className="tw:float-left tw:mb-3 tw:flex tw:w-full tw:items-center tw:justify-between tw:gap-2 tw:p-0 tw:text-[12px] tw:text-fg-3">
          <span>
            Access{' '}
            {draft.role === 'superadmin' ? '(the superadmin always has everything)' : `· ${granted} of ${ceiling.size} allowed by the ${draft.role} role`}
          </span>
          {!lockedPerms && (
            <span className="tw:flex tw:gap-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ permissions: choose(draft.role, () => true) })}>
                All
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ permissions: choose(draft.role, () => false) })}>
                None
              </button>
            </span>
          )}
        </legend>
        <div className="tw:clear-both tw:grid tw:gap-4 tw:md:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g} className="tw:flex tw:flex-col tw:gap-1.5">
            <span className="tw:text-[12px] tw:font-semibold tw:text-fg-2">{g}</span>
            {PERMISSIONS.filter((p) => p.group === g).map((p) => {
              const allowed = ceiling.has(p.key);
              const mayChange = allowed && held(p.key);
              return (
                <label
                  key={p.key}
                  className={`tw:flex tw:items-center tw:gap-2 tw:text-[13px] ${mayChange ? 'tw:text-fg' : 'tw:text-fg-3'}`}
                  title={!allowed ? `Needs the ${p.min} role` : mayChange ? p.key : 'You do not have this permission, so you cannot give or take it'}
                >
                  <input type="checkbox" checked={allowed && draft.permissions.has(p.key)} disabled={!mayChange} onChange={() => toggle(p.key)} />
                  {p.label}
                  {!allowed && <span className="tw:text-[11px]">· {p.min}+</span>}
                </label>
              );
            })}
          </div>
        ))}
        </div>
      </fieldset>

      <div className="tw:mt-4 tw:flex tw:flex-wrap tw:items-center tw:gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {creating ? 'Create user' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="tw:flex-1" />
        {onDelete && (
          <button type="button" className="btn btn-sm btn-danger-ghost" onClick={onDelete} disabled={busy}>
            Delete user
          </button>
        )}
      </div>
    </form>
  );
}
