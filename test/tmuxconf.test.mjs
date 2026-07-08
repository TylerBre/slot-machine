// Tests for the tmux.conf block upsert (pure logic only - no fs writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TMUX_BLOCK, upsertBlock } from '../lib/tmuxconf.mjs';

test('upsertBlock: appends to an empty conf', () => {
  assert.equal(upsertBlock(''), `${TMUX_BLOCK}\n`);
});

test('upsertBlock: appends after existing content with a blank line', () => {
  const out = upsertBlock('set -g mouse on\n');
  assert.equal(out, `set -g mouse on\n\n${TMUX_BLOCK}\n`);
});

test('upsertBlock: idempotent - second run changes nothing', () => {
  const once = upsertBlock('set -g mouse on\n');
  assert.equal(upsertBlock(once), once);
});

test('upsertBlock: replaces a drifted block in place, keeping surroundings', () => {
  const drifted
    = 'before\n\n# >>> slot-machine >>>\nset -g pane-border-status off\n# <<< slot-machine <<<\n\nafter\n';
  const out = upsertBlock(drifted);
  assert.ok(out.startsWith('before\n'));
  assert.ok(out.includes(TMUX_BLOCK));
  assert.ok(out.includes('\nafter\n'));
  assert.ok(!out.includes('pane-border-status off'));
});
