// test/elevators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevate } from '../lib/elevators.mjs';

test('elevate: runs the ladder from the raw version up to the target, forwarding extra args', () => {
  const ladder = [
    (value, suffix) => ({ v: 1, name: `${value.name}${suffix}` }), // v0 -> v1
    value => ({ ...value, v: 2, upgraded: true }), // v1 -> v2
  ];
  assert.deepEqual(elevate({ name: 'x' }, ladder, 2, '!'), { v: 2, name: 'x!', upgraded: true });
  assert.deepEqual(elevate({ v: 2, name: 'y' }, ladder, 2), { v: 2, name: 'y' }); // already current
});
