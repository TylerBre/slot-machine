import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prCell } from '../lib/format.mjs';

test('prCell: each PR shows its state, so merged is visible (not a bare number)', () => {
  assert.equal(prCell([]), '-');
  assert.equal(prCell([{ number: 4487, state: 'MERGED' }]), '#4487 merged');
  assert.equal(prCell([{ number: 4480, state: 'OPEN' }]), '#4480 open');
  assert.equal(prCell([{ number: 4490, state: 'CLOSED' }]), '#4490 closed');
  // multiple PRs on one branch stay one cell, comma-separated
  assert.equal(
    prCell([{ number: 10, state: 'MERGED' }, { number: 11, state: 'OPEN' }]),
    '#10 merged, #11 open',
  );
  // missing state does not crash the renderer
  assert.equal(prCell([{ number: 12 }]), '#12 ?');
});
