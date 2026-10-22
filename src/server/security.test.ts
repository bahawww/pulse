/**
 * Guards that stand between a browser and a root shell. Each case is an input
 * that must be refused; if one starts passing, a hole opened.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';

// Before the modules load: they read and write their key and session files here,
// and HOME keeps terminal.ts away from the real persistent shells (~/.cache/pulse-dtach).
process.env.DASHBOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
process.env.HOME = process.env.DASHBOARD_DATA_DIR;
const { sameOrigin, requirePerm, requireSuperadmin, createSession } = await import('./session.js');
const { csrfToken, csrfValid, wsToken } = await import('./csrf.js');
const { cleanPath, isProtected } = await import('./files.js');
const { parseTarget } = await import('./terminal.js');
const { performProcessAction } = await import('./performance.js');
const { issueToken, consumeToken } = await import('./confirm.js');

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test('sameOrigin refuses cross-site and header-less writes', () => {
  assert.equal(sameOrigin(req({ host: 'pulse.example', origin: 'https://pulse.example', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(sameOrigin(req({ host: 'pulse.example', origin: 'https://evil.example' })), false);
  assert.equal(sameOrigin(req({ host: 'pulse.example', 'sec-fetch-site': 'cross-site', origin: 'https://pulse.example' })), false);
  assert.equal(sameOrigin(req({ host: 'pulse.example' })), false);
  assert.equal(sameOrigin(req({ host: 'pulse.example', origin: 'null' })), false);
});

test('CSRF token is bound to its session', () => {
  const token = csrfToken('a'.repeat(64));
  assert.equal(csrfValid('a'.repeat(64), token), true);
  assert.equal(csrfValid('b'.repeat(64), token), false);
  assert.equal(csrfValid('a'.repeat(64), ''), false);
  assert.equal(csrfValid('a'.repeat(64), undefined), false);
  assert.equal(wsToken(`pulse.v1, pulse.csrf.${token}`), token);
});

test('requirePerm answers 401 without a valid session', () => {
  const run = (sessionHash?: string) => {
    let status = 0;
    let passed = false;
    const res = { locals: { sessionHash }, status: (s: number) => ((status = s), { json: () => undefined }) };
    requirePerm('terminal')(req({}) as never, res as never, () => (passed = true));
    return { status, passed };
  };
  assert.deepEqual(run(), { status: 401, passed: false });
  assert.deepEqual(run('no-such-session'), { status: 401, passed: false });
});

test('file paths: absolute only, and the important folders stay protected', () => {
  assert.equal(cleanPath('relative/x'), null);
  assert.equal(cleanPath('/tmp/\0x'), null);
  assert.equal(cleanPath('/home/x/../../etc/'), '/etc');
  for (const p of ['/', '/etc', '/home', os.homedir(), process.cwd()]) assert.equal(isProtected(p), true, p);
  assert.equal(isProtected(path.join(os.homedir(), 'some-file.txt')), false);
});

test('terminal targets cannot smuggle ssh options', () => {
  const q = (s: string) => parseTarget(new URLSearchParams(s));
  assert.equal(q(''), null);
  assert.equal(typeof q('proto=ssh&host=-oProxyCommand=touch%20/tmp/x'), 'string');
  assert.equal(typeof q('proto=ssh&host=router&user=-oProxyCommand=x'), 'string');
  assert.equal(typeof q('proto=ssh&host=a%20b'), 'string');
  assert.equal(typeof q('proto=ssh&host=router&port=0'), 'string');
  assert.equal(typeof q('proto=rsh&host=router'), 'string');
  assert.deepEqual(q('proto=ssh&host=10.0.0.1&user=admin'), { proto: 'ssh', host: '10.0.0.1', port: 22, user: 'admin', legacy: false });
});

test('process control refuses init, itself and protected names before anything runs', async () => {
  assert.equal((await performProcessAction({ pid: 1, name: 'systemd', signal: 'KILL' }, null)).ok, false);
  assert.equal((await performProcessAction({ pid: process.pid, name: 'node', signal: 'KILL' }, null)).ok, false);
  assert.equal((await performProcessAction({ pid: 3, name: 'x', signal: 'HUP' as never }, null)).ok, false);
});

test('confirm tokens work once, and only for their own key', () => {
  const t = issueToken('action:docker:web:stop');
  assert.equal(consumeToken(t, 'action:docker:web:restart'), false);
  assert.equal(consumeToken(t, 'action:docker:web:stop'), false); // spent by the wrong try
  const u = issueToken('k');
  assert.equal(consumeToken(u, 'k'), true);
  assert.equal(consumeToken(u, 'k'), false);
  assert.equal(consumeToken(null, 'k'), false);
});

test('agent sessions: only the superadmin passes', () => {
  const login = (role: 'admin' | 'superadmin') =>
    createSession({ headers: {}, socket: {} } as never, { id: null, name: role, role, permissions: ['terminal'], breakGlass: false }).hash;
  const run = (sessionHash?: string) => {
    let status = 0;
    let passed = false;
    const res = { locals: { sessionHash }, status: (s: number) => ((status = s), { json: () => undefined }) };
    requireSuperadmin(req({}) as never, res as never, () => (passed = true));
    return { status, passed };
  };
  assert.deepEqual(run(), { status: 401, passed: false });
  assert.deepEqual(run(login('admin')), { status: 403, passed: false });
  assert.deepEqual(run(login('superadmin')), { status: 0, passed: true });
});
