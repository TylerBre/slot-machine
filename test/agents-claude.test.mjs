// test/agents-claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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

test('deliverySetup: installs both watch hooks idempotently, preserving unrelated settings', () => {
  const desk = mkdtempSync(join(tmpdir(), 'sm-desk-'));
  const settingsFile = join(desk, '.claude', 'settings.json');
  // pre-existing user settings: an unrelated hook + a non-hook key must survive untouched
  const pre = {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-linter' }] }] },
  };
  fs.mkdirSync(join(desk, '.claude'), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(pre));

  const first = claude.deliverySetup({ deskDir: desk, repoDir: '/repo/x' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.installed.sort(), ['Stop', 'UserPromptSubmit']);
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(written.permissions, pre.permissions); // unrelated keys intact
  assert.equal(written.hooks.PostToolUse[0].hooks[0].command, 'my-linter'); // unrelated hook intact
  // repo-pinned: the command carries --repo so a global `sm repo use` can never repoint it
  assert.equal(written.hooks.Stop[0].hooks[0].command, 'sm watch --repo /repo/x --check --ack --hook stop');
  assert.equal(written.hooks.UserPromptSubmit[0].hooks[0].command, 'sm watch --repo /repo/x --check --ack --hook prompt-submit');

  // idempotent: second run installs nothing, changes nothing
  const second = claude.deliverySetup({ deskDir: desk, repoDir: '/repo/x' });
  assert.equal(second.value.changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), written);
});

test('deliverySetup: upgrades a pre-pin (bare) install in place - no duplicates; doctor reports unpinned', () => {
  const desk = mkdtempSync(join(tmpdir(), 'sm-desk-up-'));
  const settingsFile = join(desk, '.claude', 'settings.json');
  fs.mkdirSync(join(desk, '.claude'), { recursive: true });
  // a settings file from the pre-pin build: bare command strings
  writeFileSync(settingsFile, JSON.stringify({
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'sm watch --check --ack --hook stop', timeout: 30 }] }],
      UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'sm watch --check --ack --hook prompt-submit', timeout: 30 }] }],
    },
  }));
  const upgraded = claude.deliverySetup({ deskDir: desk, repoDir: '/repo/y' });
  assert.equal(upgraded.ok, true);
  assert.deepEqual(upgraded.value.upgraded.sort(), ['Stop', 'UserPromptSubmit']);
  assert.deepEqual(upgraded.value.installed, []);
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(written.hooks.Stop.length, 1); // replaced in place, not duplicated
  assert.equal(written.hooks.Stop[0].hooks.length, 1);
  assert.equal(written.hooks.Stop[0].hooks[0].command, 'sm watch --repo /repo/y --check --ack --hook stop');
  assert.equal(claude.deliverySetup({ deskDir: desk }).ok, false); // repoDir now required
});

test('deliverySetup: refuses to rewrite a settings file it cannot parse; needs deskDir', () => {
  const desk = mkdtempSync(join(tmpdir(), 'sm-desk-bad-'));
  fs.mkdirSync(join(desk, '.claude'), { recursive: true });
  writeFileSync(join(desk, '.claude', 'settings.json'), '{ not json');
  const refused = claude.deliverySetup({ deskDir: desk, repoDir: '/repo/x' });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /refusing to rewrite/);
  assert.equal(fs.readFileSync(join(desk, '.claude', 'settings.json'), 'utf8'), '{ not json'); // untouched
  assert.equal(claude.deliverySetup({}).ok, false);
});
