import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The loopback SSH login the terminal and the file explorer share.
 *
 * Both act as the SSH user through this host's own sshd rather than from this
 * process, so they run outside the service's systemd sandbox (ProtectHome,
 * ProtectSystem, PrivateTmp) with exactly the user's own permissions.
 *
 * The key only works from loopback (authorized_keys `from=`), and the host key
 * is pinned from /etc/ssh, with StrictHostKeyChecking=yes.
 *
 * TERMINAL_MODE=local skips SSH: the terminal spawns $SHELL and the file
 * explorer runs `sh -c` directly, both inside the sandbox.
 */

export const MODE = process.env.TERMINAL_MODE === 'local' ? 'local' : 'ssh';
const SSH_HOST = process.env.TERMINAL_SSH_HOST ?? '127.0.0.1';
const SSH_PORT = Number(process.env.TERMINAL_SSH_PORT ?? 22);
export const SSH_USER = process.env.TERMINAL_SSH_USER ?? os.userInfo().username;
export const HOME = process.env.HOME ?? os.homedir();
export const SSH_KEY = process.env.TERMINAL_SSH_KEY ?? `${HOME}/.ssh/dashboard_terminal`;
const HOST_PUBKEY = process.env.TERMINAL_HOST_PUBKEY ?? '/etc/ssh/ssh_host_ed25519_key.pub';
export const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
const KNOWN_HOSTS = path.join(DATA_DIR, 'terminal_known_hosts');
const HOST_ALIAS = 'dashboard-local';

/** POSIX single-quoting, for the command the loopback login runs. */
export function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** known_hosts line pinning this host's ed25519 key under a fixed alias. False when unreadable. */
export function writeKnownHosts(): boolean {
  try {
    const [type, key] = fs.readFileSync(HOST_PUBKEY, 'utf8').trim().split(/\s+/);
    if (!type || !key) return false;
    fs.writeFileSync(KNOWN_HOSTS, `${HOST_ALIAS} ${type} ${key}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** ssh options for the loopback login, without -tt, the destination or a command. */
export function loopbackOptions(): string[] {
  return [
    '-F', '/dev/null',
    '-i', SSH_KEY,
    '-p', String(SSH_PORT),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', `HostKeyAlias=${HOST_ALIAS}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
  ];
}

export const LOOPBACK_DEST = `${SSH_USER}@${SSH_HOST}`;
