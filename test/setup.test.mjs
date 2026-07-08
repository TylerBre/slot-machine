// Setup invariants (read-only - fixLink is exercised via `sm doctor --fix`, not here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BINS, PKG_ROOT, linkStatus } from '../lib/setup.mjs';

test('BINS mirrors package.json bin exactly', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual([...BINS].sort(), Object.keys(pkg.bin).sort());
});

test('linkStatus classifies every bin without throwing', () => {
  for (const name of BINS) {
    const s = linkStatus(name);
    assert.ok(['ok', 'wrong', 'occupied', 'missing'].includes(s.status), `${name}: ${s.status}`);
    assert.ok(s.target.endsWith(`/bin/${name}`));
  }
});
