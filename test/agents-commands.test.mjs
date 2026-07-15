// test/agents-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addInstance,
  assertModelValid,
  parseEnvPairs,
  rmInstance,
  setAgentsDir,
  setRepoDefault,
  setSlotOverride,
} from '../lib/agents/index.mjs';

test('parseEnvPairs turns K=V strings into an object', () => {
  assert.deepEqual(parseEnvPairs(['A=1', 'B=x=y']), { A: '1', B: 'x=y' });
});

test('addInstance: a new user instance with use', () => {
  const cfg = { agents: {} };
  addInstance(cfg, 'enterprise-claude', { use: 'claude', env: { CLAUDE_CONFIG_DIR: '/work' } });
  assert.deepEqual(cfg.agents['enterprise-claude'], { use: 'claude', env: { CLAUDE_CONFIG_DIR: '/work' } });
});

test('addInstance: a built-in name + plugin is rejected as a shadow', () => {
  assert.throws(() => addInstance({ agents: {} }, 'claude', { plugin: 'x.mjs' }), /shadow|reserved/i);
});

test('addInstance: a built-in name with no plugin/use is an allowed augment', () => {
  const cfg = { agents: {} };
  addInstance(cfg, 'claude', { mcp: [{ name: 't', command: 'tm' }] });
  assert.ok(cfg.agents.claude.mcp);
});

test('rmInstance: refuses when a dependent uses it', () => {
  const cfg = { agents: { base: { plugin: 'b.mjs' }, leaf: { use: 'base' } } };
  assert.throws(() => rmInstance(cfg, 'base'), /leaf/);
  rmInstance(cfg, 'leaf');
  assert.ok(!cfg.agents.leaf);
});

test('setAgentsDir sets settings.agentsDir', () => {
  const cfg = {};
  setAgentsDir(cfg, '/agents');
  assert.equal(cfg.settings.agentsDir, '/agents');
});

test('assertModelValid: closed model set rejects an unlisted model', () => {
  const cfg = { agents: { my: { plugin: 'm.mjs', models: ['fast', 'smart'] } } };
  assert.throws(() => assertModelValid(cfg, 'my', 'nope'), /fast, smart/);
  assert.doesNotThrow(() => assertModelValid(cfg, 'my', 'fast'));
});

test('assertModelValid: open models (claude) accept anything', () => {
  assert.doesNotThrow(() => assertModelValid({ agents: {} }, 'claude', 'whatever'));
});

test('setRepoDefault / setSlotOverride write the repo entry', () => {
  const cfg = { agents: { my: { plugin: 'm.mjs', models: ['fast'] } }, repos: { '/r': { name: 'r' } } };
  setRepoDefault(cfg, '/r', { agent: 'my', model: 'fast' });
  assert.equal(cfg.repos['/r'].agent, 'my');
  assert.equal(cfg.repos['/r'].model, 'fast');
  setSlotOverride(cfg, '/r', 'b', { agent: 'claude', model: 'sonnet' });
  assert.deepEqual(cfg.repos['/r'].slots.b, { agent: 'claude', model: 'sonnet' });
});
