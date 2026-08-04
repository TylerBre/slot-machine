// test/mux-conformance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTINS } from '../lib/mux/index.mjs';
import { callOp, ERR, MUX_OPS, REQUIRED_OPS } from '../lib/mux/contract.mjs';

for (const [name, plugin] of Object.entries(BUILTINS)) {
  test(`mux conformance: ${name} implements every required op`, () => {
    assert.equal(plugin.name, name);
    for (const op of REQUIRED_OPS)
      assert.equal(typeof plugin[op], 'function', `${name} missing required op ${op}`);
  });

  test(`mux conformance: ${name} declares no ops outside the catalog`, () => {
    for (const key of Object.keys(plugin)) {
      if (typeof plugin[key] !== 'function')
        continue;
      assert.ok(key in MUX_OPS || key === 'name', `${name} has undeclared op ${key}`);
    }
  });

  test(`mux conformance: ${name} safe probes return well-formed envelopes`, () => {
    // insideMux is env-only; probe spawns `<mux> -V`-style version checks - both side-effect free.
    const inside = callOp(plugin, 'insideMux', {});
    assert.equal(typeof inside.ok, 'boolean');
    assert.notEqual(inside.err, ERR.UNSUPPORTED);
    const probe = callOp(plugin, 'probe', {});
    assert.equal(typeof probe.ok, 'boolean');
    assert.notEqual(probe.err, ERR.UNSUPPORTED);
    if (probe.ok) {
      assert.equal(probe.value.name, name);
      assert.ok(probe.value.version.length > 0);
    }
  });
}
