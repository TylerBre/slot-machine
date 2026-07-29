// test/mux-tmux.test.mjs - the tmux backend's pure output parsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupLines, parsePaneLines, parseSessionLines } from '../lib/mux/tmux.mjs';

test('parsePaneLines: full records, label fallback, flags', () => {
  const raw = [
    '%1\tacme3\t@2\ta\t/root/acme-slot-a\tnode\t1\t1',
    '%2\tacme3\t@2\t\t/root/acme-slot-b\tzsh\t0\t1',
    '', // blank lines skipped
  ].join('\n');
  const panes = parsePaneLines(raw);
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[0], {
    id: '%1',
    session: 'acme3',
    group: '@2',
    label: 'a',
    cwd: '/root/acme-slot-a',
    command: 'node',
    focused: true,
    attached: true,
    exited: false,
  });
  assert.equal(panes[1].label, ''); // pre-label pane: empty, caller falls back to cwd
  assert.equal(panes[1].focused, false);
});

test('parsePaneLines: empty and null input yield no panes', () => {
  assert.deepEqual(parsePaneLines(''), []);
  assert.deepEqual(parsePaneLines(null), []);
});

test('parseSessionLines: numbers and flags coerced', () => {
  const rows = parseSessionLines('acme3\t1752580000\t4\t1\nother\t1752570000\t2\t0\n');
  assert.deepEqual(rows[0], { name: 'acme3', lastActivity: 1752580000, groups: 4, attached: true });
  assert.deepEqual(rows[1], { name: 'other', lastActivity: 1752570000, groups: 2, attached: false });
});

test('parseGroupLines: pane counts coerced, blank lines skipped', () => {
  const rows = parseGroupLines('@1\tdesk\t1\n@2\tslot-a,b,c\t3\n\n');
  assert.deepEqual(rows, [
    { id: '@1', label: 'desk', paneCount: 1 },
    { id: '@2', label: 'slot-a,b,c', paneCount: 3 },
  ]);
});
