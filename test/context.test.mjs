// test/context.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevateConfig, saveConfig } from '../lib/context.mjs';
import { loadSchema, validate } from '../lib/schema.mjs';

test('elevateConfig: a legacy config (no v) elevates and validates', () => {
  const schema = loadSchema('config.schema.json');
  const up = elevateConfig({ current: '/x', repos: { '/x': { name: 'x', root: '/', prefix: 'x-slot-', sessionPrefix: 'x', baseBranch: 'main' } } });
  assert.equal(up.v, 2);
  assert.deepEqual(validate(up, schema), []);
});

test('elevateConfig: an empty/missing config elevates to a valid empty config', () => {
  const schema = loadSchema('config.schema.json');
  const up = elevateConfig({});
  assert.deepEqual(up, { v: 2, current: null, repos: {}, settings: {}, agents: {} });
  assert.deepEqual(validate(up, schema), []);
});

test('saveConfig: throws on an invalid config before writing', () => {
  assert.throws(() => saveConfig({ current: null, repos: { '/x': { name: 'x' } } }), /invalid/i);
});
