// test/agents-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dependents, expandHome, resolveEntry, resolveModel } from '../lib/agents/index.mjs';

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
