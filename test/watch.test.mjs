// sm watch: hermetic tests for the check/ack digest core, the armed marker, and the
// blocking loop. The live world is injected (`world`); inbox/journal/cursor state rides
// the env seams into tmp dirs - no mux, no gh, no real fleet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_NAME } from '../lib/constants.mjs';
import { appendReport, readCursor, readInbox } from '../lib/inbox.mjs';
import { readJournal } from '../lib/slots/journal.mjs';
import { cmdWatch, hasSeat, readArmed, readSeat, runCheck, runHook, runWatchBlocking } from '../lib/commands/watch.mjs';

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

test('hook path: seat-gated (SM_DESK), blocks a stop via exit 2 + stderr, budget degrades-allow, resets on a clean pass', async () => {
  const dirs = fresh('hook');
  const realDesk = process.env.SM_DESK;
  try {
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() })); // baseline

    // no seat marker: silent no-action, and NO ack happened
    delete process.env.SM_DESK;
    appendReport(REPO_NAME, { slot: 'a', message: 'blocked: gated?' });
    const before = readCursor(REPO_NAME, 'surfaced');
    const gated = await runHook({ type: 'stop', world: quietWorld() });
    assert.deepEqual(gated, { exitCode: 0, out: '', errText: '' });
    assert.equal(readCursor(REPO_NAME, 'surfaced'), before); // peeked nothing, acked nothing

    // seated: the same event blocks the stop per the documented protocol (exit 2 + stderr)
    process.env.SM_DESK = '1';
    const blocked = await runHook({ type: 'stop', world: quietWorld() });
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.errText, /needs attention before stopping/);
    assert.match(blocked.errText, /blocked: gated\?/);
    assert.equal(blocked.out, '');
    assert.ok(readCursor(REPO_NAME, 'surfaced') > before); // and it acked what it delivered

    // consecutive blocks exhaust the budget -> degraded-allow as context (exit 0 + JSON)
    for (let index = 0; index < 2; index++) {
      appendReport(REPO_NAME, { slot: 'a', message: `blocked: again ${index}` });
      const again = await runHook({ type: 'stop', world: quietWorld() });
      assert.equal(again.exitCode, 2);
    }
    appendReport(REPO_NAME, { slot: 'a', message: 'blocked: one too many' });
    const allowed = await runHook({ type: 'stop', world: quietWorld() });
    assert.equal(allowed.exitCode, 0);
    const parsed = JSON.parse(allowed.out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(parsed.hookSpecificOutput.additionalContext, /block budget exhausted/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /one too many/);

    // a clean (quiet) pass resets the budget: the next event blocks again
    const quiet = await runHook({ type: 'stop', world: quietWorld() });
    assert.equal(quiet.exitCode, 0);
    appendReport(REPO_NAME, { slot: 'a', message: 'blocked: fresh after reset' });
    const blocksAgain = await runHook({ type: 'stop', world: quietWorld() });
    assert.equal(blocksAgain.exitCode, 2);
  }
  finally {
    if (realDesk === undefined)
      delete process.env.SM_DESK;
    else process.env.SM_DESK = realDesk;
    cleanup(dirs);
  }
});

test('hook path: prompt-submit delivers as additionalContext, never blocks, ignores the budget', async () => {
  const dirs = fresh('hookps');
  const realDesk = process.env.SM_DESK;
  try {
    process.env.SM_DESK = '1';
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() })); // baseline
    appendReport(REPO_NAME, { slot: 'b', message: 'needs-decision: A or B?' });
    const delivered = await runHook({ type: 'prompt-submit', world: quietWorld() });
    assert.equal(delivered.exitCode, 0);
    assert.equal(delivered.errText, '');
    const parsed = JSON.parse(delivered.out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /needs-decision: A or B\?/);
    // quiet fleet: silent no-action
    const quiet = await runHook({ type: 'prompt-submit', world: quietWorld() });
    assert.deepEqual(quiet, { exitCode: 0, out: '', errText: '' });
  }
  finally {
    if (realDesk === undefined)
      delete process.env.SM_DESK;
    else process.env.SM_DESK = realDesk;
    cleanup(dirs);
  }
});

test('desk seat: a claimed seat opens the hook path without SM_DESK, and dies with its session', async () => {
  const dirs = fresh('seat');
  const realDesk = process.env.SM_DESK;
  try {
    delete process.env.SM_DESK;
    assert.equal(readSeat(REPO_NAME), null, 'no seat to start');
    assert.equal(hasSeat(REPO_NAME), false);

    // Baseline the backlog first, or the first ack spends itself setting the watermark
    // instead of emitting - that is the check/ack contract, not a seat concern.
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() }));

    // The gap this closes: unseated, the hook is silent and acks nothing, and before the
    // seat file existed the ONLY way to open it was relaunching under SM_DESK=1.
    appendReport(REPO_NAME, { slot: 'a', message: 'blocked: needs a desk' });
    const before = readCursor(REPO_NAME, 'surfaced');
    assert.deepEqual(await runHook({ type: 'stop', world: quietWorld() }), { exitCode: 0, out: '', errText: '' });
    assert.equal(readCursor(REPO_NAME, 'surfaced'), before, 'unseated acks nothing');

    // Claim it for a pid that is definitely alive - this process.
    await silent(() => cmdWatch(['--seat', '--pid', String(process.pid)]));
    const seat = readSeat(REPO_NAME);
    assert.equal(seat.pid, process.pid);
    assert.equal(hasSeat(REPO_NAME), true);

    // Same event now blocks the stop, with no env var anywhere.
    assert.equal(process.env.SM_DESK, undefined);
    const blocked = await runHook({ type: 'stop', world: quietWorld() });
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.errText, /blocked: needs a desk/);
    assert.ok(readCursor(REPO_NAME, 'surfaced') > before, 'seated delivery acks');

    // A seat whose session is gone reads as unclaimed - no manual sweep, no stale seat
    // silently holding delivery hostage after a crash.
    writeFileSync(
      join(`${dirs.inbox}-state`, `${REPO_NAME || 'default'}.desk-seat.json`),
      `${JSON.stringify({ pid: 2147483646, startedAt: Date.now() })}\n`,
    );
    assert.equal(readSeat(REPO_NAME), null, 'dead holder = unclaimed');
    assert.equal(hasSeat(REPO_NAME), false);

    // ...and SM_DESK still works on its own, so every existing launcher is untouched.
    process.env.SM_DESK = '1';
    assert.equal(hasSeat(REPO_NAME), true);
    delete process.env.SM_DESK;

    // Release is idempotent and actually closes the gate.
    await silent(() => cmdWatch(['--seat', '--pid', String(process.pid)]));
    assert.equal(hasSeat(REPO_NAME), true);
    await silent(() => cmdWatch(['--unseat']));
    assert.equal(readSeat(REPO_NAME), null);
    await silent(() => cmdWatch(['--unseat']));
    assert.equal(hasSeat(REPO_NAME), false);
  }
  finally {
    if (realDesk === undefined)
      delete process.env.SM_DESK;
    else process.env.SM_DESK = realDesk;
    cleanup(dirs);
  }
});

test('watch --baseline: skips the watermark past a stale backlog in one shot, non-destructively', async () => {
  const dirs = fresh('baseline');
  try {
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() })); // set an initial watermark
    // A backlog bigger than one digest: draining via --ack alone would take several cycles,
    // and through the Stop hook that is several blocked stops - the thing this avoids.
    for (let index = 0; index < 12; index++)
      appendReport(REPO_NAME, { slot: 'a', message: `blocked: stale ${index}` });

    const { result: capped } = await silent(() => runCheck({ world: quietWorld() }));
    assert.equal(capped.emitted.length, 5);
    assert.equal(capped.overflow, 7); // 12 waiting, one digest cannot hold them

    await silent(() => cmdWatch(['--baseline']));

    // Nothing left to surface, in ONE step rather than three ack cycles.
    const { result: after } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.equal(after.exitCode, 3);
    // Non-destructive: the reports are still there to read.
    assert.equal(readInbox(REPO_NAME).length, 13);
    // And a genuinely new report still surfaces afterwards.
    appendReport(REPO_NAME, { slot: 'b', message: 'blocked: fresh one' });
    const { result: fresh3 } = await silent(() => runCheck({ ack: true, world: quietWorld() }));
    assert.deepEqual(fresh3.emitted.map(event => event.message), ['blocked: fresh one']);
  }
  finally {
    cleanup(dirs);
  }
});

test('blocking watch survives a failing tick instead of ending supervision silently', async () => {
  const dirs = fresh('resilient');
  const realError = console.error;
  const errs = [];
  console.error = line => errs.push(String(line));
  try {
    // A world that throws once, then behaves. Before the per-tick catch, the throw
    // escaped the while and runWatchBlocking returned as if nothing was wrong - a dead
    // watch is indistinguishable from a quiet fleet, which is why this matters.
    let ticks = 0;
    const flaky = () => {
      ticks += 1;
      if (ticks === 1)
        throw new Error('gh exploded');
      return quietWorld();
    };
    const boom = {
      get slots() {
        return flaky().slots;
      },
      workersA: {},
      workersB: null,
      activity: {},
      snapshotOk: true,
      prs: { ok: true, bySlot: {} },
    };

    // Baseline first: the very first ack sets the watermark rather than emitting, and
    // would otherwise swallow the report this test is waiting on.
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() }));

    // The report must land WHILE the loop waits: waitForReports baselines on the newest
    // entry at call time, so anything appended beforehand is not "new" and the wait
    // would simply run to timeout.
    const landing = setTimeout(appendReport, 150, REPO_NAME, { slot: 'a', message: 'blocked: after the bad tick' });
    const started = Date.now();
    const { result: code } = await silent(() => runWatchBlocking({ loop: false, timeoutMs: 6000, world: boom }));
    const elapsed = Date.now() - started;
    clearTimeout(landing);

    assert.equal(code, 0, 'the watch recovered and still surfaced the report');
    assert.ok(ticks > 1, 'it ticked again after the throw');
    assert.match(errs.join('\n'), /check failed, retrying/);
    // The retry must SKIP the wait. Without that, recovery costs a full waitForReports
    // window (the 6s timeout here) because the failed tick already consumed the report
    // that would have woken it - the event sits stranded behind a wait for an unrelated
    // one. Anything near the timeout means the skip regressed.
    assert.ok(elapsed < 3000, `recovery should not wait out the window (took ${elapsed}ms)`);
    assert.equal(readArmed(REPO_NAME), null, 'and it still cleared its armed marker');
  }
  finally {
    console.error = realError;
    cleanup(dirs);
  }
});

test('seat baton: the daemon peeks while a desk holds the seat, and delivers when it does not', async () => {
  const dirs = fresh('baton');
  const realDesk = process.env.SM_DESK;
  try {
    delete process.env.SM_DESK;
    appendReport(REPO_NAME, { slot: 'z', message: 'seed' });
    await silent(() => runCheck({ ack: true, world: quietWorld() })); // baseline

    // Desk seated: the hook path owns delivery, so a daemon tick must NOT consume the
    // event. Two acking watchers split events and the loser sees a quiet fleet - the
    // failure is silence, which is why this is pinned rather than left to review.
    await silent(() => cmdWatch(['--seat', '--pid', String(process.pid)]));
    const before = readCursor(REPO_NAME, 'surfaced');
    const landingA = setTimeout(appendReport, 100, REPO_NAME, { slot: 'a', message: 'blocked: while seated' });
    await silent(() => runWatchBlocking({ loop: false, timeoutMs: 4000, world: quietWorld(), mode: 'daemon' }));
    clearTimeout(landingA);
    assert.equal(readCursor(REPO_NAME, 'surfaced'), before, 'seated: the daemon peeked and acked nothing');

    // Seat released: the daemon is now the only reader, so it delivers.
    await silent(() => cmdWatch(['--unseat']));
    const landingB = setTimeout(appendReport, 100, REPO_NAME, { slot: 'b', message: 'blocked: while unseated' });
    await silent(() => runWatchBlocking({ loop: false, timeoutMs: 4000, world: quietWorld(), mode: 'daemon' }));
    clearTimeout(landingB);
    assert.ok(readCursor(REPO_NAME, 'surfaced') > before, 'unseated: the daemon acked');

    // THE hasSeat TRAP, pinned. SM_DESK=1 in the DAEMON's own env says nothing about
    // whether a desk is sitting anywhere - hasSeat() would read the caller's env and
    // conclude a desk exists, so the daemon would stop acking and nobody would deliver.
    // Only a seat FILE means a desk. This is why the baton calls readSeat, not hasSeat.
    process.env.SM_DESK = '1';
    const beforeTrap = readCursor(REPO_NAME, 'surfaced');
    const landingC = setTimeout(appendReport, 100, REPO_NAME, { slot: 'c', message: 'blocked: SM_DESK set, no seat file' });
    await silent(() => runWatchBlocking({ loop: false, timeoutMs: 4000, world: quietWorld(), mode: 'daemon' }));
    clearTimeout(landingC);
    delete process.env.SM_DESK;
    assert.ok(
      readCursor(REPO_NAME, 'surfaced') > beforeTrap,
      'SM_DESK in the daemon env must NOT be read as a seated desk - it would silence delivery',
    );
  }
  finally {
    if (realDesk === undefined)
      delete process.env.SM_DESK;
    else process.env.SM_DESK = realDesk;
    cleanup(dirs);
  }
});

test('armed marker carries its mode, so a foreground loop cannot clobber a live daemon', async () => {
  const dirs = fresh('mode');
  try {
    const landing = setTimeout(appendReport, 100, REPO_NAME, { slot: 'a', message: 'done: x' });
    const run = runWatchBlocking({ loop: true, timeoutMs: 900, world: quietWorld(), mode: 'daemon' });
    await new Promise(resolve => setTimeout(resolve, 250));
    const armed = readArmed(REPO_NAME);
    assert.equal(armed.mode, 'daemon', 'the marker says what kind of watch holds it');
    assert.equal(armed.pid, process.pid);
    await run;
    clearTimeout(landing);
    assert.equal(readArmed(REPO_NAME), null, 'and it is cleared on exit');
  }
  finally {
    cleanup(dirs);
  }
});
