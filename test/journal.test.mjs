// test/journal.test.mjs - the per-repo turn journal: fsync'd appends, tolerant reads across
// rotation generations, rename-based rotation that fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, journalSize, readJournal, rotateJournalIfNeeded } from '../lib/slots/journal.mjs';
import { readWorker } from '../lib/slots/locks.mjs';
import { journalDispatch, recordWorker } from '../lib/commands/shared.mjs';

function freshJournalDir(tag) {
  const dir = join(tmpdir(), `sm-journal-${tag}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.SLOT_JOURNAL_DIR = dir;
  return dir;
}
function cleanup(dir) {
  delete process.env.SLOT_JOURNAL_DIR;
  delete process.env.SLOT_JOURNAL_MAX_BYTES;
  rmSync(dir, { recursive: true, force: true });
}

test('journal: append/read round-trip validates, stamps v/ts, preserves order', () => {
  const dir = freshJournalDir('rt');
  try {
    appendJournal('t', { slot: 'a', type: 'worker-created', agent: 'claude', transport: 'pane' });
    appendJournal('t', { slot: 'a', type: 'task-dispatched', task: 'fix sc-1', submitted: true });
    const got = readJournal('t');
    assert.equal(got.length, 2);
    assert.equal(got[0].type, 'worker-created');
    assert.equal(got[1].type, 'task-dispatched');
    assert.equal(got[0].v, 1);
    assert.equal(typeof got[0].ts, 'number');
    // note: fsync durability itself is not black-box unit-testable (page-cache coherence makes
    // fresh-fd reads pass regardless); the fsync call is pinned by code review to spec invariant 5.
  }
  finally {
    cleanup(dir);
  }
});

test('journal: an invalid record type refuses at append; a corrupt line is skipped on read', () => {
  const dir = freshJournalDir('bad');
  try {
    assert.throws(() => appendJournal('t', { slot: 'a', type: 'made-up-type' }), /invalid record/);
    appendJournal('t', { slot: 'a', type: 'worker-created' });
    appendFileSync(join(dir, 't.jsonl'), 'not json at all\n{"half": \n');
    appendJournal('t', { slot: 'b', type: 'worker-created' });
    const got = readJournal('t');
    assert.deepEqual(got.map(rec => rec.slot), ['a', 'b']); // the corruption did not take neighbors down
  }
  finally {
    cleanup(dir);
  }
});

test('journal: rotation renames to .1 and reads span both generations', () => {
  const dir = freshJournalDir('rot');
  process.env.SLOT_JOURNAL_MAX_BYTES = '200'; // force rotation fast
  try {
    const first = appendJournal('t', { slot: 'a', type: 'worker-created' });
    appendJournal('t', { slot: 'a', type: 'task-dispatched', task: 'x'.repeat(200), submitted: true }); // blows the cap -> rotates
    assert.equal(existsSync(join(dir, 't.jsonl.1')), true); // rotated by rename
    appendJournal('t', { slot: 'b', type: 'worker-created' }); // fresh live file
    const all = readJournal('t', { sinceTs: first.ts });
    assert.equal(all.length, 3); // cursor predates the live file -> the rotated generation is consulted
    const tail = readJournal('t', { tail: 2 });
    assert.equal(tail.length, 2);
    assert.equal(tail[1].slot, 'b');
  }
  finally {
    cleanup(dir);
  }
});

test('journal: rotation fails closed while a live rotator holds the lock', () => {
  const dir = freshJournalDir('lock');
  process.env.SLOT_JOURNAL_MAX_BYTES = '10';
  try {
    // a LIVE holder (this process) owns the rotation lock BEFORE any over-cap append
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 't.jsonl.rotating'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    appendJournal('t', { slot: 'a', type: 'worker-created' }); // over the cap; rotation attempted + skipped
    const before = readFileSync(join(dir, 't.jsonl'), 'utf8');
    appendJournal('t', { slot: 'b', type: 'worker-created' }); // append still succeeds
    assert.equal(existsSync(join(dir, 't.jsonl.1')), false); // no rotation happened
    const after = readFileSync(join(dir, 't.jsonl'), 'utf8');
    assert.ok(after.startsWith(before)); // nothing was lost or rewritten
    assert.ok(journalSize('t') > 10); // over cap and untouched - fail closed, not fail proceed
  }
  finally {
    cleanup(dir);
  }
});

test('journal: a dead rotator is broken and rotation proceeds', () => {
  const dir = freshJournalDir('deadrot');
  try {
    appendJournal('t', { slot: 'a', type: 'worker-created' }); // under the default cap: no rotation yet
    writeFileSync(join(dir, 't.jsonl.rotating'), JSON.stringify({ pid: 999999, ts: 1 })); // dead holder
    process.env.SLOT_JOURNAL_MAX_BYTES = '1'; // now everything is over cap
    assert.equal(rotateJournalIfNeeded('t'), true); // broken by rename, rotation proceeds
    assert.equal(existsSync(join(dir, 't.jsonl.1')), true);
  }
  finally {
    cleanup(dir);
  }
});

// --- dispatch/spawn recording helpers (lib/commands/shared.mjs) ----------------------------------
// NOTE: sm msg send requires a live multiplexer session, which the hermetic fixtures cannot
// provide - the wiring is exercised in the plan's live scratch-slot verification; the
// load-bearing recording logic is unit-tested here.

test('recordWorker: journals worker-created once, updates the section on re-record', () => {
  const dir = freshJournalDir('record');
  const slotDir = join(dir, 'slotdir');
  mkdirSync(slotDir, { recursive: true });
  try {
    recordWorker(slotDir, 'a', { agent: 'claude', model: null, transport: 'pane' });
    recordWorker(slotDir, 'a', { agent: 'claude', model: 'opus', transport: 'pane' }); // re-spawn
    // recordWorker journals under the process's resolved REPO_NAME - read whatever file landed
    const journalFile = readdirSync(dir).find(name => name.endsWith('.jsonl'));
    assert.ok(journalFile, 'a journal file was written');
    const records = readFileSync(join(dir, journalFile), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(rec => rec.type === 'worker-created').length, 1); // first time only
    assert.equal(readWorker(slotDir).model, 'opus'); // section updated by the second record
    assert.equal(readWorker(slotDir).agent, 'claude');
  }
  finally {
    cleanup(dir);
  }
});

test('recordWorker/journalDispatch: journal failure degrades to a warning, never blocks', () => {
  const dir = freshJournalDir('degrade');
  const slotDir = join(dir, 'slotdir');
  mkdirSync(slotDir, { recursive: true });
  // make the journal unwritable: point the dir seam at a FILE
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, 'x');
  process.env.SLOT_JOURNAL_DIR = blocker;
  try {
    recordWorker(slotDir, 'a', { agent: 'claude', transport: 'pane' }); // must not throw
    assert.equal(readWorker(slotDir).agent, 'claude'); // the document write still happened
    journalDispatch('a', 'a task'); // must not throw either
  }
  finally {
    cleanup(dir);
  }
});
