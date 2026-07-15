// test/agents-conformance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTINS } from '../lib/agents/index.mjs';
import { callOp, ERR } from '../lib/agents/contract.mjs';

const REQUIRED = ['launch', 'canResume', 'activity', 'lastMessage', 'transcriptAge', 'doctor'];

for (const [name, plugin] of Object.entries(BUILTINS)) {
  test(`conformance: ${name} implements every required op`, () => {
    assert.equal(plugin.name, name);
    for (const op of REQUIRED)
      assert.equal(typeof plugin[op], 'function', `${name} missing op ${op}`);
  });

  test(`conformance: ${name} never returns unsupported for a required drive op`, () => {
    // activity is env-free and safe to call with fixtures; the transcript ops tolerate a missing dir.
    const env = {};
    assert.notEqual(callOp(plugin, 'activity', { capture: '', hasPane: true }).err, ERR.UNSUPPORTED);
    assert.notEqual(callOp(plugin, 'canResume', { dir: '/no/such', env }).err, ERR.UNSUPPORTED);
    assert.notEqual(callOp(plugin, 'launch', { dir: '/w', resume: false, model: null, env }).err, ERR.UNSUPPORTED);
    assert.notEqual(callOp(plugin, 'lastMessage', { dir: '/no/such', env }).err, ERR.UNSUPPORTED);
    assert.notEqual(callOp(plugin, 'transcriptAge', { dir: '/no/such', env }).err, ERR.UNSUPPORTED);
  });
}
