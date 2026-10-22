import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScanner } from './termNotify.js';

test('a lone bell is a bell; a title ending in BEL is not', () => {
  const scan = createScanner();
  assert.deepEqual(scan('plain output\n'), []);
  assert.deepEqual(scan('\x1b]0;bahar@vps: ~\x07bahar@vps:~$ '), []);
  assert.deepEqual(
    scan('done\x07'),
    [{ kind: 'bell', title: '', body: '' }],
  );
});

test('OSC 777 notify gives title and body, with BEL or ST, split across chunks', () => {
  const scan = createScanner();
  assert.deepEqual(scan("\x1b]777;notify;Done;exit 0\x07"), [{ kind: 'notify', title: 'Done', body: 'exit 0' }]);
  assert.deepEqual(scan('\x1b]777;noti'), []);
  assert.deepEqual(scan('fy;Build;failed\x1b'), []);
  assert.deepEqual(scan('\\'), [{ kind: 'notify', title: 'Build', body: 'failed' }]);
});

test('OSC 9 text notifies; progress and ConEmu codes do not', () => {
  const scan = createScanner();
  assert.deepEqual(scan('\x1b]9;Claude needs your input\x07'), [{ kind: 'notify', title: '', body: 'Claude needs your input' }]);
  assert.deepEqual(scan('\x1b]9;4;1;50\x07'), []);
  assert.deepEqual(scan('\x1b]9;1;500\x07'), []);
});

test('BEL inside a DCS string or a long OSC is not a bell; control characters are cleaned', () => {
  const scan = createScanner();
  assert.deepEqual(scan('\x1bPtmux;\x07\x1b\\'), []);
  assert.deepEqual(scan(`\x1b]52;c;${'A'.repeat(5000)}\x07`), []);
  assert.deepEqual(scan('\x1b]777;notify;a\tb;x\x01y\x07'), [{ kind: 'notify', title: 'a b', body: 'x y' }]);
});
