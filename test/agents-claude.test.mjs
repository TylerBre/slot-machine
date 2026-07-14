// test/agents-claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claude, { transcriptDir } from '../lib/agents/claude.mjs';

test('launch: fresh vs resume, with model and env', () => {
  assert.equal(claude.launch({ dir: '/w', resume: false, model: null, env: {} }).value, 'claude');
  assert.equal(claude.launch({ dir: '/w', resume: true, model: null, env: {} }).value, 'claude -c');
  assert.equal(claude.launch({ dir: '/w', resume: true, model: 'sonnet', env: {} }).value, 'claude -c --model sonnet');
  assert.equal(
    claude.launch({ dir: '/w', resume: true, model: null, env: { CLAUDE_CONFIG_DIR: '/work' } }).value,
    `CLAUDE_CONFIG_DIR='/work' claude -c`,
  );
});

test('activity: matches the legacy paneActivity classification (all branches)', () => {
  assert.equal(claude.activity({ capture: '', hasPane: false }).value, 'no-pane');
  assert.equal(claude.activity({ capture: 'esc to interrupt', hasPane: true }).value, 'working');
  // token-counter footer - the primary steady-state "working" signal (migrated from slots.test.mjs)
  assert.equal(claude.activity({ capture: 'Actioning… (6m · ↓ 24.1k tokens)\n> ', hasPane: true }).value, 'working');
  assert.equal(claude.activity({ capture: 'Do you want to proceed?', hasPane: true }).value, 'waiting');
  assert.equal(claude.activity({ capture: '❯ 1. Yes\n  2. No', hasPane: true }).value, 'waiting');
  assert.equal(claude.activity({ capture: 'ready', hasPane: true }).value, 'idle');
});

test('transcriptDir honors CLAUDE_CONFIG_DIR and slugs the worktree path', () => {
  assert.match(transcriptDir('/Users/me/acme-slot-a', {}), /\/\.claude\/projects\/-Users-me-acme-slot-a$/);
  assert.equal(transcriptDir('/w', { CLAUDE_CONFIG_DIR: '/work' }), '/work/projects/-w');
});

test('canResume / lastMessage / transcriptAge read the env-derived transcript dir', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sm-claude-'));
  const dir = '/some/slot';
  const proj = transcriptDir(dir, { CLAUDE_CONFIG_DIR: base });
  // transcriptDir = <base>/projects/-some-slot ; create it and a transcript.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(proj, { recursive: true });
  assert.equal(claude.canResume({ dir, env: { CLAUDE_CONFIG_DIR: base } }).value, false);
  writeFileSync(join(proj, 's.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })}\n`);
  assert.equal(claude.canResume({ dir, env: { CLAUDE_CONFIG_DIR: base } }).value, true);
  assert.equal(claude.lastMessage({ dir, env: { CLAUDE_CONFIG_DIR: base } }).value, 'hello');
  assert.equal(typeof claude.transcriptAge({ dir, env: { CLAUDE_CONFIG_DIR: base } }).value, 'number');
});
