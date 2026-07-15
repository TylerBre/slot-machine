// test/agents-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevateConfig, stampConfig } from '../lib/context.mjs';
import { loadSchema, validate } from '../lib/schema.mjs';

test('config v2: a full roster + settings + repo overrides validates', () => {
  const schema = loadSchema('config.schema.json');
  const cfg = {
    v: 2,
    current: '/x',
    settings: { agentsDir: '/agents' },
    agents: {
      'enterprise-claude': { use: 'claude', env: { CLAUDE_CONFIG_DIR: '/work' }, mcp: [{ name: 'corp', transport: 'stdio', command: 'corp-mcp' }] },
      'claude': { mcp: [{ name: 'my-tool', transport: 'stdio', command: 'my-tool-mcp' }] },
      'my-agent': { plugin: 'my-agent.mjs', models: ['fast', 'smart'], defaultModel: 'smart' },
      'my-agent-scratch': { use: 'my-agent', env: { MYAGENT_PROFILE: 'scratch' } },
    },
    repos: {
      '/x': { name: 'x', root: '/', prefix: 'x-slot-', sessionPrefix: 'x', baseBranch: 'main', agent: 'enterprise-claude', model: 'sonnet', slots: { b: { agent: 'claude', model: 'haiku' } } },
    },
  };
  assert.deepEqual(validate(cfg, schema), []);
});

test('config v2: an unknown top-level key is rejected', () => {
  const schema = loadSchema('config.schema.json');
  const problems = validate({ v: 2, current: null, repos: {}, bogus: 1 }, schema);
  assert.ok(problems.some(problem => /unexpected key 'bogus'/.test(problem)), problems.join('; '));
});

test('config v2: a minimal config (no settings/agents) still validates', () => {
  const schema = loadSchema('config.schema.json');
  assert.deepEqual(validate({ v: 2, current: null, repos: {} }, schema), []);
});

test('elevateConfig: v1 -> v2 adds empty settings + agents, preserves repos', () => {
  const schema = loadSchema('config.schema.json');
  const up = elevateConfig({ v: 1, current: '/x', repos: { '/x': { name: 'x', root: '/', prefix: 'x-slot-', sessionPrefix: 'x', baseBranch: 'main' } } });
  assert.equal(up.v, 2);
  assert.deepEqual(up.settings, {});
  assert.deepEqual(up.agents, {});
  assert.equal(up.repos['/x'].name, 'x');
  assert.deepEqual(validate(up, schema), []);
});

test('elevateConfig: empty config elevates to a valid empty v2', () => {
  const up = elevateConfig({});
  assert.deepEqual(up, { v: 2, current: null, repos: {}, settings: {}, agents: {} });
});

test('stampConfig: keeps settings and agents (not just v/current/repos)', () => {
  const stamped = stampConfig({
    current: null,
    repos: {},
    settings: { agentsDir: '/agents' },
    agents: { foo: { use: 'claude' } },
  });
  assert.equal(stamped.v, 2);
  assert.deepEqual(stamped.settings, { agentsDir: '/agents' });
  assert.deepEqual(stamped.agents, { foo: { use: 'claude' } });
  // The OLD stamping ({v,current,repos} only) would drop both keys - this is the red->green.
});
