import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DASHBOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
const { addClip, clipsOf, removeClip } = await import('./clipboard.js');

test('clips are per login, newest first, deduplicated, and expire after a day', () => {
  const t0 = 1_000_000;
  addClip('user:1', 'one', 'iPhone', t0);
  addClip('user:1', 'two', 'Windows', t0 + 1);
  const list = addClip('user:1', 'one', 'Mac', t0 + 2);
  assert.ok(Array.isArray(list));
  assert.deepEqual(clipsOf('user:1', t0 + 3).map((c) => [c.text, c.device]), [['one', 'Mac'], ['two', 'Windows']]);
  assert.deepEqual(clipsOf('user:2', t0 + 3), []);
  assert.deepEqual(clipsOf('user:1', t0 + 2 + 24 * 3_600_000), []);
});

test('refuses empty and oversized text; delete one or all', () => {
  assert.equal(typeof addClip('env:admin', '   ', 'x'), 'string');
  assert.equal(typeof addClip('env:admin', 'a'.repeat(70 * 1024), 'x'), 'string');
  const list = addClip('env:admin', 'keep', 'x<script>') as { id: string; device: string }[];
  assert.equal(list[0]?.device, 'xscript');
  addClip('env:admin', 'drop', 'x');
  const after = removeClip('env:admin', (clipsOf('env:admin')[0] as { id: string }).id);
  assert.deepEqual(after.map((c) => c.text), ['keep']);
  assert.deepEqual(removeClip('env:admin', null), []);
  const file = path.join(process.env.DASHBOARD_DATA_DIR!, 'clipboard.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
