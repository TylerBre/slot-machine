// The board is a PURE renderer: plain model in, lines out. No terminal, no timers, no IO -
// the alt-screen driver and the two gather cadences live in the caller and are not tested
// here. Colour is stripped by format.mjs when stdout is not a TTY, so assertions match
// bare text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanBlockedLines, partition, renderBoard, workingLines } from '../lib/slots/board.mjs';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test('partition: only events a human must act on reach NEEDS YOU', () => {
  const { needsYou, fyi } = partition([
    { type: 'report', verb: 'blocked', slot: 'a' },
    { type: 'report', verb: 'done', slot: 'b' },
    { type: 'needs-input', slot: 'c' },
    { type: 'crash', slot: 'd' },
    { type: 'pr-merged', slot: 'e' },
    { type: 'report', verb: 'needs-decision', slot: 'f' },
  ]);
  assert.deepEqual(needsYou.map(event => event.slot), ['a', 'c', 'd', 'f']);
  // done and pr-merged are good news, not a summons - they must not pad the count that
  // the whole display is sorted around.
  assert.deepEqual(fyi.map(event => event.slot), ['b', 'e']);
});

test('workingLines: a slot on a prompt sorts above live work, and stale claims are capped', () => {
  const slots = [
    { slot: 'a', locked: true, worker: 'live', activity: 'idle', claimedAt: NOW - 200 * MIN, task: 'old idle' },
    { slot: 'b', locked: true, worker: 'live', activity: 'working', claimedAt: NOW - 5 * MIN, task: 'real work' },
    { slot: 'c', locked: true, worker: 'live', activity: 'waiting', claimedAt: NOW - 90 * MIN, task: 'on a prompt' },
    { slot: 'd', locked: true, worker: 'dead', activity: '-', claimedAt: NOW - 10 * MIN, task: 'crashed' },
    { slot: 'z', locked: false, worker: 'none', activity: '-', claimedAt: null, task: null },
  ];
  const lines = workingLines(slots, 100);
  // waiting first - it is the one state nothing resolves on its own.
  assert.match(lines[0], /^\s+c\s+waiting/);
  assert.match(lines[1], /^\s+b\s+working/);
  assert.match(lines[2], /^\s+d\s+dead/);
  assert.ok(!lines.some(line => /^\s+z\s/.test(line)), 'unclaimed slots are not "working"');

  // The cap exists because a real fleet accumulates stale locks; without it the one slot
  // that needs something is buried under twenty that do not.
  const many = Array.from({ length: 20 }, (_, index) => ({
    slot: `s${index}`, locked: true, worker: 'live', activity: 'idle', claimedAt: NOW - index * MIN, task: 't',
  }));
  const capped = workingLines(many, 100, 8);
  assert.equal(capped.length, 9, '8 rows plus the summary');
  assert.match(capped.at(-1), /\+12 more claimed/);
});

test('humanBlockedLines: PRs group by reviewer, so one person being the queue is visible', () => {
  const lines = humanBlockedLines([
    { number: 6136, reviewers: ['codelite7'] },
    { number: 6146, reviewers: ['codelite7'] },
    { number: 6412, reviewers: ['codelite7'] },
    { number: 6500, reviewers: [] },
  ], 80);
  const zack = lines.find(line => line.includes('codelite7'));
  assert.match(zack, /3 PRs/, 'the count per person is the point, not the list of PRs');
  assert.match(zack, /#6136 #6146 #6412/);
  assert.match(lines.find(line => line.includes('unassigned')), /1 PR\b/);
  assert.deepEqual(humanBlockedLines([], 80), ['  none']);
});

test('renderBoard: a failed gh poll says unknown, never "none"', () => {
  const base = { repo: 'acme', slots: [], inbox: { unread: 0 }, watch: null, seat: null };
  const degraded = renderBoard({ ...base, prsOk: false, prsBlocked: [] }, 80).join('\n');
  assert.match(degraded, /gh poll failed - unknown this tick/);
  assert.ok(!/^\s+none$/m.test(degraded), '"none" would read as "nothing is blocked"');

  // And the footer must shout when supervision is off - an unseated desk with no daemon
  // delivers nothing, which is otherwise indistinguishable from a quiet fleet.
  const idle = renderBoard({ ...base, prsOk: true, prsBlocked: [] }, 80).join('\n');
  assert.match(idle, /watch NOT armed/);
  assert.match(idle, /seat unclaimed/);
  assert.match(idle, /NEEDS YOU \(0\)/);
});
