// sm watch: hermetic tests for the check/ack digest core, the armed marker, and the
// blocking loop. The live world is injected (`world`); inbox/journal/cursor state rides
// the env seams into tmp dirs - no mux, no gh, no real fleet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_NAME } from '../lib/constants.mjs';
import { appendReport, readCursor } from '../lib/inbox.mjs';
import { readJournal } from '../lib/slots/journal.mjs';
import { readArmed, runCheck, runWatchBlocking } from '../lib/commands/watch.mjs';

const quietWorld = () => ({ slots: [], workersA: {}, workersB: null, activity: {}, snapshotOk: true, prs: { ok: true, bySlot: {} } });

function fresh(tag) {
  const base = join(tmpdir(), `sm-watch-${tag}-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  rmSync(`${base}-inbox-state`, { recursive: true, force: true });
  const inbox = join(base, 'inbox');
  const journal = join(base, 'journal');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(journal, { recursive: true });
  process.env.SLOT_INBOX_DIR = inbox;
  process.env.SLOT_JOURNAL_DIR = journal;
  return { base, inbox, journal };
}
function cleanup({ base, inbox }) {
  rmSync(base, { recursive: true, force: true });
  rmSync(`${inbox}-state`, { recursive: true, force: true });
  delete process.env.SLOT_INBOX_DIR;
  delete process.env.SLOT_JOURNAL_DIR;
}
// Capture the digest lines a call prints.
async function silent(fn) {
  const real = console.log;
  const out = [];
  console.log = line => out.push(String(line));
  try {
    return { result: await fn(), out };
  }
  finally {
    console.log = real;
  }
}

test('watch --check: peek emits report events, exit 0; repeated peeks identical; nothing -> exit 3', async () => {
  const dirs = fresh('peek');
  try {
    // empty world, empty inbox: nothing to report
    const { result: nothing } = await silent(() => runCheck({ world: quietWorld() }));
    assert.equal(nothing.exitCode, 3);
    assert.equal(nothing.emitted.length, 0);

    appendReport(REPO_NAME, { slot: 'a', message: 'blocked: need creds' });
    appendReport(REPO_NAME, { slot: 'b', message: 'plain message, no verb' });
    const { result: first, out } = await silent(() => runCheck({ world: quietWorld() }));
    assert.equal(first.exitCode, 0);
    assert.deepEqual(first.emitted.map(event => [event.type, event.verb]), [['report', 'blocked'], ['report', null]]);
    assert.equal(out.length, 2); // one line per event, no overflow line
    // a peek changes NOTHING: watermark still absent, second peek identical
    assert.equal(readCursor(REPO_NAME, 'surfaced'), 0);
    const { result: second } = await silent(() => runCheck({ world: quietWorld() }));
    assert.deepEqual(second.emitted, first.emitted);
    assert.equal(readJournal(REPO_NAME).length, 0); // and journals nothing
  }
  finally {
    cleanup(dirs);
  }
});

test('watch --check --ack: first ack baselines the backlog; then acks drain, dedup, and isolate cursors', async () => {
  const dirs = fresh('ack');
  try {
    appendReport(REPO_NAME, { slot: 'a', message: 'old backlog report' });
    // FIRST ack with no watermark: baseline note, no event deluge
    const { result: baseline } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.equal(baseline.exitCode, 0);
    assert.equal(baseline.emitted.length, 0);
    assert.match(baseline.notes[0], /baseline set: 1 existing report/);
    assert.ok(readCursor(REPO_NAME, 'surfaced') > 0);

    // new reports surface and ack durably
    appendReport(REPO_NAME, { slot: 'a', message: 'done: PR #12, 95%' });
    const fresh2 = appendReport(REPO_NAME, { slot: 'b', message: 'failed: cannot repro' });
    const { result: acked } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.equal(acked.emitted.length, 2);
    assert.equal(readCursor(REPO_NAME, 'surfaced'), fresh2.ts); // watermark = newest EMITTED report
    const facts = readJournal(REPO_NAME);
    assert.deepEqual(facts.map(rec => rec.type), ['delivered']); // report events need no surfaced fact
    assert.equal(facts[0].count, 2);
    // ack never touches the READ cursor (surfaced != read)
    assert.equal(readCursor(REPO_NAME, 'read'), 0);
    // nothing new: exit 3
    const { result: drained } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.equal(drained.exitCode, 3);
  }
  finally {
    cleanup(dirs);
  }
});

test('digest cap: 5 lines oldest-first + overflow pointer; later acks drain the rest', async () => {
  const dirs = fresh('cap');
  try {
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() })); // baseline past the seed
    for (let index = 0; index < 8; index++)
      appendReport(REPO_NAME, { slot: 'a', message: `blocked: item ${index}` });

    const { result: first, out } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.equal(first.emitted.length, 5);
    assert.equal(first.overflow, 3);
    assert.deepEqual(first.emitted.map(event => event.message), [0, 1, 2, 3, 4].map(index => `blocked: item ${index}`)); // oldest first
    assert.match(out.at(-1), /and 3 more - sm msg inbox --unread/);
    // watermark advanced only through the EMITTED five: the next ack drains the rest
    const { result: second } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.deepEqual(second.emitted.map(event => event.message), [5, 6, 7].map(index => `blocked: item ${index}`));
    assert.equal(second.overflow, 0);
    const { result: third } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.equal(third.exitCode, 3);
  }
  finally {
    cleanup(dirs);
  }
});

test('state events: ack journals the dedup facts (crash carries claimTs); journal failure degrades to a note', async () => {
  const dirs = fresh('facts');
  try {
    const crashWorld = claimTs => ({
      ...quietWorld(),
      slots: [{ slot: 'a', claim: { ts: claimTs, task: 'fix the thing' } }],
      workersA: { a: 'none' },
      workersB: { a: 'none' },
    });
    const { result: fired } = await silent(() => runCheck({ ack: true, world: crashWorld(111) }));
    assert.deepEqual(fired.emitted.map(event => event.type), ['crash']);
    const facts = readJournal(REPO_NAME);
    assert.deepEqual(facts.map(rec => rec.type), ['surfaced', 'delivered']);
    assert.equal(facts[0].claimTs, 111);
    // same claim again: the journal fact dedups it
    const { result: deduped } = await silent(() => runCheck({ ack: true, world: crashWorld(111) }));
    assert.equal(deduped.exitCode, 3);

    // unwritable journal: the digest still emits, with a note - attention outranks durability
    process.env.SLOT_JOURNAL_DIR = join(dirs.base, 'journal', `${REPO_NAME || 'default'}.jsonl`); // a FILE, not a dir
    const { result: degraded } = await silent(() => runCheck({ ack: true, world: crashWorld(222) }));
    assert.equal(degraded.exitCode, 0);
    assert.deepEqual(degraded.emitted.map(event => event.type), ['crash']);
    assert.match(degraded.notes.join('\n'), /journal append failed/);
  }
  finally {
    cleanup(dirs);
  }
});

test('gh/mux degradation notes: prs.ok false and snapshotOk false say so in the digest', async () => {
  const dirs = fresh('degrade');
  try {
    const world = { ...quietWorld(), snapshotOk: false, prs: { ok: false, bySlot: {} } };
    const { result } = await silent(() => runCheck({ world }));
    assert.equal(result.exitCode, 0); // the notes ARE the digest
    assert.match(result.notes.join('\n'), /gh poll failed/);
    assert.match(result.notes.join('\n'), /mux snapshot failed/);
  }
  finally {
    cleanup(dirs);
  }
});

test('armed marker: live during a blocking watch, cleared after, dead holders read NOT armed', async () => {
  const dirs = fresh('armed');
  try {
    assert.equal(readArmed(), null);
    const blocking = silent(() => runWatchBlocking({ timeoutMs: 400, world: quietWorld() }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readArmed()?.pid, process.pid); // armed while the loop runs
    const { result: exitCode } = await blocking;
    assert.equal(exitCode, 3); // quiet fleet, timeout
    assert.equal(readArmed(), null); // marker cleared on the way out

    // a stale marker (dead pid) reads NOT armed - floor tells the truth after a kill -9
    const marker = join(`${dirs.inbox}-state`, `${REPO_NAME || 'default'}.watch-armed.json`);
    mkdirSync(`${dirs.inbox}-state`, { recursive: true });
    writeFileSync(marker, JSON.stringify({ pid: 999999, startedAt: 1 }));
    assert.equal(readArmed(), null);
  }
  finally {
    cleanup(dirs);
  }
});

test('blocking watch: wakes on a new report and acks it', async () => {
  const dirs = fresh('wake');
  try {
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() })); // baseline
    setTimeout(appendReport, 120, REPO_NAME, { slot: 'a', message: 'needs-decision: A or B?' });
    const started = Date.now();
    const { result: exitCode } = await silent(() => runWatchBlocking({ timeoutMs: 5000, world: quietWorld() }));
    assert.equal(exitCode, 0);
    assert.ok(Date.now() - started < 4000, 'woke on the report, not the timeout');
    assert.ok(readCursor(REPO_NAME, 'surfaced') > 0); // the blocking watch acks what it prints
  }
  finally {
    cleanup(dirs);
  }
});
