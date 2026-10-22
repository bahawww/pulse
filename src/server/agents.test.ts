import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_NAME, agentKindOf, findLink, nextName, trustKeys } from './agents.js';

test('agentKindOf reads the prefix', () => {
  assert.equal(agentKindOf('agy-1915'), 'agy');
  assert.equal(agentKindOf('cc-1915-2'), 'claude');
  assert.equal(agentKindOf('main'), null);
  assert.equal(AGENT_NAME.test('agy-1915'), true);
  assert.equal(AGENT_NAME.test("agy-x';rm"), false);
});
test('nextName uses HHMM, then -2, -3', () => {
  const at = new Date(2026, 9, 22, 19, 5);
  assert.equal(nextName('agy', [], at), 'agy-1905');
  assert.equal(nextName('claude', ['cc-1905'], at), 'cc-1905-2');
  assert.equal(nextName('claude', ['cc-1905', 'cc-1905-2'], at), 'cc-1905-3');
});
test('trustKeys: agy Enter, claude Down+Enter, nothing without a prompt', () => {
  assert.deepEqual(trustKeys('agy', 'Do you trust the contents of this project?\n> Yes, I trust this folder'), ['Enter']);
  assert.deepEqual(trustKeys('claude', '❯ No, exit\n  Yes, I trust this folder'), ['Down', 'Enter']);
  assert.equal(trustKeys('agy', '? for shortcuts'), null);
  assert.equal(trustKeys('claude', '❯ Try "write a test"'), null);
});
test('findLink: newest link from pane or log', () => {
  const pane = 'Open https://antigravity.google.com/r/64bac457-ac56-4b8c-9675-ef090a5f0704-v2 on another device';
  assert.equal(findLink('agy', pane), 'https://antigravity.google.com/r/64bac457-ac56-4b8c-9675-ef090a5f0704-v2');
  const log = '[remote-control-aaaa-v2] Starting\n[remote-control-bbbb-v2] Starting';
  assert.equal(findLink('agy', log), 'https://antigravity.google.com/r/bbbb-v2');
  assert.equal(findLink('claude', 'on your phone, or at\n  https://claude.ai/code/session_01Qgg7XvdzRkNvAGYm8AHLLL  '), 'https://claude.ai/code/session_01Qgg7XvdzRkNvAGYm8AHLLL');
  assert.equal(findLink('claude', 'nothing yet'), null);
});

import { listAgents, startAgent, stopAgent, type AgentDeps } from './agents.js';
import { renameRefused } from './tmux.js';
import type { RunResult } from './files.js';

const res = (stdout = '', code = 0, stderr = ''): RunResult => ({ code, stdout: Buffer.from(stdout), stderr });
/** Scripted deps: first reply that answers wins; default is empty success. Sleep moves a fake clock. */
function fakeDeps(replies: Array<(cmd: string) => RunResult | undefined>) {
  let clock = 0;
  const cmds: string[] = [];
  const deps: AgentDeps = {
    run: async (cmd) => {
      cmds.push(cmd);
      for (const f of replies) {
        const r = f(cmd);
        if (r) return r;
      }
      return res();
    },
    sleep: async (ms) => void (clock += ms),
    now: () => new Date(2026, 9, 22, 19, 5, 0, clock),
    timeoutMs: 18_000,
  };
  return { deps, cmds, clock: () => clock };
}
const row = (n: string) => `${n}\t1000\t2000\t\n`;
const listing = (...n: string[]) => (c: string) => (c.includes('list-sessions') ? res(n.map(row).join('')) : undefined);

test('claude start answers the trust screen once and stores the link', async () => {
  let polls = 0;
  const f = fakeDeps([
    (c) => {
      if (!c.includes('capture-pane')) return undefined;
      polls++;
      if (polls === 1) return res('Yes, I trust this folder\nNo, exit');
      return res(polls < 4 ? 'loading' : 'open https://claude.ai/code/session_X1');
    },
  ]);
  const r = await startAgent('claude', f.deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.session?.link, 'https://claude.ai/code/session_X1');
  const keys = f.cmds.filter((c) => c.includes('send-keys'));
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /Down Enter/);
  assert.equal(f.cmds.filter((c) => c.includes('set-option') && c.includes('@agent_link')).length, 1);
});
test('agy start never sends keys without a trust prompt, and gives up with link null', async () => {
  const f = fakeDeps([]);
  const r = await startAgent('agy', f.deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.session?.link, null);
  assert.ok(f.clock() >= 18_000);
  assert.ok(!f.cmds.some((c) => c.includes('send-keys')));
});
test('fourth agy start is refused', async () => {
  const f = fakeDeps([listing('agy-1', 'agy-2', 'agy-3')]);
  const r = await startAgent('agy', f.deps);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: '3 running: stop one first' });
  assert.ok(!f.cmds.some((c) => c.includes('new-session')));
});
test('missing tmux answers 503', async () => {
  const f = fakeDeps([() => res('', -1, 'tmux is not installed')]);
  const r = await startAgent('agy', f.deps);
  assert.equal(r.status, 503);
  assert.match(r.body.error ?? '', /tmux is not installed/);
});
test('stop validates the name and maps a failed kill to 404', async () => {
  const f = fakeDeps([() => res('', 1, "can't find session")]);
  assert.equal((await stopAgent('main', f.deps)).status, 400);
  assert.equal(f.cmds.length, 0);
  assert.equal((await stopAgent('agy-1905', f.deps)).status, 404);
});
test('list keeps agent rows only and removes stale logs', async () => {
  const f = fakeDeps([listing('agy-1905', 'main')]);
  const r = await listAgents(f.deps);
  assert.ok(Array.isArray(r));
  assert.deepEqual((r as { name: string }[]).map((s) => s.name), ['agy-1905']);
  const cleanup = f.cmds.find((c) => c.includes('rm -f'))!;
  assert.match(cleanup, /\*\.log/);
  assert.match(cleanup, /'agy-1905'\)/);
  assert.ok(!cleanup.includes('main'));
});
test('rename guard covers both ends', () => {
  assert.equal(renameRefused('agy-1905', 'x'), true);
  assert.equal(renameRefused('main', 'cc-1'), true);
  assert.equal(renameRefused('main', 'x'), false);
});
test('list cleans stale logs even with no agy session live', async () => {
  const f = fakeDeps([listing('main', 'cc-1905')]);
  await listAgents(f.deps);
  const cleanup = f.cmds.find((c) => c.includes('rm -f'))!;
  assert.ok(!cleanup.startsWith(';'));
  assert.match(cleanup, /^for f in /);
});
