// The absorb/surface policy matrix. classify() is pure: every case here is a plain
// evidence value in, a deterministic {surface, absorbed} out - no IO, no clocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/slots/verbs.mjs';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

// Evidence builder: sane defaults, override per case.
function ev(overrides = {}) {
  return {
    entries: [],
    surfacedTs: 0,
    slots: [],
    workersA: {},
    workersB: null,
    activity: {},
    snapshotOk: true,
    prs: { ok: true, bySlot: {} },
    journal: [],
    ghFails: 0,
    now: NOW,
    ...overrides,
  };
}

const entry = (slot, message, ts) => ({ v: 1, ts, slot, message });
const types = list => list.map(event => event.type);

test('reports: attention verbs + null surface; working/paused absorb; below-watermark ignored', () => {
  const entries = [
    entry('a', 'done: PR #1', NOW - 9 * MIN),
    entry('b', 'blocked: no creds', NOW - 8 * MIN),
    entry('c', 'needs-decision: A or B', NOW - 7 * MIN),
    entry('d', 'failed: suite red', NOW - 6 * MIN),
    entry('e', 'no verb at all', NOW - 5 * MIN),
    entry('f', 'working: tests', NOW - 4 * MIN),
    entry('g', 'paused: UAT wait', NOW - 3 * MIN),
  ];
  const { surface, absorbed } = classify(ev({ entries }));
  const reports = surface.filter(event => event.type === 'report');
  assert.deepEqual(reports.map(event => event.verb), ['done', 'blocked', 'needs-decision', 'failed', null]);
  assert.deepEqual(reports.map(event => event.slot), ['a', 'b', 'c', 'd', 'e']);
  const absorbedReports = absorbed.filter(event => event.type === 'report');
  assert.deepEqual(absorbedReports.map(event => event.verb).sort(), ['paused', 'working']);
  assert.ok(absorbedReports.every(event => event.reason));

  // watermark above everything: no report events at all
  const none = classify(ev({ entries, surfacedTs: NOW }));
  assert.equal(none.surface.filter(event => event.type === 'report').length, 0);
});

test('reports surface oldest first', () => {
  const entries = [
    entry('b', 'failed: second', NOW - 1 * MIN),
    entry('a', 'failed: first', NOW - 2 * MIN),
  ].sort((left, right) => left.ts - right.ts);
  const { surface } = classify(ev({ entries }));
  assert.deepEqual(surface.map(event => event.slot), ['a', 'b']);
});

test('stale-paused: fires strictly past the window, dedups within it, re-fires after it lapses', () => {
  const paused = entry('a', 'paused: waiting on UAT', NOW - 61 * MIN);
  // surfaced long ago (already read as a report) - the state predicate still applies
  const base = { entries: [paused], surfacedTs: NOW - 1 };

  assert.deepEqual(types(classify(ev(base)).surface), ['stale-paused']);
  // boundary: exactly AT the window is not "exceeds"
  const atBoundary = entry('a', 'paused: waiting', NOW - 60 * MIN);
  assert.equal(classify(ev({ entries: [atBoundary], surfacedTs: NOW - 1 })).surface.length, 0);
  // a surfaced fact within the window suppresses...
  const recentFact = { v: 2, ts: NOW - 30 * MIN, slot: 'a', type: 'surfaced', reason: 'stale-paused' };
  const suppressed = classify(ev({ ...base, journal: [recentFact] }));
  assert.equal(suppressed.surface.length, 0);
  assert.ok(suppressed.absorbed.some(event => event.type === 'stale-paused' && event.reason));
  // ...and one older than the window does not: re-fires hourly by construction
  const oldFact = { v: 2, ts: NOW - 61 * MIN, slot: 'a', type: 'surfaced', reason: 'stale-paused' };
  assert.deepEqual(types(classify(ev({ ...base, journal: [oldFact] })).surface), ['stale-paused']);
});

test('stalled-working: report aged + activity not working fires; live activity absorbs; dedup window holds', () => {
  const working = entry('a', 'working: refactor', NOW - 31 * MIN);
  const base = { entries: [working], surfacedTs: NOW - 1 };

  const fired = classify(ev({ ...base, activity: { a: 'idle' } }));
  assert.deepEqual(types(fired.surface), ['stalled-working']);
  // positive evidence of work absorbs
  const alive = classify(ev({ ...base, activity: { a: 'working' } }));
  assert.equal(alive.surface.length, 0);
  assert.ok(alive.absorbed.some(event => event.type === 'stalled-working'));
  // not aged yet: nothing
  const young = entry('a', 'working: refactor', NOW - 30 * MIN);
  assert.equal(classify(ev({ entries: [young], surfacedTs: NOW - 1, activity: { a: 'idle' } })).surface.length, 0);
  // dedup within the window
  const fact = { v: 2, ts: NOW - 10 * MIN, slot: 'a', type: 'surfaced', reason: 'stalled-working' };
  assert.equal(classify(ev({ ...base, activity: { a: 'idle' }, journal: [fact] })).surface.length, 0);
  // snapshot failed: no activity evidence, no stalled verdict
  assert.equal(classify(ev({ ...base, activity: {}, snapshotOk: false })).surface.length, 0);
});

test('crash: claim + BOTH samples down + no terminal report since claim; deduped by claim ts', () => {
  const claim = { ts: NOW - 20 * MIN, task: 'fix flaky test' };
  const slots = [{ slot: 'a', claim }];
  const down = { a: 'none' };

  // both samples agree (none/dead mix counts as down)
  const fired = classify(ev({ slots, workersA: down, workersB: { a: 'dead' } }));
  assert.deepEqual(types(fired.surface), ['crash']);
  assert.equal(fired.surface[0].claimTs, claim.ts);
  // single sample only: not debounced, no crash
  assert.equal(classify(ev({ slots, workersA: down, workersB: null })).surface.length, 0);
  // second sample shows recovery: no crash
  assert.equal(classify(ev({ slots, workersA: down, workersB: { a: 'live' } })).surface.length, 0);
  // snapshot marked failed: never fabricate crash alarms
  assert.equal(classify(ev({ slots, workersA: down, workersB: down, snapshotOk: false })).surface.length, 0);
  // a terminal report since the claim means finished-then-exited, not crashed
  const doneReport = entry('a', 'done: PR #7', NOW - 5 * MIN);
  const finished = classify(ev({ slots, workersA: down, workersB: down, entries: [doneReport], surfacedTs: NOW - 1 }));
  assert.equal(finished.surface.filter(event => event.type === 'crash').length, 0);
  // a non-terminal report since the claim does NOT save it
  const workingReport = entry('a', 'working: on it', NOW - 5 * MIN);
  const stillCrash = classify(ev({ slots, workersA: down, workersB: down, entries: [workingReport], surfacedTs: NOW }));
  assert.equal(stillCrash.surface.filter(event => event.type === 'crash').length, 1);
  // journal fact for THIS claim dedups...
  const fact = { v: 2, ts: NOW - 1 * MIN, slot: 'a', type: 'surfaced', reason: 'crash', claimTs: claim.ts };
  assert.equal(classify(ev({ slots, workersA: down, workersB: down, journal: [fact] })).surface.length, 0);
  // ...but a RE-claimed slot (new claim ts) fires despite the old claim's fact
  const reclaimed = [{ slot: 'a', claim: { ts: NOW - 2 * MIN, task: 'next task' } }];
  assert.deepEqual(types(classify(ev({ slots: reclaimed, workersA: down, workersB: down, journal: [fact] })).surface), ['crash']);
  // unclaimed slot down: nobody's work lost, no crash event
  assert.equal(classify(ev({ slots: [{ slot: 'a', claim: null }], workersA: down, workersB: down })).surface.length, 0);
});

test('killed session: all workers none in both samples fires crash per CLAIMED slot only', () => {
  const slots = [
    { slot: 'a', claim: { ts: NOW - 10 * MIN, task: 'x' } },
    { slot: 'b', claim: { ts: NOW - 12 * MIN, task: 'y' } },
    { slot: 'c', claim: null },
  ];
  const allNone = {}; // vanished panes: slots simply absent from the sample
  const { surface } = classify(ev({ slots, workersA: allNone, workersB: allNone }));
  assert.deepEqual(types(surface), ['crash', 'crash']);
  assert.deepEqual(surface.map(event => event.slot).sort(), ['a', 'b']);
});

test('pr-merged: claim + MERGED + no journal fact; fact dedups; duplicates tolerated; gh failure omits', () => {
  const slots = [{ slot: 'a', claim: { ts: NOW - 30 * MIN, task: 'feat' } }];
  const workers = { a: 'live' };
  const prs = { ok: true, bySlot: { a: [{ number: 42, state: 'MERGED' }, { number: 41, state: 'OPEN' }] } };

  const fired = classify(ev({ slots, workersA: workers, prs }));
  assert.deepEqual(fired.surface, [{ type: 'pr-merged', slot: 'a', pr: 42 }]);
  // fact dedups; duplicate facts read as one
  const fact = { v: 2, ts: NOW - 1 * MIN, slot: 'a', type: 'pr-merged', pr: 42 };
  assert.equal(classify(ev({ slots, workersA: workers, prs, journal: [fact, fact] })).surface.length, 0);
  // failed gh poll: omit pr-based events entirely (never guess from a stale map)
  assert.equal(classify(ev({ slots, workersA: workers, prs: { ok: false, bySlot: {} } })).surface.length, 0);
  // no claim: a merged PR on an unclaimed slot is not a supervision event
  assert.equal(classify(ev({ slots: [{ slot: 'a', claim: null }], workersA: workers, prs })).surface.length, 0);
});

test('watch-degraded: consecutive gh failures at threshold surface (loop-mode liveness aid)', () => {
  assert.equal(classify(ev({ ghFails: 2 })).surface.length, 0);
  assert.deepEqual(types(classify(ev({ ghFails: 3 })).surface), ['watch-degraded']);
});

test('idempotence: same evidence in, same classification out - twice', () => {
  const evidence = ev({
    entries: [
      entry('a', 'blocked: help', NOW - 5 * MIN),
      entry('b', 'working: churning', NOW - 40 * MIN),
      entry('c', 'paused: vendor', NOW - 90 * MIN),
    ],
    surfacedTs: NOW - 6 * MIN,
    slots: [{ slot: 'd', claim: { ts: NOW - 15 * MIN, task: 'z' } }],
    workersA: { d: 'dead' },
    workersB: { d: 'dead' },
    activity: { b: 'idle' },
  });
  const first = classify(evidence);
  const second = classify(evidence);
  assert.deepEqual(first, second);
  assert.deepEqual(types(first.surface).sort(), ['crash', 'report', 'stale-paused', 'stalled-working']);
});

test('classify demands a clock: missing now throws (programming error, not policy)', () => {
  assert.throws(() => classify({ entries: [] }), /now/);
});
