import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paneState } from './agentWatch.js';

test('working while the footer says esc to interrupt', () => {
  const pane = '● Bash(npm test)\n  ⎿  Running…\n✻ Blanching… (31s)\n────\n❯ \n────\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt';
  assert.deepEqual(paneState(pane), { state: 'working', ask: null });
});

test('waiting on a permission menu, with the command it is about', () => {
  const pane = [
    '╭──────────────────────────────╮',
    '│ Bash command                 │',
    '│   rm -rf build               │',
    '│   Remove the old build       │',
    '│ Do you want to proceed?      │',
    '│ ❯ 1. Yes                     │',
    "│   2. Yes, and don't ask again │",
    '│   3. No (esc)                │',
    '╰──────────────────────────────╯',
  ].join('\n');
  assert.deepEqual(paneState(pane), { state: 'waiting', ask: 'Bash command · rm -rf build · Remove the old build · Do you want to proceed?' });
});

test('idle at an empty prompt; a question with no menu is not a wait', () => {
  assert.equal(paneState('Done. Tests pass.\n────\n❯ \n────\n  ? for shortcuts').state, 'idle');
  assert.equal(paneState('Do you want to see more?\n❯ ').state, 'idle');
});
