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
