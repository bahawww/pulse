import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RUNBOOKS, parseRunbooks } from './runbooks.js';

test('the defaults pass their own check', () => {
  assert.deepEqual(parseRunbooks({ runbooks: DEFAULT_RUNBOOKS }), DEFAULT_RUNBOOKS);
});

test('rejects bad ids, empty steps, multi-line commands; trims names and labels', () => {
  assert.equal(typeof parseRunbooks({ runbooks: [{ id: 'A B', name: 'x', steps: [{ command: 'ls' }] }] }), 'string');
  assert.equal(typeof parseRunbooks({ runbooks: [{ id: 'a', name: 'x', steps: [] }] }), 'string');
  assert.equal(typeof parseRunbooks({ runbooks: [{ id: 'a', name: 'x', steps: [{ command: 'ls\nrm -rf /' }] }] }), 'string');
  assert.equal(typeof parseRunbooks({ runbooks: [{ id: 'a', name: 'x', steps: [{ command: 'ls' }] }, { id: 'a', name: 'y', steps: [{ command: 'ls' }] }] }), 'string');
  assert.deepEqual(parseRunbooks({ runbooks: [{ id: 'a', name: ' Check ', steps: [{ label: ' df ', command: ' df -h ' }] }] }), [
    { id: 'a', name: 'Check', steps: [{ label: 'df', command: 'df -h' }] },
  ]);
});
