// test/agents-contract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callOp, ERR, err, ok } from '../lib/agents/contract.mjs';

test('ok/err build the envelope shape', () => {
  assert.deepEqual(ok(5), { ok: true, value: 5 });
  assert.deepEqual(err(ERR.CONFIG, 'bad'), { ok: false, err: 'config', detail: 'bad' });
});

test('callOp passes a valid envelope through', () => {
  const plugin = { name: 'p', canResume: () => ok(true) };
  assert.deepEqual(callOp(plugin, 'canResume', {}), { ok: true, value: true });
});

test('callOp returns unsupported when the op is missing', () => {
  const res = callOp({ name: 'p' }, 'lastMessage', {});
  assert.equal(res.ok, false);
  assert.equal(res.err, ERR.UNSUPPORTED);
});

test('callOp wraps a throwing op as agent-error', () => {
  const plugin = {
    name: 'p',
    activity: () => {
      throw new Error('boom');
    },
  };
  const res = callOp(plugin, 'activity', {});
  assert.equal(res.ok, false);
  assert.equal(res.err, ERR.AGENT_ERROR);
  assert.match(res.detail, /boom/);
});

test('callOp rejects a non-envelope and an unknown err kind as agent-error', () => {
  assert.equal(callOp({ name: 'p', a: () => 42 }, 'a', {}).err, ERR.AGENT_ERROR);
  assert.equal(callOp({ name: 'p', a: () => ({ ok: false, err: 'weird' }) }, 'a', {}).err, ERR.AGENT_ERROR);
});
