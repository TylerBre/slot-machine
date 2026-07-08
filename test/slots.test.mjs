// Tests for sm. Run: node --test  (or npm test)
// Pure-logic tests always run; tmux integration tests run only when tmux and a
// configured repo (`sm use`) with real slot worktrees are present, otherwise they skip.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activeOverride,
  classifySlot,
  detectRole,
  issueFromText,
  lockStale,
  paneActivity,
  pickDispatchSlot,
  preflightStatus,
  resolveSlots,
  selectPanes,
} from '../lib/slots/pure.mjs';
import {
  addResource,
  elevateLock,
  elevateResourceLock,
  LOCK_SCHEMA_VERSION,
  readLock,
  readLockFull,
  removeLock,
  removeResource,
  RESOURCE_LOCK_SCHEMA_VERSION,
  validateLock,
  validateResourceLock,
  writeLock,
} from '../lib/slots/locks.mjs';
import { LOCK_FILENAME } from '../lib/constants.mjs';
import { resolveActive } from '../lib/context.mjs';
import { formatSessions } from '../lib/format.mjs';
import { appendReport, clearInbox, readInbox, waitForReports } from '../lib/inbox.mjs';
import { readUsage, recordUsage, summarizeUsage } from '../lib/usage.mjs';

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
  const lines = ['a', 'b', 'c'].map((lbl, idx) => `%${idx} ${docs}/acme-slot-${lbl}`);
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

test('issueFromText: parses a tracker id from a branch or task, generic (not tracker-specific)', () => {
  assert.equal(issueFromText('tylerbreland/sc-10103/hr-offices-contains-filter'), 'sc-10103');
  assert.equal(issueFromText('sc9584-data-services-research'), 'sc-9584');
  assert.equal(issueFromText('fix sc-10132 physical office'), 'sc-10132');
  assert.equal(issueFromText('proj-42 do a thing'), 'proj-42');
  assert.equal(issueFromText('no-ticket/here'), null);
  assert.equal(issueFromText(null), null);
});

test('elevateLock: a legacy lock elevates to the current schema, adopts cwd, drops the old slot key', () => {
  // legacy locks carried `slot` (label) + `transcript`; both are dropped in favor of cwd identity
  const up = elevateLock(
    { slot: 'c', transcript: '/t/gemini-c/x.jsonl', task: 'fix sc-9812 thing', ts: 1 },
    '/x/gemini-c',
  );
  assert.equal(up.v, LOCK_SCHEMA_VERSION);
  assert.equal(up.cwd, '/x/gemini-c'); // cwd stamped from the read path
  assert.equal('slot' in up, false);
  assert.equal(up.issue, 'sc-9812'); // issue backfilled from the task
  assert.deepEqual(validateLock(up), []); // an elevated legacy lock conforms to the schema
  const cur = elevateLock({ v: 1, cwd: '/x/gemini-c', issue: 'sc-1', ts: 2 });
  assert.equal(cur.v, 1);
  assert.equal(cur.issue, 'sc-1');
});

test('validateLock: flags missing-required, wrong-type, and unexpected keys', () => {
  assert.deepEqual(validateLock({ v: 1, cwd: '/x/gemini-c', ts: 1, issue: 'sc-1', session: null }), []);
  assert.ok(validateLock({ cwd: '/x', ts: 1 }).some(prob => prob.includes('required \'v\'')));
  assert.ok(validateLock({ v: 1, cwd: '/x', ts: 'nope' }).some(prob => prob.includes('\'ts\'')));
  assert.ok(validateLock({ v: 1, cwd: '/x', ts: 1, bogus: 1 }).some(prob => prob.includes('unexpected')));
});

test('resource lock: elevate stamps version + drops legacy holder fields; validate is schema-driven', () => {
  // legacy resource locks were separate files carrying slot/cwd/session; embedded records drop those
  const up = elevateResourceLock({ resource: 'browser', slot: 'f', cwd: '/x/gemini-f', task: 'shot', ts: 1 });
  assert.equal(up.v, RESOURCE_LOCK_SCHEMA_VERSION);
  assert.equal('slot' in up, false);
  assert.equal('cwd' in up, false); // holder identity now comes from the enclosing worktree lock
  assert.equal('pid' in up, false); // the vestigial pid is dropped by the v1 -> v2 step
  assert.deepEqual(validateResourceLock(up), []);
  // the v1 -> v2 migration: a pre-fix v1 record still carrying `pid` elevates cleanly (pid stripped)
  const stripped = elevateResourceLock({ v: 1, resource: 'browser', task: 'shot', pid: 4242, ts: 1 });
  assert.equal(stripped.v, 2);
  assert.equal('pid' in stripped, false);
  assert.deepEqual(validateResourceLock(stripped), []);
  assert.deepEqual(validateResourceLock({ v: RESOURCE_LOCK_SCHEMA_VERSION, resource: 'browser', ts: 2 }), []);
  assert.ok(validateResourceLock({ resource: 'browser', ts: 1 }).some(prob => prob.includes('required \'v\'')));
  assert.ok(
    validateResourceLock({ v: RESOURCE_LOCK_SCHEMA_VERSION, resource: 'browser', cwd: '/x', ts: 1 }).some(prob =>
      prob.includes('unexpected'),
    ),
  );
});

test('resources: add/remove are pure, dedup on re-claim, and validate via the worktree $ref', () => {
  const base = { v: 1, cwd: '/x/gemini-f', ts: 1 };
  const one = addResource(base, 'browser', 'shot');
  assert.equal(one.resources.length, 1);
  assert.equal(one.resources[0].resource, 'browser');
  assert.equal('resources' in base, false); // pure: original untouched
  const two = addResource(one, 'port', null);
  const reclaim = addResource(two, 'browser', 'newshot'); // re-claim refreshes, no dupe
  assert.equal(reclaim.resources.filter(res => res.resource === 'browser').length, 1);
  assert.equal(reclaim.resources.find(res => res.resource === 'browser').task, 'newshot');
  // the worktree schema $refs the resource schema, so a lock with embedded resources validates
  assert.deepEqual(validateLock(reclaim), []);
  const released = removeResource(reclaim, 'browser');
  assert.equal(
    released.resources.some(res => res.resource === 'browser'),
    false,
  );
  // a malformed embedded resource is flagged with an indexed path
  const bad = { ...base, resources: [{ v: RESOURCE_LOCK_SCHEMA_VERSION, resource: 'browser', ts: 'nope' }] };
  assert.ok(validateLock(bad).some(prob => prob.includes('resources[0]')));
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
  const cls = classifySlot({
    branch: 'ABC-1/x',
    baseBranch: 'acme-slot-c',
    locked: false,
    dirty: false,
    ahead: 3,
    prs: [{ number: 4460, state: 'OPEN' }],
  });
  assert.equal(cls.free, false);
  assert.equal(cls.status, 'waiting-merge');
});

test('lockStale: dead worker always stale; live worker stale only when transcript quiet/gone', () => {
  const thr = 1800;
  // dead/absent worker -> stale regardless of transcript (the live pane, not git/transcript, is truth)
  assert.equal(
    lockStale({ workerLive: false, transcript: '/t', transcriptAgeSec: 5, thresholdSec: thr }),
    true,
  );
  assert.equal(
    lockStale({ workerLive: false, transcript: null, transcriptAgeSec: null, thresholdSec: thr }),
    true,
  );
  // live worker + transcript -> stale only past threshold or when the transcript is gone
  assert.equal(
    lockStale({ workerLive: true, transcript: '/t', transcriptAgeSec: 25, thresholdSec: thr }),
    false,
  );
  assert.equal(
    lockStale({ workerLive: true, transcript: '/t', transcriptAgeSec: 5000, thresholdSec: thr }),
    true,
  );
  assert.equal(
    lockStale({ workerLive: true, transcript: '/t', transcriptAgeSec: null, thresholdSec: thr }),
    true,
  );
  // live worker + slot-written lock (no transcript) = a live claim, never stale
  assert.equal(
    lockStale({ workerLive: true, transcript: null, transcriptAgeSec: null, thresholdSec: thr }),
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
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLockFull: elevates a legacy embedded resource record on read', () => {
  const dir = join(tmpdir(), `sm-embedres-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    // a current lock, but with a v0 (legacy, no `v`) resource record embedded
    const raw = { v: 1, cwd: dir, ts: 1, resources: [{ resource: 'browser', task: 'shot', ts: 2 }] };
    writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(raw)}\n`);
    const lock = readLockFull(dir);
    assert.equal(lock.resources[0].v, RESOURCE_LOCK_SCHEMA_VERSION); // elevated
    assert.equal(lock.resources[0].resource, 'browser');
  }
  finally {
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
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('usage: record round-trip + summarize (counts, errors, avg/max, sort by count)', () => {
  const file = join(tmpdir(), `slot-usage-${process.pid}.jsonl`);
  process.env.SLOT_USAGE_FILE = file;
  try {
    recordUsage({ cmd: 'free', ok: true, ms: 1200, tty: true });
    recordUsage({ cmd: 'free', ok: true, ms: 800, tty: false });
    recordUsage({ cmd: 'msg', ok: false, ms: 50, tty: false });
    assert.equal(readUsage().length, 3);
    const rows = summarizeUsage(readUsage());
    assert.deepEqual(
      rows.map(row => row.cmd),
      ['free', 'msg'],
    ); // sorted by count desc
    const free = rows[0];
    assert.equal(free.count, 2);
    assert.equal(free.errors, 0);
    assert.equal(free.tty, 1);
    assert.equal(free.avgMs, 1000);
    assert.equal(free.maxMs, 1200);
    assert.equal(rows[1].errors, 1);
  }
  finally {
    rmSync(file, { force: true });
    delete process.env.SLOT_USAGE_FILE;
  }
});

test('inbox: waitForReports wakes on append (push, not poll)', async () => {
  const dir = join(tmpdir(), `slot-sub-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    // safetyMs high so only the fs event (or timeout) can resolve it; timeout low to bound the test
    const waiting = waitForReports('t', { timeoutMs: 3000, safetyMs: 60_000 });
    setTimeout(appendReport, 100, 't', { slot: 'x', message: 'ping' });
    const got = await waiting;
    assert.equal(got.length, 1);
    assert.equal(got[0].message, 'ping');
    // no new report -> resolves [] at timeout instead of hanging
    assert.deepEqual(await waitForReports('t', { timeoutMs: 300, safetyMs: 60_000 }), []);
  }
  finally {
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
  assert.equal(pickDispatchSlot(rows.filter(row => row.slot !== 'd')).slot, 'b');
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
  const root = '/home/u/Documents';
  const repoDir = '/home/u/Documents/acme';
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
const realSlots
  = docs && existsSync(docs)
    ? readdirSync(docs)
        .filter(entry => entry.startsWith(active.prefix) && statSync(join(docs, entry)).isDirectory())
        .sort()
    : [];
const repo = active?.repoDir ?? null;
// Children write usage telemetry to a throwaway file, not the real ~/.config/slot log
// (sm stats is the evidence stream the interface is refined from - tests must not salt it).
const TEST_USAGE = join(tmpdir(), `sm-usage-itest-${process.pid}.jsonl`);
function slotCmd(...args) {
  return spawnSync(process.execPath, [BIN, '--repo', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SLOT_USAGE_FILE: TEST_USAGE },
  });
}
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
    const tmux = (...args) => spawnSync('tmux', args, { encoding: 'utf8' });

    rmSync(log, { force: true });
    // msg send claims the targeted slots (writes real .worktree-lock files) - snapshot the
    // lock files now and restore them after, so the test leaves no trace on real slots.
    const lockFiles = [0, 2].map(idx => join(docs, pick[idx], '.worktree-lock'));
    const savedLocks = lockFiles.map(lockPath => (existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null));
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
      for (const dir of pick.slice(1)) {
        tmux(
          'split-window',
          '-P',
          '-F',
          '#{pane_id}',
          '-h',
          '-t',
          sess,
          '-c',
          join(docs, dir),
          'bash',
          '-c',
          `while IFS= read -r x; do printf '%s:%s\\n' "$(basename "$PWD")" "$x" >> ${log}; done`,
        );
      }
      // Send to panes 0 and 2 of the 4 logging slot panes; 1 and 3 must stay silent.
      const label = dir => dir.slice(active.prefix.length);
      const result = slotCmd(
        'msg',
        'send',
        'hello world',
        '-s',
        `${label(pick[0])},${label(pick[2])}`,
        '-t',
        sess,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /delivered to 2\/2 slot pane\(s\)/); // verified-submit count

      let lines = [];
      for (let attempt = 0; attempt < 40; attempt++) {
        if (existsSync(log))
          lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        if (lines.length >= 2)
          break;
        await new Promise(res => setTimeout(res, 50));
      }
      assert.deepEqual(lines.sort(), [`${pick[0]}:hello world`, `${pick[2]}:hello world`]);
    }
    finally {
      tmux('kill-session', '-t', sess);
      rmSync(log, { force: true });
      lockFiles.forEach((lockPath, idx) =>
        savedLocks[idx] == null ? rmSync(lockPath, { force: true }) : writeFileSync(lockPath, savedLocks[idx]),
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
    const tmux = (...args) => spawnSync('tmux', args, { encoding: 'utf8' });
    tmux('new-session', '-d', '-s', name);
    try {
      assert.equal(tmux('has-session', '-t', name).status, 0, 'setup: session should exist');
      const res = slotCmd('session', 'kill', name);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`killed '${name}'`));
      assert.notEqual(tmux('has-session', '-t', name).status, 0, 'session should be gone');
    }
    finally {
      tmux('kill-session', '-t', name); // no-op when the test passed
    }
  },
);
