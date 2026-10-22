import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barKeys, decodeSend, defaultBarEntries } from './model';

test('decodeSend: carets, backslash escapes, hex, plain text', () => {
  assert.equal(decodeSend('^C'), '\x03');
  assert.equal(decodeSend('^x^['), '\x18\x1b');
  assert.equal(decodeSend('^?'), '\x7f');
  assert.equal(decodeSend('git status\\r'), 'git status\r');
  assert.equal(decodeSend('\\e[A'), '\x1b[A');
  assert.equal(decodeSend('\\x1b\\\\'), '\x1b\\');
  assert.equal(decodeSend('a\\^b ^'), 'a^b ^');
  assert.equal(decodeSend('2^3'), '2^3');
});

test('the default row is today’s key bar plus Notify, and custom keys decode', () => {
  const ids = defaultBarEntries();
  assert.equal(ids[0], 'ctrl-c');
  assert.equal(ids.at(-1), 'notify');
  assert.ok(ids.includes('paste') && !ids.includes('f1'));
  const [k] = barKeys([{ id: 'x', label: 'gs', send: 'git status\\r' }]);
  assert.deepEqual(k?.act, { raw: 'git status\r' });
  assert.equal(barKeys(['nope', 'ctrl-z']).length, 1);
});
