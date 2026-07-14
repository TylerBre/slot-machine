// test/agents-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  activityOf,
  dependents,
  expandHome,
  inUseInstances,
  launchLine,
  loadRoster,
  mcpServersFor,
  resetRosterForTest,
  resolveEntry,
  resolveModel,
  safeLaunchLine,
} from '../lib/agents/index.mjs';

test('expandHome expands ~ and $HOME', () => {
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('$HOME/y'), join(homedir(), 'y'));
  assert.equal(expandHome('/abs'), '/abs');
});

test('resolveEntry: agent chain slot -> repo -> claude', () => {
  const cfg = { agents: {}, repos: { '/r': { agent: 'claude', slots: { b: { agent: 'claude' } } } } };
  assert.equal(resolveEntry(cfg, '/r', 'b').name, 'claude');
  assert.equal(resolveEntry(cfg, '/r', 'z').name, 'claude'); // falls to repo default
  assert.equal(resolveEntry({ agents: {}, repos: { '/r': {} } }, '/r', 'z').name, 'claude'); // built-in default
});

test('resolveModel: inherit only within the same instance; else restart at defaultModel', () => {
  // repo agent=claude model=sonnet, slot overrides agent -> model does NOT inherit sonnet.
  const cfg = {
    agents: { alt: { use: 'claude', defaultModel: 'alt-default' } },
    repos: { '/r': { agent: 'claude', model: 'sonnet', slots: { b: { agent: 'alt' } } } },
  };
  assert.equal(resolveModel(cfg, '/r', 'b', 'alt'), 'alt-default');
  // same agent as repo -> inherits the repo model.
  assert.equal(resolveModel(cfg, '/r', 'c', 'claude'), 'sonnet');
});

test('dependents: lists instances that `use` a base', () => {
  const cfg = { agents: { base: { plugin: 'b.mjs' }, leaf: { use: 'base' } } };
  assert.deepEqual(dependents(cfg, 'base'), ['leaf']);
  assert.deepEqual(dependents(cfg, 'leaf'), []);
});

test('launchLine builds a claude command for a default slot', async () => {
  resetRosterForTest();
  await loadRoster();
  // With no repo config, a slot resolves to built-in claude; resume depends on whether a
  // transcript dir exists for this bogus path (it will not), so we expect a fresh launch.
  const line = launchLine('/no/such/repo', 'a', '/no/such/repo/x-slot-a');
  assert.match(line, /^claude( --model .+)?$/);
});

test('safeLaunchLine returns null (not throw) when resolution fails', () => {
  resetRosterForTest(); // no roster loaded -> resolveInstance throws -> safeLaunchLine must catch
  assert.equal(safeLaunchLine('/no/such/repo', 'a', '/no/such/repo/x-slot-a'), null);
});

test('activityOf routes through the resolved plugin and unwraps the envelope', async () => {
  resetRosterForTest();
  await loadRoster();
  assert.equal(activityOf('/r', 'a', 'esc to interrupt', true), 'working');
  assert.equal(activityOf('/r', 'a', '', false), 'no-pane');
});

test('activityOf returns "error" (not throw) when the instance cannot be resolved', () => {
  resetRosterForTest(); // no roster loaded -> resolveInstance throws -> activityOf must catch
  assert.equal(activityOf('/r', 'a', 'esc to interrupt', true), 'error');
});

test('inUseInstances: repo default + slot overrides + claude', () => {
  const cfg = { agents: {}, repos: { '/r': { agent: 'enterprise-claude', slots: { b: { agent: 'personal-claude' } } } } };
  const set = inUseInstances(cfg, '/r').sort();
  assert.deepEqual(set, ['claude', 'enterprise-claude', 'personal-claude']);
});

test('mcpServersFor: slot server is present by default and overridable by name', () => {
  const cfg = { agents: { x: { use: 'claude', mcp: [{ name: 'corp', command: 'c' }] } } };
  const list = mcpServersFor(cfg, null, 'x');
  assert.ok(list.find(server => server.name === 'slot'));
  assert.ok(list.find(server => server.name === 'corp'));
  const override = mcpServersFor({ agents: { y: { use: 'claude', mcp: [{ name: 'slot', command: 'mine' }] } } }, null, 'y');
  assert.equal(override.filter(server => server.name === 'slot').length, 1);
  assert.equal(override.find(server => server.name === 'slot').command, 'mine');
});
