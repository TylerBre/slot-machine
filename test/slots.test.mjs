// Tests for sm. Run: node --test  (or npm test)
// Pure-logic tests always run; tmux integration tests run only when tmux and a
// configured repo (`sm use`) with real slot worktrees are present, otherwise they skip.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveSlots,
  selectPanes,
  classifySlot,
  lockStale,
  pickDispatchSlot,
  paneActivity,
  detectRole,
  preflightStatus,
  activeOverride,
  readLock,
  writeLock,
  removeLock,
} from '../lib/slots.mjs';
import { resolveActive } from '../lib/context.mjs';
import { formatSessions } from '../lib/format.mjs';
import { appendReport, readInbox, clearInbox, waitForReports } from '../lib/inbox.mjs';
import { recordUsage, readUsage, summarizeUsage } from '../lib/usage.mjs';
import { claimResource, releaseResource, readResourceLock, listResourceLocks } from '../lib/locks.mjs';

const LABELS = ['a', 'b', 'c', 'd', 'e', 'f']; // 6 slots for parser tests
const set = (...xs) => new Set(xs);

test('resolveSlots: single number and letter', () => {
  assert.deepEqual(resolveSlots('1', LABELS), set('a'));
  assert.deepEqual(resolveSlots('c', LABELS), set('c'));
});

test('resolveSlots: numeric list + range', () => {
  assert.deepEqual(resolveSlots('1,3,5-6', LABELS), set('a', 'c', 'e', 'f'));
});

test('resolveSlots: alpha list + range', () => {
  assert.deepEqual(resolveSlots('a-b,d-f', LABELS), set('a', 'b', 'd', 'e', 'f'));
});

test('resolveSlots: mixed kinds across tokens', () => {
  assert.deepEqual(resolveSlots('1,c,e-f', LABELS), set('a', 'c', 'e', 'f'));
});

test('resolveSlots: spaces and commas both separate', () => {
  assert.deepEqual(resolveSlots('1, 3 , c', LABELS), set('a', 'c'));
});

test('resolveSlots: single-element range and full range', () => {
  assert.deepEqual(resolveSlots('3-3', LABELS), set('c'));
  assert.deepEqual(resolveSlots('1-6', LABELS), set(...LABELS));
});

test('resolveSlots: dedupes overlaps', () => {
  assert.deepEqual(resolveSlots('1,a,1-2,b', LABELS), set('a', 'b'));
});

test('resolveSlots: rejects bad input', () => {
  for (const bad of ['99', '0', 'z', 'a-3', '3-a', '6-5', 'f-d', '@', 'aa', '1.5', '-']) {
    assert.throws(() => resolveSlots(bad, LABELS), Error, `expected throw for '${bad}'`);
  }
});

test('selectPanes: no filter picks all slot panes, skips desk/non-slot', () => {
  const docs = '/home/u/Documents';
  const lines = [
    `%0 ${docs}`, // desk
    `%1 ${docs}/acme-slot-a`,
    `%2 ${docs}/acme-slot-b`,
    `%3 /somewhere/else`, // unrelated pane
    ``, // trailing blank
  ];
  assert.deepEqual(selectPanes(lines, docs, 'acme-slot-', null), [
    { pid: '%1', lbl: 'a' },
    { pid: '%2', lbl: 'b' },
  ]);
});

test('selectPanes: filters to wanted labels, preserves order', () => {
  const docs = '/home/u/Documents';
  const lines = ['a', 'b', 'c'].map((l, i) => `%${i} ${docs}/acme-slot-${l}`);
  assert.deepEqual(selectPanes(lines, docs, 'acme-slot-', set('a', 'c')), [
    { pid: '%0', lbl: 'a' },
    { pid: '%2', lbl: 'c' },
  ]);
});

test('selectPanes: rejects a nested path under a slot dir', () => {
  const docs = '/home/u/Documents';
  assert.deepEqual(selectPanes([`%1 ${docs}/acme-slot-a/sub`], docs, 'acme-slot-', null), []);
});

test('formatSessions: pluralizes, pads, flags attached', () => {
  const out = formatSessions([
    { name: 'acme2', windows: 3, slots: 6, attached: false },
    { name: 'acme10', windows: 4, slots: 1, attached: true },
  ]);
  assert.match(out, /acme2 .* 3 win, 6 slots$/m);
  assert.match(out, /acme10 {2}4 win, 1 slot, attached$/m);
});

test('formatSessions: empty names the session prefix when given', () => {
  assert.equal(formatSessions([]), 'no running sessions');
  assert.equal(formatSessions([], 'acme'), 'no running acme* sessions');
});

test('classifySlot: idle base branch is free', () => {
  assert.equal(
    classifySlot({
      branch: 'acme-slot-j',
      baseBranch: 'acme-slot-j',
      locked: false,
      dirty: false,
      ahead: 0,
      prs: [],
    }).free,
    true,
  );
});

test('classifySlot: lock and dirty short-circuit to busy', () => {
  assert.equal(
    classifySlot({
      branch: 'acme-slot-j',
      baseBranch: 'acme-slot-j',
      locked: true,
      dirty: false,
      ahead: 0,
      prs: [],
    }).free,
    false,
  );
  assert.equal(
    classifySlot({
      branch: 'acme-slot-j',
      baseBranch: 'acme-slot-j',
      locked: false,
      dirty: true,
      ahead: 0,
      prs: [],
    }).free,
    false,
  );
});

test('classifySlot: open PR is waiting-merge (busy)', () => {
  const v = classifySlot({
    branch: 'ABC-1/x',
    baseBranch: 'acme-slot-c',
    locked: false,
    dirty: false,
    ahead: 3,
    prs: [{ number: 4460, state: 'OPEN' }],
  });
  assert.equal(v.free, false);
  assert.equal(v.status, 'waiting-merge');
});

test('lockStale: dead worker always stale; live worker stale only when transcript quiet/gone', () => {
  const T = 1800;
  // dead/absent worker -> stale regardless of transcript (the live pane, not git/transcript, is truth)
  assert.equal(
    lockStale({ workerLive: false, transcript: '/t', transcriptAgeSec: 5, thresholdSec: T }),
    true,
  );
  assert.equal(
    lockStale({ workerLive: false, transcript: null, transcriptAgeSec: null, thresholdSec: T }),
    true,
  );
  // live worker + transcript -> stale only past threshold or when the transcript is gone
  assert.equal(
    lockStale({ workerLive: true, transcript: '/t', transcriptAgeSec: 25, thresholdSec: T }),
    false,
  );
  assert.equal(
    lockStale({ workerLive: true, transcript: '/t', transcriptAgeSec: 5000, thresholdSec: T }),
    true,
  );
  assert.equal(
    lockStale({ workerLive: true, transcript: '/t', transcriptAgeSec: null, thresholdSec: T }),
    true,
  );
  // live worker + slot-written lock (no transcript) = a live claim, never stale
  assert.equal(
    lockStale({ workerLive: true, transcript: null, transcriptAgeSec: null, thresholdSec: T }),
    false,
  );
});

test('writeLock/removeLock round-trip: slot-machine owns the lock file', () => {
  const dir = join(tmpdir(), `slot-lock-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(existsSync(join(dir, '.worktree-lock')), false);
    writeLock(dir, { session: 'acme4', pane: '%1', task: 'do X' });
    assert.equal(existsSync(join(dir, '.worktree-lock')), true);
    assert.equal(readLock(dir).session, 'acme4');
    assert.equal(removeLock(dir), true);
    assert.equal(existsSync(join(dir, '.worktree-lock')), false);
    assert.equal(removeLock(dir), false); // already gone
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox: report round-trip (append/read/clear)', () => {
  const dir = join(tmpdir(), `slot-inbox-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    assert.deepEqual(readInbox('t'), []);
    appendReport('t', { slot: 'f', message: 'done: PR #1' });
    appendReport('t', { slot: null, message: 'blocked: need a decision' });
    const got = readInbox('t');
    assert.equal(got.length, 2);
    assert.equal(got[0].slot, 'f');
    assert.equal(got[0].message, 'done: PR #1');
    assert.equal(got[1].message, 'blocked: need a decision');
    assert.equal(typeof got[0].ts, 'number');
    clearInbox('t');
    assert.deepEqual(readInbox('t'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('locks: resource claim is atomic - second claimant loses with holder info', () => {
  const dir = join(tmpdir(), `slot-locks-${process.pid}`);
  process.env.SLOT_LOCKS_DIR = dir;
  try {
    const first = claimResource('browser', { slot: 'f', task: 'shot' });
    assert.equal(first.ok, true);
    const second = claimResource('browser', { slot: 'h' });
    assert.equal(second.ok, false);
    assert.equal(second.holder.slot, 'f'); // loser sees the holder
    assert.equal(readResourceLock('browser').task, 'shot');
    assert.equal(listResourceLocks().length, 1);
    assert.equal(releaseResource('browser'), true);
    assert.equal(claimResource('browser', { slot: 'h' }).ok, true); // freed -> next claim wins
    assert.equal(releaseResource('browser'), true);
    assert.equal(releaseResource('browser'), false); // already gone
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_LOCKS_DIR;
  }
});

test('usage: record round-trip + summarize (counts, errors, avg/max, sort by count)', () => {
  const f = join(tmpdir(), `slot-usage-${process.pid}.jsonl`);
  process.env.SLOT_USAGE_FILE = f;
  try {
    recordUsage({ cmd: 'free', ok: true, ms: 1200, tty: true });
    recordUsage({ cmd: 'free', ok: true, ms: 800, tty: false });
    recordUsage({ cmd: 'msg', ok: false, ms: 50, tty: false });
    assert.equal(readUsage().length, 3);
    const rows = summarizeUsage(readUsage());
    assert.deepEqual(
      rows.map((r) => r.cmd),
      ['free', 'msg'],
    ); // sorted by count desc
    const free = rows[0];
    assert.equal(free.count, 2);
    assert.equal(free.errors, 0);
    assert.equal(free.tty, 1);
    assert.equal(free.avgMs, 1000);
    assert.equal(free.maxMs, 1200);
    assert.equal(rows[1].errors, 1);
  } finally {
    rmSync(f, { force: true });
    delete process.env.SLOT_USAGE_FILE;
  }
});

test('inbox: waitForReports wakes on append (push, not poll)', async () => {
  const dir = join(tmpdir(), `slot-sub-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    // safetyMs high so only the fs event (or timeout) can resolve it; timeout low to bound the test
    const waiting = waitForReports('t', { timeoutMs: 3000, safetyMs: 60_000 });
    setTimeout(() => appendReport('t', { slot: 'x', message: 'ping' }), 100);
    const got = await waiting;
    assert.equal(got.length, 1);
    assert.equal(got[0].message, 'ping');
    // no new report -> resolves [] at timeout instead of hanging
    assert.deepEqual(await waitForReports('t', { timeoutMs: 300, safetyMs: 60_000 }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('pickDispatchSlot: free+live wins, then merged+live, needs a live worker', () => {
  const rows = [
    { slot: 'a', status: 'locked', worker: 'live' },
    { slot: 'b', status: 'merged', worker: 'live' },
    { slot: 'c', status: 'free', worker: 'dead' },
    { slot: 'd', status: 'free', worker: 'live' },
  ];
  assert.equal(pickDispatchSlot(rows).slot, 'd');
  assert.equal(pickDispatchSlot(rows.filter((r) => r.slot !== 'd')).slot, 'b');
  assert.equal(pickDispatchSlot([{ slot: 'c', status: 'free', worker: 'dead' }]), null);
  assert.equal(pickDispatchSlot([{ slot: 'a', status: 'locked', worker: 'live' }]), null);
});

test('activeOverride: a reusable slot with a live working worker is not free', () => {
  // The bug: reset removes the lock, a fresh task is dispatched, the worker is working but
  // hasn't cut a branch/lock yet -> classifies free (or merged). Override flips it to busy.
  assert.deepEqual(activeOverride({ free: true, worker: 'live', activity: 'working' }), {
    free: false,
    status: 'active',
  });
  // genuinely reusable: idle/waiting live worker, or dead worker -> keep original classification
  assert.equal(activeOverride({ free: true, worker: 'live', activity: 'idle' }), null);
  assert.equal(activeOverride({ free: true, worker: 'live', activity: 'waiting' }), null);
  assert.equal(activeOverride({ free: true, worker: 'dead', activity: 'working' }), null);
  // never upgrade a busy slot to free
  assert.equal(activeOverride({ free: false, worker: 'live', activity: 'working' }), null);
});

test('paneActivity: working / waiting / idle / no-pane', () => {
  assert.equal(paneActivity('', false), 'no-pane');
  assert.equal(paneActivity('Actioning… (6m · ↓ 24.1k tokens)\n> ', true), 'working');
  assert.equal(paneActivity('esc to interrupt', true), 'working');
  assert.equal(paneActivity('Do you want to proceed?\n❯ 1. Yes', true), 'waiting');
  assert.equal(paneActivity('│ > \n  auto mode on', true), 'idle');
});

test('detectRole: inside a slot worktree = worker; elsewhere = dispatcher', () => {
  const root = '/home/u/Documents';
  assert.deepEqual(detectRole(`${root}/acme-slot-c`, root, 'acme-slot-'), { role: 'worker', slot: 'c' });
  assert.deepEqual(detectRole(`${root}/acme-slot-c/service-api-go`, root, 'acme-slot-'), {
    role: 'worker',
    slot: 'c',
  });
  assert.deepEqual(detectRole(root, root, 'acme-slot-'), { role: 'dispatcher', slot: null });
  assert.deepEqual(detectRole('/somewhere/else', root, 'acme-slot-'), { role: 'dispatcher', slot: null });
});

test('preflightStatus: slot ok, main-checkout flagged, elsewhere warned', () => {
  const root = '/home/u/Documents',
    repoDir = '/home/u/Documents/acme';
  const ctx = { root, prefix: 'acme-slot-', repoDir };
  assert.deepEqual(preflightStatus(`${root}/acme-slot-h/react-ui`, ctx), {
    ok: true,
    status: 'slot',
    slot: 'h',
  });
  assert.deepEqual(preflightStatus(repoDir, ctx), { ok: false, status: 'main-checkout', slot: null });
  assert.deepEqual(preflightStatus(`${repoDir}/service-api-go`, ctx), {
    ok: false,
    status: 'main-checkout',
    slot: null,
  });
  assert.deepEqual(preflightStatus('/tmp/whatever', ctx), { ok: false, status: 'outside', slot: null });
});

test('classifySlot: status tokens', () => {
  const base = {
    branch: 'acme-slot-j',
    baseBranch: 'acme-slot-j',
    locked: false,
    dirty: false,
    ahead: 0,
    prs: [],
  };
  assert.equal(classifySlot(base).status, 'free');
  assert.equal(classifySlot({ ...base, locked: true }).status, 'locked');
  assert.equal(classifySlot({ ...base, dirty: true }).status, 'dirty');
  assert.equal(
    classifySlot({ branch: 'f/x', baseBranch: 'acme-slot-j', locked: false, dirty: false, ahead: 2, prs: [] })
      .status,
    'wip',
  );
  assert.equal(
    classifySlot({
      branch: 'f/x',
      baseBranch: 'acme-slot-j',
      locked: false,
      dirty: false,
      ahead: 0,
      prs: [{ number: 1, state: 'MERGED' }],
    }).status,
    'merged',
  );
  assert.equal(
    classifySlot({
      branch: 'f/x',
      baseBranch: 'acme-slot-j',
      locked: false,
      dirty: false,
      ahead: 0,
      prs: [{ number: 1, state: 'CLOSED' }],
    }).status,
    'closed-pr',
  );
});

test('classifySlot: all PRs merged is free (even with stale ahead)', () => {
  assert.equal(
    classifySlot({
      branch: 'ABC-1/x',
      baseBranch: 'acme-slot-c',
      locked: false,
      dirty: false,
      ahead: 5,
      prs: [{ number: 10, state: 'MERGED' }],
    }).free,
    true,
  );
});

test('classifySlot: open beats merged when both present', () => {
  assert.equal(
    classifySlot({
      branch: 'ABC-1/x',
      baseBranch: 'acme-slot-c',
      locked: false,
      dirty: false,
      ahead: 1,
      prs: [
        { number: 10, state: 'MERGED' },
        { number: 11, state: 'OPEN' },
      ],
    }).free,
    false,
  );
});

test('classifySlot: committed work no PR is busy; feature branch not ahead is free', () => {
  assert.equal(
    classifySlot({
      branch: 'wip/x',
      baseBranch: 'acme-slot-i',
      locked: false,
      dirty: false,
      ahead: 4,
      prs: [],
    }).free,
    false,
  );
  assert.equal(
    classifySlot({
      branch: 'wip/x',
      baseBranch: 'acme-slot-i',
      locked: false,
      dirty: false,
      ahead: 0,
      prs: [],
    }).free,
    true,
  );
});

// --- integration: drive real tmux if available ----------------------------

const BIN = fileURLToPath(new URL('../bin/sm', import.meta.url));
const haveTmux = spawnSync('tmux', ['-V']).status === 0;
// Integration tests run against this machine's configured repo (`sm use`) and its real
// slot worktrees; on a machine with no config or no slots they skip cleanly.
const active = haveTmux ? resolveActive([]) : null;
const docs = active?.root ?? null;
const realSlots =
  docs && existsSync(docs)
    ? readdirSync(docs)
        .filter((n) => n.startsWith(active.prefix) && statSync(join(docs, n)).isDirectory())
        .sort()
    : [];
const repo = active?.repoDir ?? null;
// Children write usage telemetry to a throwaway file, not the real ~/.config/slot log
// (sm stats is the evidence stream the interface is refined from - tests must not salt it).
const TEST_USAGE = join(tmpdir(), `sm-usage-itest-${process.pid}.jsonl`);
const slotCmd = (...a) =>
  spawnSync(process.execPath, [BIN, '--repo', repo, ...a], {
    encoding: 'utf8',
    env: { ...process.env, SLOT_USAGE_FILE: TEST_USAGE },
  });
after(() => rmSync(TEST_USAGE, { force: true }));

test(
  'integration: msg reaches exactly the requested slot panes',
  { skip: !repo || realSlots.length < 3 ? 'need tmux + a configured repo with >=3 slots' : false },
  async () => {
    // Desk-skipping is covered at the unit level (selectPanes); here every SLOT pane runs a
    // logger, so over-broadcast to an unrequested slot would land in the log and fail the
    // exact-match assertion below.
    const sess = `slot-nodetest-${process.pid}`; // not <session-prefix>* -> never auto-detected
    const log = join(tmpdir(), `${sess}.log`);
    const pick = realSlots.slice(0, 4);
    const tmux = (...a) => spawnSync('tmux', a, { encoding: 'utf8' });

    rmSync(log, { force: true });
    // msg send claims the targeted slots (writes real .worktree-lock files) - snapshot the
    // lock files now and restore them after, so the test leaves no trace on real slots.
    const lockFiles = [0, 2].map((i) => join(docs, pick[i], '.worktree-lock'));
    const savedLocks = lockFiles.map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
    try {
      tmux('new-session', '-d', '-s', sess, '-n', 'desk', '-c', docs);
      tmux(
        'new-window',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        sess,
        '-c',
        join(docs, pick[0]),
        'bash',
        '-c',
        `while IFS= read -r x; do printf '%s:%s\\n' "$(basename "$PWD")" "$x" >> ${log}; done`,
      );
      for (const d of pick.slice(1)) {
        tmux(
          'split-window',
          '-P',
          '-F',
          '#{pane_id}',
          '-h',
          '-t',
          sess,
          '-c',
          join(docs, d),
          'bash',
          '-c',
          `while IFS= read -r x; do printf '%s:%s\\n' "$(basename "$PWD")" "$x" >> ${log}; done`,
        );
      }
      // Send to panes 0 and 2 of the 4 logging slot panes; 1 and 3 must stay silent.
      const label = (d) => d.slice(active.prefix.length);
      const r = slotCmd(
        'msg',
        'send',
        'hello world',
        '-s',
        `${label(pick[0])},${label(pick[2])}`,
        '-t',
        sess,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /sent to 2 slot pane\(s\)/);

      let lines = [];
      for (let i = 0; i < 40; i++) {
        if (existsSync(log)) lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        if (lines.length >= 2) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      assert.deepEqual(lines.sort(), [`${pick[0]}:hello world`, `${pick[2]}:hello world`]);
    } finally {
      tmux('kill-session', '-t', sess);
      rmSync(log, { force: true });
      lockFiles.forEach((p, i) =>
        savedLocks[i] == null ? rmSync(p, { force: true }) : writeFileSync(p, savedLocks[i]),
      );
    }
  },
);

test('integration: ls exits 0 (read-only)', { skip: repo ? false : 'need tmux + a configured repo' }, () => {
  assert.equal(slotCmd('session', 'ls').status, 0);
});

test(
  'integration: kill removes a named session',
  { skip: repo ? false : 'need tmux + a configured repo' },
  () => {
    const name = `slot-killtest-${process.pid}`;
    const tmux = (...a) => spawnSync('tmux', a, { encoding: 'utf8' });
    tmux('new-session', '-d', '-s', name);
    try {
      assert.equal(tmux('has-session', '-t', name).status, 0, 'setup: session should exist');
      const r = slotCmd('session', 'kill', name);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`killed '${name}'`));
      assert.notEqual(tmux('has-session', '-t', name).status, 0, 'session should be gone');
    } finally {
      tmux('kill-session', '-t', name); // no-op when the test passed
    }
  },
);
