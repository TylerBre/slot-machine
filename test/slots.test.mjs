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
  killTargetsFromPgrep,
  lockStale,
  pickDispatchSlot,
  preflightStatus,
  reloadPaneWidth,
  reloadTargetWindow,
  resolveSlots,
  selectAndClaim,
  selectPanes,
} from '../lib/slots/pure.mjs';
import {
  addResource,
  elevateLock,
  elevateResourceLock,
  LOCK_SCHEMA_VERSION,
  readDoc,
  readLock,
  readLockFull,
  readTurn,
  readWorker,
  removeLock,
  removeResource,
  RESOURCE_LOCK_SCHEMA_VERSION,
  validateLock,
  validateResourceLock,
  writeLock,
  writeWorker,
} from '../lib/slots/locks.mjs';
import { LOCK_FILENAME } from '../lib/constants.mjs';
import { resolveActive } from '../lib/context.mjs';
import { formatSessions } from '../lib/format.mjs';
import { appendReport, clearInbox, consumeReports, readInbox, waitForReports } from '../lib/inbox.mjs';
import { readUsage, recordUsage, summarizeUsage } from '../lib/usage.mjs';
import { workersFromPanes } from '../lib/slots/gather.mjs';

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

// A minimal Pane record (see lib/mux/contract.mjs); label defaults to '' = pre-label pane.
const pane = (id, cwd, label = '') => ({ id, cwd, label });

test('selectPanes: no filter picks all slot panes, skips desk/non-slot', () => {
  const docs = '/home/u/Documents';
  const panes = [
    pane('%0', docs), // desk
    pane('%1', `${docs}/acme-slot-a`),
    pane('%2', `${docs}/acme-slot-b`),
    pane('%3', '/somewhere/else'), // unrelated pane
    null, // dropped entry
  ];
  assert.deepEqual(selectPanes(panes, docs, 'acme-slot-', null), [
    { id: '%1', lbl: 'a' },
    { id: '%2', lbl: 'b' },
  ]);
});

test('selectPanes: filters to wanted labels, preserves order', () => {
  const docs = '/home/u/Documents';
  const panes = ['a', 'b', 'c'].map((lbl, idx) => pane(`%${idx}`, `${docs}/acme-slot-${lbl}`));
  assert.deepEqual(selectPanes(panes, docs, 'acme-slot-', set('a', 'c')), [
    { id: '%0', lbl: 'a' },
    { id: '%2', lbl: 'c' },
  ]);
});

test('selectPanes: rejects a nested path under a slot dir', () => {
  const docs = '/home/u/Documents';
  assert.deepEqual(selectPanes([pane('%1', `${docs}/acme-slot-a/sub`)], docs, 'acme-slot-', null), []);
});

test('selectPanes: a stamped label wins over cwd - survives the worker cd-ing away', () => {
  const docs = '/home/u/Documents';
  const panes = [
    pane('%1', '/somewhere/else', 'a'), // label stamped at spawn; cwd moved
    pane('%2', `${docs}/acme-slot-b`), // pre-label pane: cwd fallback
  ];
  assert.deepEqual(selectPanes(panes, docs, 'acme-slot-', null), [
    { id: '%1', lbl: 'a' },
    { id: '%2', lbl: 'b' },
  ]);
});

test('selectPanes: one entry PER pane - a slot shown in two panes yields two targets', () => {
  // Documented contract: broadcast/-s delivery hits every matching pane (msg send then dedups the
  // claim by lock dir, which is idempotent). This is deliberate, not the per-label dedup slotPanes does.
  const docs = '/home/u/Documents';
  const panes = [pane('%1', `${docs}/acme-slot-a`), pane('%2', `${docs}/acme-slot-a`)];
  assert.deepEqual(selectPanes(panes, docs, 'acme-slot-', null), [
    { id: '%1', lbl: 'a' },
    { id: '%2', lbl: 'a' },
  ]);
});

test('killTargetsFromPgrep: keeps numeric child pids, drops blanks/garbage; empty when none', () => {
  assert.deepEqual(killTargetsFromPgrep('4242\n4243\n'), [4242, 4243]);
  assert.deepEqual(killTargetsFromPgrep('  91\n\n  92  \n'), [91, 92]); // trims, skips blanks
  assert.deepEqual(killTargetsFromPgrep('91\nnotapid\n92'), [91, 92]); // skips non-numeric noise
  assert.deepEqual(killTargetsFromPgrep(''), []); // pane already at a shell -> nothing to kill
  assert.deepEqual(killTargetsFromPgrep(null), []);
});

test('reloadTargetWindow: fills the first window with room, spills (null) when all are full', () => {
  assert.equal(reloadTargetWindow([{ id: 'w1', panes: 3 }], 3), null); // full -> new window
  assert.deepEqual(reloadTargetWindow([{ id: 'w1', panes: 2 }], 3), { id: 'w1', panes: 2 }); // room
  assert.deepEqual(reloadTargetWindow([{ id: 'w1', panes: 3 }, { id: 'w2', panes: 1 }], 3), { id: 'w2', panes: 1 });
  assert.equal(reloadTargetWindow([], 3), null); // no windows yet -> new window
  assert.equal(reloadTargetWindow([{ id: 'w1', panes: 2 }], 2), null); // exactly at width -> full
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

test('elevateLock: a legacy lock elevates to the current sectioned schema, adopts cwd, drops slot/pane', () => {
  // legacy locks carried `slot` (label) + `transcript`; both are dropped in favor of cwd identity.
  // the wrap step (v1 -> v2) sections the document: flat claim fields move under `claim`.
  const up = elevateLock(
    { slot: 'c', transcript: '/t/gemini-c/x.jsonl', task: 'fix sc-9812 thing', ts: 1 },
    '/x/gemini-c',
  );
  assert.equal(up.v, LOCK_SCHEMA_VERSION);
  assert.equal(up.cwd, '/x/gemini-c'); // cwd stamped from the read path, stays top-level (identity)
  assert.equal('slot' in up, false);
  assert.equal(up.claim.issue, 'sc-9812'); // issue backfilled from the task, now under claim
  assert.equal(up.worker, null);
  assert.equal(up.turn, null);
  assert.deepEqual(validateLock(up), []); // an elevated legacy lock conforms to the schema

  // a flat v1 lock (the previous current shape) wraps: pane dropped, resources move under claim
  const wrapped = elevateLock({
    v: 1,
    cwd: '/x/gemini-c',
    session: 'acme3',
    pane: '%9',
    task: 'do X',
    issue: 'sc-1',
    ts: 2,
    resources: [{ v: 2, resource: 'browser', task: null, ts: 3 }],
  });
  assert.equal(wrapped.v, LOCK_SCHEMA_VERSION);
  assert.equal(wrapped.claim.session, 'acme3');
  assert.equal(wrapped.claim.issue, 'sc-1');
  assert.equal(wrapped.claim.resources[0].resource, 'browser'); // moved under claim
  assert.equal('pane' in wrapped.claim, false); // the stale-by-read-time handle is gone
  assert.equal('pane' in wrapped, false);
  assert.equal(wrapped.worker, null);
  assert.equal(wrapped.turn, null);
  assert.deepEqual(validateLock(wrapped), []);

  // pre-v1 relics written by old workers carry ISO-string timestamps; the wrap step
  // normalizes them to epoch ms so age math works (observed live: a July-22 v0 lock)
  const relic = elevateLock(
    { session: 'uuid-ish', transcript: '/t/gemini-c/x.jsonl', ts: '2026-07-22T20:26:05Z' },
    '/x/gemini-c',
  );
  assert.equal(relic.ts, Date.parse('2026-07-22T20:26:05Z'));
  assert.equal(relic.claim.ts, Date.parse('2026-07-22T20:26:05Z'));
  assert.deepEqual(validateLock(relic), []); // integer ts now conforms
});

test('validateLock: flags missing-required, wrong-type, and unexpected keys (sectioned shape)', () => {
  const ver = LOCK_SCHEMA_VERSION;
  assert.deepEqual(
    validateLock({ v: ver, cwd: '/x/gemini-c', ts: 1, claim: { session: null, task: null, issue: 'sc-1', ts: 1 }, worker: null, turn: null }),
    [],
  );
  assert.ok(validateLock({ cwd: '/x', ts: 1 }).some(prob => prob.includes('required \'v\'')));
  assert.ok(validateLock({ v: ver, cwd: '/x', ts: 'nope' }).some(prob => prob.includes('\'ts\'')));
  assert.ok(validateLock({ v: ver, cwd: '/x', ts: 1, bogus: 1 }).some(prob => prob.includes('unexpected')));
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
  const base = { session: null, task: null, issue: null, ts: 1 }; // a claim section (flat claim shape)
  const one = addResource(base, 'browser', 'shot');
  assert.equal(one.resources.length, 1);
  assert.equal(one.resources[0].resource, 'browser');
  assert.equal('resources' in base, false); // pure: original untouched
  const two = addResource(one, 'port', null);
  const reclaim = addResource(two, 'browser', 'newshot'); // re-claim refreshes, no dupe
  assert.equal(reclaim.resources.filter(res => res.resource === 'browser').length, 1);
  assert.equal(reclaim.resources.find(res => res.resource === 'browser').task, 'newshot');
  // the worktree schema $refs the resource schema under claim, so a sectioned doc validates
  const doc = { v: LOCK_SCHEMA_VERSION, cwd: '/x/gemini-f', ts: 1, claim: reclaim, worker: null, turn: null };
  assert.deepEqual(validateLock(doc), []);
  const released = removeResource(reclaim, 'browser');
  assert.equal(
    released.resources.some(res => res.resource === 'browser'),
    false,
  );
  // a malformed embedded resource is flagged with an indexed path under the claim
  const bad = { ...doc, claim: { ...reclaim, resources: [{ v: RESOURCE_LOCK_SCHEMA_VERSION, resource: 'browser', ts: 'nope' }] } };
  assert.ok(validateLock(bad).some(prob => prob.includes('resources[0]')));
});

test('sectioned document: readLock/readDoc/readWorker/readTurn contracts', () => {
  const dir = join(tmpdir(), `sm-doc-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    // absent file: everything reads empty
    assert.equal(readLock(dir), null);
    assert.equal(readDoc(dir), null);
    assert.equal(readWorker(dir), null);
    assert.equal(readTurn(dir), null);

    // a legacy flat v1 file on disk reads as a sectioned doc; readLock returns the flat claim contract
    const flat = { v: 1, cwd: dir, session: 'acme3', pane: '%9', task: 'fix sc-77 x', issue: 'sc-77', ts: 5 };
    writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(flat)}\n`);
    const lock = readLock(dir);
    assert.equal(lock.session, 'acme3');
    assert.equal(lock.task, 'fix sc-77 x');
    assert.equal(lock.issue, 'sc-77');
    assert.equal(lock.ts, 5);
    assert.equal(lock.cwd, dir); // identity still surfaced on the readLock contract
    assert.deepEqual(lock.resources, []);
    assert.equal(readWorker(dir), null); // legacy file: no worker/turn sections
    assert.equal(readTurn(dir), null);

    // a sectioned doc with worker but NO claim: readLock is null (unclaimed), worker reads through
    const doc = {
      v: LOCK_SCHEMA_VERSION,
      cwd: dir,
      ts: 6,
      claim: null,
      worker: { agent: 'claude', model: null, transport: 'pane', sessionId: null, createdAt: 6 },
      turn: null,
    };
    writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(doc)}\n`);
    assert.equal(readLock(dir), null); // unclaimed - classify/lockIsLive see no lock
    assert.equal(readWorker(dir).agent, 'claude');
    assert.equal(readTurn(dir), null);

    // corrupt file: readLock flags unparseable, section accessors degrade to null
    writeFileSync(join(dir, LOCK_FILENAME), 'not json');
    assert.equal(readLock(dir).unparseable, true);
    assert.equal(readWorker(dir), null);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sectioned document: writeLock/removeLock preserve sibling sections', () => {
  const dir = join(tmpdir(), `sm-doc-sec-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    // seed a doc that has a worker (and a claim with a resource) - the sections writeLock must not eat
    const seeded = {
      v: LOCK_SCHEMA_VERSION,
      cwd: dir,
      ts: 1,
      claim: { session: 'old', task: null, issue: null, ts: 1, resources: [{ v: 2, resource: 'browser', task: null, ts: 2 }] },
      worker: { agent: 'claude', model: null, transport: 'pane', sessionId: 'sess-1', createdAt: 1 },
      turn: null,
    };
    writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(seeded)}\n`);

    // re-claim: writeLock replaces the claim but preserves worker (and does not accept pane)
    writeLock(dir, { session: 'acme4', task: 'next task' });
    const doc = readDoc(dir);
    assert.equal(doc.claim.session, 'acme4');
    assert.equal(readWorker(dir).sessionId, 'sess-1'); // sibling section survived the claim write
    assert.equal('pane' in doc.claim, false);

    // removeLock clears the claim but keeps the file while a worker exists
    assert.equal(removeLock(dir), true);
    assert.equal(existsSync(join(dir, LOCK_FILENAME)), true); // file survives - worker identity kept
    assert.equal(readLock(dir), null);
    assert.equal(readWorker(dir).agent, 'claude');
    assert.equal(removeLock(dir), false); // nothing left to release

    // clearing the worker too makes the doc all-null; removing then unlinks
    writeWorker(dir, null);
    assert.equal(existsSync(join(dir, LOCK_FILENAME)), false); // all-null document == no document
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sectioned document: readLockFull surfaces claim resources from the sectioned shape', () => {
  const dir = join(tmpdir(), `sm-doc-res-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    const doc = {
      v: LOCK_SCHEMA_VERSION,
      cwd: dir,
      ts: 1,
      claim: { session: 's', task: null, issue: null, ts: 1, resources: [{ resource: 'browser', task: 'shot', ts: 2 }] },
      worker: { agent: 'claude', model: null, transport: 'pane', sessionId: null, createdAt: 1 },
      turn: null,
    };
    writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(doc)}\n`);
    const full = readLockFull(dir);
    assert.equal(full.resources[0].v, RESOURCE_LOCK_SCHEMA_VERSION); // legacy embedded record elevated
    assert.equal(full.resources[0].resource, 'browser');
    assert.equal(full.cwd, dir);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('consumeReports: drops exactly the displayed ts set, keeps earlier + later (incl. a late arrival)', () => {
  const dir = join(tmpdir(), `slot-consume-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    const records = [0, 1, 2, 3].map(idx => appendReport('t', { slot: 'a', message: `r${idx}` }));
    // A watch displayed r1 + r2. Before consuming, a new report lands.
    appendReport('t', { slot: 'a', message: 'r4-arrived-during' });
    consumeReports('t', [records[1].ts, records[2].ts]); // drop exactly the displayed two
    const kept = readInbox('t').map(entry => entry.message);
    assert.deepEqual(kept, ['r0', 'r3', 'r4-arrived-during']); // the late arrival must survive
    // consuming everything currently present empties the inbox
    clearInbox('t');
    const more = [0, 1, 2].map(idx => appendReport('t', { slot: 'a', message: `x${idx}` }));
    consumeReports('t', more.map(record => record.ts));
    assert.deepEqual(readInbox('t'), []);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('inbox: ts stamps are strictly monotonic, even inside one millisecond', () => {
  const dir = join(tmpdir(), `slot-mono-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  const realNow = Date.now;
  try {
    const frozen = realNow();
    Date.now = () => frozen; // freeze the clock: same-ms appends are now guaranteed
    const first = appendReport('t', { slot: 'a', message: 'one' });
    const second = appendReport('t', { slot: 'b', message: 'two' });
    assert.equal(first.ts, frozen);
    assert.equal(second.ts, frozen + 1); // distinct + increasing despite the frozen clock
    Date.now = realNow;
    const third = appendReport('t', { slot: 'c', message: 'three' });
    assert.ok(third.ts > second.ts);
  }
  finally {
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('inbox: readInbox sinceTs is a strict boundary; waitForReports survives a concurrent clear', async () => {
  const dir = join(tmpdir(), `slot-since-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    const first = appendReport('t', { slot: 'a', message: 'old-1' });
    const second = appendReport('t', { slot: 'a', message: 'old-2' });
    assert.deepEqual(readInbox('t', { sinceTs: first.ts }).map(entry => entry.message), ['old-2']); // > not >=
    assert.deepEqual(readInbox('t', { sinceTs: second.ts }), []);

    // the today-broken scenario: watch armed over N entries, another process clears, a report lands
    const waiting = waitForReports('t', { timeoutMs: 3000, safetyMs: 100 });
    clearInbox('t'); // shrinks the file; a length baseline would never trip again
    setTimeout(appendReport, 50, 't', { slot: 'x', message: 'after-clear' });
    const got = await waiting;
    assert.equal(got.length, 1);
    assert.equal(got[0].message, 'after-clear');
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

test('classifySlot: unknown ahead (base unresolvable) is NOT free - fails safe', () => {
  // ahead=null means the commit count could not be computed (origin/<base> did not resolve).
  // A committed-but-unpushed slot must never read as free, or the dispatcher clobbers live work.
  const cls = classifySlot({
    branch: 'acme-slot-j',
    baseBranch: 'acme-slot-j',
    locked: false,
    dirty: false,
    ahead: null,
    prs: [],
  });
  assert.equal(cls.free, false);
  assert.equal(cls.status, 'unknown');
  // a merged PR still wins over unknown-ahead (the PR state is authoritative)
  assert.equal(
    classifySlot({
      branch: 'f/x',
      baseBranch: 'acme-slot-j',
      locked: false,
      dirty: false,
      ahead: null,
      prs: [{ number: 1, state: 'MERGED' }],
    }).free,
    true,
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
    // Stub each worker pane with a node stdin-reader, NOT a bash loop: msg send now skips panes
    // whose pane_current_command is a shell (the "Claude exited" signal), so the stub must run a
    // non-shell command ('node') to register as a live worker. It logs '<basename>:<line>' so an
    // over-broadcast to an unrequested slot would show up and fail the exact-match assertion.
    const reader = `require('readline').createInterface({input:process.stdin}).on('line',l=>require('fs').appendFileSync(${JSON.stringify(log)},require('path').basename(process.cwd())+':'+l+'\\n'))`;

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
        'node',
        '-e',
        reader,
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
          'node',
          '-e',
          reader,
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
      assert.match(result.stdout, /delivered to 2\/2 live slot pane\(s\)/); // verified-submit count

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

test('reloadPaneWidth: preserves the densest existing packing, defaults to 3 when empty', () => {
  assert.equal(reloadPaneWidth([2, 2, 2]), 2); // a 2-pane layout stays 2 (regression: was floored to 3)
  assert.equal(reloadPaneWidth([2, 2, 1]), 2); // a partial trailing window does not bump the width
  assert.equal(reloadPaneWidth([3, 3]), 3);
  assert.equal(reloadPaneWidth([4, 4, 4]), 4);
  assert.equal(reloadPaneWidth([]), 3); // no slot windows yet -> the create default
});

test('workersFromPanes: live/dead per label; slotWorkerSample shape carries the envelope ok', () => {
  const panes = [
    { label: 'a', exited: false, command: '2.1.201' }, // agent running
    { label: 'b', exited: false, command: 'zsh' }, // fell back to a shell
    { label: 'a', exited: false, command: 'zsh' }, // second pane for a: live wins
    { exited: false, command: 'node', cwd: '/nowhere' }, // unlabeled, foreign cwd: ignored
  ];
  const workers = workersFromPanes(panes);
  assert.deepEqual(workers, { a: 'live', b: 'dead' });
});

test('selectAndClaim: loser of a claim race re-picks from remaining candidates; exhaustion yields null', async () => {
  const rows = [
    { slot: 'a', status: 'free', worker: 'live' },
    { slot: 'b', status: 'free', worker: 'live' },
  ];
  // first candidate is stolen out from under the picker - it must fall through to the next
  const stolen = new Set(['a']);
  const picked = await selectAndClaim(rows, async pick => !stolen.has(pick.slot));
  assert.equal(picked.slot, 'b');
  // everything stolen: honest null, exactly one attempt per candidate
  const attempts = [];
  const none = await selectAndClaim(rows, async (pick) => {
    attempts.push(pick.slot);
    return false;
  });
  assert.equal(none, null);
  assert.deepEqual(attempts.sort(), ['a', 'b']);
});
