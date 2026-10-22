import { execFile } from 'node:child_process';
import type { ActionRequest, ActionResult } from '../shared/contract.js';
import { consumeToken, issueToken } from './confirm.js';
import { recordAction } from './store.js';

/**
 * Service control actions.
 *
 * This is the only part of the dashboard that changes the machine, so it is
 * built to be boring in the way security-critical code should be:
 *
 *  - No shell. Everything goes through execFile with an argv array, so there is
 *    no string interpolation step where a name could smuggle in a second
 *    command.
 *  - A closed allowlist on both axes. The target kind is one of two literals,
 *    and the action is one of three. Nothing else is reachable, and an unknown
 *    value is rejected rather than coerced.
 *  - A name allowlist. Container names and systemd units are not free text; they
 *    are taken from what the collectors observed. A request naming anything the
 *    server has not seen is refused. This is what stops `POST
 *    /api/action {"name":"../../etc/passwd"}` from being interesting.
 *  - A confirmation token. A mutation returns a token instead of executing, and
 *    the second request must echo it. That turns an accidental double-click (or
 *    a cross-site form post) into something that fails.
 *
 * The allowlist is refreshed from the live system rather than hardcoded, so a
 * container created after boot is still controllable — but only after the server
 * has actually seen it running.
 */

const ACTIONS = new Set(['restart', 'stop', 'start'] as const);

const MAX_OUTPUT = 2000;

/** Valid systemd unit names. Rejects anything with shell or path characters. */
export const UNIT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,127}$/;

/** Docker names: letters, digits and a few separators, no leading punctuation. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * How each dashboard service is really controlled. The dashboard calls them by
 * id ("hermes"), but the unit behind an id has another name and may live in the
 * user manager instead of the system one: the Hermes dashboard runs as hermes-dashboard.service
 * under `systemctl --user`, while 9router and noVNC are system units.
 *
 * System units are allowed by a polkit rule (see vault/access.md); without it a
 * service with no login session is refused with "Interactive authentication
 * required". An id missing here is treated as a system unit of the same name.
 * Only ids in UNIT_SERVICES (shared/contract.ts) reach the allowlist.
 */
interface Control {
  readonly scope: 'system' | 'user';
  readonly unit: string;
}

const CONTROL: Readonly<Record<string, Control>> = {
  // The :9119 card is the web dashboard, its own user unit. The gateway (hermes-gateway.service)
  // is a separate process; restarting it does not bring the dashboard back.
  hermes: { scope: 'user', unit: 'hermes-dashboard.service' },
  opencode: { scope: 'user', unit: 'opencode-web.service' },
  '9router': { scope: 'system', unit: '9router.service' },
  novnc: { scope: 'system', unit: 'novnc.service' },
};

/**
 * Names the server has observed. Populated by the collector; an empty list means
 * "refuse everything", which is the correct behaviour before the first poll.
 */
const knownUnits = new Set<string>();
const knownContainers = new Set<string>();

export function refreshAllowlist(units: readonly string[], containers: readonly string[]): void {
  knownUnits.clear();
  for (const u of units) {
    if (UNIT_NAME.test(u)) knownUnits.add(u);
  }
  knownContainers.clear();
  for (const c of containers) {
    if (CONTAINER_NAME.test(c)) knownContainers.add(c);
  }
}

/** The unit behind a dashboard service id, for read-only lookups (status, logs). Null for an id Pulse has not seen. */
export function controlOf(id: string): Control | null {
  if (!knownUnits.has(id)) return null;
  return CONTROL[id] ?? { scope: 'system', unit: id };
}

/** What Service control can act on, for matching a command the agent suggested: dashboard ids with their units, and containers. */
export function targetsDetailed(): { systemd: { id: string; unit: string; scope: 'system' | 'user' }[]; docker: string[] } {
  return {
    systemd: [...knownUnits].map((id) => {
      const c = CONTROL[id] ?? { scope: 'system' as const, unit: id };
      return { id, unit: c.unit, scope: c.scope };
    }),
    docker: [...knownContainers],
  };
}

function tokenKey(request: ActionRequest): string {
  return `action:${request.target}:${request.name}:${request.action}`;
}

function validate(request: ActionRequest): string | null {
  if (request.target !== 'systemd' && request.target !== 'docker') return 'unsupported target';
  if (!ACTIONS.has(request.action as (typeof ACTIONS extends Set<infer T> ? T : never) & string)) {
    return 'unsupported action';
  }
  if (typeof request.name !== 'string' || request.name.length === 0) return 'missing name';

  if (request.target === 'systemd') {
    if (!UNIT_NAME.test(request.name)) return 'invalid unit name';
    if (!knownUnits.has(request.name)) return 'unit not found on this host';
  } else {
    if (!CONTAINER_NAME.test(request.name)) return 'invalid container name';
    if (!knownContainers.has(request.name)) return 'container not found on this host';
  }
  return null;
}

function run(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 20_000, maxBuffer: MAX_OUTPUT * 4, encoding: 'utf8', env: env ?? process.env },
      (err, stdout, stderr) => {
        // A non-zero exit carries its number. A timeout, a missing binary
        // (ENOENT) or an overflowing output carries no number but still failed:
        // those used to read as exit 0, "succeeded".
        const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1;
        resolve({ stdout: (stdout || stderr || '').slice(0, MAX_OUTPUT), code });
      },
    );
  });
}

/**
 * Two-phase execution.
 *
 * Without `confirm`, the call only validates and returns a token — nothing
 * changes on the machine. With a valid token, the action runs once.
 */
export async function performAction(
  request: ActionRequest,
  confirm: string | null,
): Promise<(ActionResult & { readonly confirmToken?: string }) | null> {
  const invalid = validate(request);
  if (invalid) {
    return {
      ok: false,
      target: request.target,
      name: String(request.name ?? ''),
      action: String(request.action ?? ''),
      message: invalid,
      stdout: '',
      durationMs: 0,
    };
  }

  if (!confirm) {
    return {
      ok: true,
      target: request.target,
      name: request.name,
      action: request.action,
      message: 'confirmation required',
      stdout: '',
      durationMs: 0,
      confirmToken: issueToken(tokenKey(request)),
    };
  }

  // The token is bound to the exact action it was issued for: a token for
  // `start` cannot confirm `restart`, and one for a docker container cannot
  // confirm a systemd unit that happens to share the name.
  if (!consumeToken(confirm, tokenKey(request))) {
    return {
      ok: false,
      target: request.target,
      name: request.name,
      action: request.action,
      message: 'confirmation token expired, unknown or for another action — request again',
      stdout: '',
      durationMs: 0,
    };
  }

  const started = Date.now();
  const command = request.target === 'systemd' ? 'systemctl' : 'docker';
  let args: string[] = [request.action, request.name];
  let env: NodeJS.ProcessEnv | undefined;
  if (request.target === 'systemd') {
    const control = CONTROL[request.name] ?? { scope: 'system', unit: request.name };
    args = [request.action, control.unit];
    if (control.scope === 'user') {
      // A system service has no session bus of its own: point systemctl at the user manager.
      const runtime = `/run/user/${process.getuid?.() ?? 1000}`;
      args = ['--user', ...args];
      env = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
    }
  }

  const { stdout, code } = await run(command, args, env);
  const ok = code === 0;
  const message = ok
    ? `${request.action} ${request.name} succeeded`
    : `${request.action} ${request.name} failed (${code === -1 ? 'timed out or could not run' : `exit ${code}`})`;
  const durationMs = Date.now() - started;

  // Only actions that ran reach the audit log. A refused or expired token changed
  // nothing, so there is nothing to record.
  recordAction({
    ts: Date.now(),
    target: request.target,
    name: request.name,
    action: request.action,
    ok,
    message,
    durationMs,
  });

  return { ok, target: request.target, name: request.name, action: request.action, message, stdout, durationMs };
}

/** Exposed for the UI so it only offers actions that would actually work. */
export function allowedTargets(): { systemd: string[]; docker: string[] } {
  return { systemd: [...knownUnits], docker: [...knownContainers] };
}