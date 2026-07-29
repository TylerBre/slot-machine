// test/mux-zellij.test.mjs - the zellij backend's pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDefaultTitle, looksLikeShellPrompt, panesFromJson, parseZellijSessions } from '../lib/mux/zellij.mjs';

test('parseZellijSessions: names, exited flag, blank lines', () => {
  const raw = 'acme3 [Created 2s ago] \nold [Created 4h ago] (EXITED - attach to resurrect)\n\n';
  assert.deepEqual(parseZellijSessions(raw), [
    { name: 'acme3', exited: false },
    { name: 'old', exited: true },
  ]);
  assert.deepEqual(parseZellijSessions(''), []);
});

test('isDefaultTitle: zellij default pane titles are not labels', () => {
  assert.equal(isDefaultTitle('Pane #1'), true);
  assert.equal(isDefaultTitle('Pane #12'), true);
  assert.equal(isDefaultTitle('a'), false);
  assert.equal(isDefaultTitle('worker-a'), false);
  assert.equal(isDefaultTitle(''), false);
});

test('looksLikeShellPrompt: prompt tails, TUI chrome, empty panes', () => {
  assert.equal(looksLikeShellPrompt('user@host dir % '), true);
  assert.equal(looksLikeShellPrompt('$ '), true);
  assert.equal(looksLikeShellPrompt('some output\nuser@host dir %'), true);
  assert.equal(looksLikeShellPrompt(''), true); // fresh shell
  assert.equal(looksLikeShellPrompt('building...\n[=====>    ] 52%  eta 3s'), false);
  assert.equal(looksLikeShellPrompt('tokens: 1.2k · esc to interrupt'), false);
});

test('panesFromJson: plugin panes dropped, ids namespaced, defaults stripped', () => {
  const raw = [
    { id: 0, is_plugin: true, title: 'tab-bar', tab_id: 0 },
    {
      id: 0,
      is_plugin: false,
      is_focused: true,
      title: 'Pane #1',
      exited: false,
      tab_id: 0,
      pane_cwd: '/root/docs',
      terminal_command: null,
    },
    {
      id: 2,
      is_plugin: false,
      is_focused: false,
      title: 'a',
      exited: true,
      exit_status: 0,
      tab_id: 1,
      pane_cwd: '/root/acme-slot-a',
      terminal_command: 'claude',
    },
  ];
  const panes = panesFromJson(raw, 'acme3', true);
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[0], {
    id: 'terminal_0',
    session: 'acme3',
    group: '0',
    label: '', // default title stripped - not a slot label
    cwd: '/root/docs',
    command: '',
    focused: true,
    attached: true,
    exited: false,
  });
  assert.deepEqual(panes[1], {
    id: 'terminal_2',
    session: 'acme3',
    group: '1',
    label: 'a',
    cwd: '/root/acme-slot-a',
    command: 'claude',
    focused: false,
    attached: true,
    exited: true,
  });
});
