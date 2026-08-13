// test/worktree-doc.test.mjs - the serialized write protocol and turn section of the
// worktree document (.worktree-lock): tmp-mutex, atomic replace, owned-field merge,
// pid-identity liveness, turn claim/release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimIfFree,
  claimTurn,
  parsePidStart,
  pidIdentityLive,
  readDoc,
  readLock,
  readTurn,
  readWorker,
  releaseTurn,
  turnLive,
  writeLock,
  writeWorker,
} from '../lib/slots/locks.mjs';
import { LOCK_FILENAME, LOCK_TMP_FILENAME } from '../lib/constants.mjs';

function scratch(tag) {
  const dir = join(tmpdir(), `sm-wdoc-${tag}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A dead pid with a mismatched identity token: spawn a child that exits immediately.
function deadPid() {
  const res = spawnSync('node', ['-e', ''], { encoding: 'utf8' });
  return res.pid ?? 999999;
}

test('parsePidStart: normalizes ps lstart output, empty/garbage -> null', () => {
  assert.equal(parsePidStart('Mon Jul 28 09:15:02 2026\n'), 'Mon Jul 28 09:15:02 2026');
  assert.equal(parsePidStart('   '), null);
  assert.equal(parsePidStart(''), null);
  assert.equal(parsePidStart(null), null);
});

test('protocol: mutation round-trip preserves untouched sections (through the mutex path)', () => {
  const dir = scratch('roundtrip');
  try {
    writeLock(dir, { session: 's1', task: 'fix sc-1 x' });
    writeWorker(dir, { agent: 'claude', transport: 'pane' });
    writeLock(dir, { session: 's2', task: 'next' }); // re-claim must not eat the worker
    const doc = readDoc(dir);
    assert.equal(doc.claim.session, 's2');
    assert.equal(doc.worker.agent, 'claude');
    assert.equal(existsSync(join(dir, LOCK_TMP_FILENAME)), false); // mutex released
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol: a live-pid tmp blocks mutations with a bounded refusal, not a hang', () => {
  const dir = scratch('livelock');
  process.env.SLOT_DOC_MUTEX_MS = '300'; // shrink the retry budget for the test
  try {
    // a mutex held by THIS process (alive by definition) - with its REAL identity token,
    // because a live pid with a mismatched token correctly reads as a dead (reused) holder
    const lstart = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' });
    writeFileSync(join(dir, LOCK_TMP_FILENAME), JSON.stringify({ pid: process.pid, pidStart: parsePidStart(lstart.stdout), ts: Date.now() }));
    const t0 = Date.now();
    assert.throws(() => writeLock(dir, { session: 's' }), /worktree document is being written|mutation in flight/i);
    assert.ok(Date.now() - t0 < 5000, 'refusal must be bounded');
    assert.equal(existsSync(join(dir, LOCK_FILENAME)), false); // nothing was written
  }
  finally {
    delete process.env.SLOT_DOC_MUTEX_MS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol: a stale tmp (dead pid) is broken by rename and the mutation succeeds', () => {
  const dir = scratch('stale');
  try {
    writeFileSync(join(dir, LOCK_TMP_FILENAME), JSON.stringify({ pid: deadPid(), pidStart: 'gone', ts: 1 }));
    writeLock(dir, { session: 's', task: null });
    assert.equal(readDoc(dir).claim.session, 's');
    // broken artifacts are renamed aside, never blind-unlinked mid-protocol
    const leftovers = readdirSync(dir).filter(name => name.startsWith(`${LOCK_TMP_FILENAME}.broken.`));
    assert.equal(leftovers.length, 1);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol: a crashed write (doc-content tmp, old) is broken by the age gate; reads never corrupt', () => {
  const dir = scratch('crash');
  try {
    writeLock(dir, { session: 'before', task: null });
    // simulate a crash between doc-write and rename: tmp holds doc JSON (no pid fields), aged
    writeFileSync(join(dir, LOCK_TMP_FILENAME), '{"v":2,"cwd":"/x","ts":1,"claim":null,"worker":null,"turn":null}');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(join(dir, LOCK_TMP_FILENAME), old, old);
    assert.equal(readDoc(dir).claim.session, 'before'); // the document itself is untouched
    writeLock(dir, { session: 'after', task: null }); // next mutation breaks the husk and proceeds
    assert.equal(readDoc(dir).claim.session, 'after');
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol: a FRESH unreadable tmp is NOT broken (could be a mid-write peer)', () => {
  const dir = scratch('fresh');
  process.env.SLOT_DOC_MUTEX_MS = '300';
  try {
    writeFileSync(join(dir, LOCK_TMP_FILENAME), 'not-json-yet'); // just-created, age ~0
    assert.throws(() => writeLock(dir, { session: 's' }), /being written|in flight/i);
  }
  finally {
    delete process.env.SLOT_DOC_MUTEX_MS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owned-field merge: writeWorker never nulls a sessionId it did not set', () => {
  const dir = scratch('merge');
  try {
    writeWorker(dir, { agent: 'claude', transport: 'headless', sessionId: 'sess-42' });
    writeWorker(dir, { agent: 'claude', model: 'opus', transport: 'pane' }); // a reload-style rewrite
    const worker = readWorker(dir);
    assert.equal(worker.sessionId, 'sess-42'); // preserved - the writer did not own it
    assert.equal(worker.model, 'opus');
    assert.equal(worker.transport, 'pane');
    writeWorker(dir, { sessionId: 'sess-43' }); // an owning write updates it
    assert.equal(readWorker(dir).sessionId, 'sess-43');
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeLockFull is gone: nothing bypasses the serialized write path', async () => {
  const mod = await import('../lib/slots/locks.mjs');
  assert.equal('writeLockFull' in mod, false);
});

// --- turn section -------------------------------------------------------------------------------

test('turn: claim on an empty doc records pid identity; second claim refuses with holder', () => {
  const dir = scratch('turn');
  try {
    const first = claimTurn(dir, { task: 'run a turn' });
    assert.equal(first.ok, true);
    const turn = readTurn(dir);
    assert.equal(turn.pid, process.pid);
    assert.ok(turn.pidStart);
    assert.equal(turnLive(dir), true);
    const second = claimTurn(dir, { task: 'another' });
    assert.equal(second.ok, false);
    assert.equal(second.holder.pid, process.pid);
    assert.equal(second.holder.task, 'run a turn');
  }
  finally {
    releaseTurn(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn: a dead holder is claimed over in one serialized mutation', () => {
  const dir = scratch('turndead');
  try {
    writeWorker(dir, { agent: 'claude', transport: 'pane' }); // keep the doc alive across turn churn
    const ok = claimTurn(dir, { task: 'x' });
    assert.equal(ok.ok, true);
    // forge a dead holder: overwrite the turn with an exited child's identity
    const doc = readDoc(dir);
    writeFileSync(
      join(dir, LOCK_FILENAME),
      `${JSON.stringify({ ...doc, turn: { pid: deadPid(), pidStart: 'gone', startedAt: 1, task: 'zombie' } })}\n`,
    );
    assert.equal(turnLive(dir), false);
    const reclaimed = claimTurn(dir, { task: 'y' });
    assert.equal(reclaimed.ok, true);
    assert.equal(readTurn(dir).task, 'y');
  }
  finally {
    releaseTurn(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn: release clears only its own claim (verify-before-clear)', () => {
  const dir = scratch('turnrel');
  try {
    writeWorker(dir, { agent: 'claude', transport: 'pane' });
    claimTurn(dir, { task: 'mine' });
    // someone else re-claims (simulate: overwrite with a foreign live-ish identity)
    const doc = readDoc(dir);
    writeFileSync(
      join(dir, LOCK_FILENAME),
      `${JSON.stringify({ ...doc, turn: { pid: process.pid, pidStart: 'FORGED-OTHER', startedAt: 2, task: 'theirs' } })}\n`,
    );
    assert.equal(releaseTurn(dir), false); // identity mismatch: not ours to clear
    assert.equal(readTurn(dir).task, 'theirs');
    // restore our own and release for real
    const cur = readDoc(dir);
    const mine = claimTurnIdentityFix(cur);
    writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(mine)}\n`);
    assert.equal(releaseTurn(dir), true);
    assert.equal(readTurn(dir), null);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Rebuild a doc whose turn carries OUR true identity (matches what claimTurn writes).
function claimTurnIdentityFix(doc) {
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' });
  return { ...doc, turn: { pid: process.pid, pidStart: parsePidStart(probe.stdout), startedAt: 3, task: 'mine' } };
}

test('pidIdentityLive: probes fail toward ALIVE; identity mismatch on a live pid means dead holder', () => {
  const recorded = { pid: 4242, pidStart: 'Mon Jul 28 09:15:02 2026' };
  function throws(code) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  // dead process -> dead
  assert.equal(pidIdentityLive(recorded, { kill: () => throws('ESRCH'), lstart: () => null }), false);
  // EPERM (live process, another uid) -> ALIVE, even when identity is unreadable
  assert.equal(pidIdentityLive(recorded, { kill: () => throws('EPERM'), lstart: () => null }), true);
  // live pid, identity matches -> alive
  assert.equal(pidIdentityLive(recorded, { kill: () => true, lstart: () => recorded.pidStart }), true);
  // live pid, identity MISMATCH -> the recorded holder is dead (pid was reused)
  assert.equal(pidIdentityLive(recorded, { kill: () => true, lstart: () => 'Tue Jul 29 11:00:00 2026' }), false);
  // live pid, ps hiccup (unreadable identity) -> assume alive (fail toward refusing the turn)
  assert.equal(pidIdentityLive(recorded, { kill: () => true, lstart: () => null }), true);
  // a recorded turn with no identity token at all: only pid liveness decides
  assert.equal(pidIdentityLive({ pid: 4242, pidStart: null }, { kill: () => true, lstart: () => 'x' }), true);
});

test('claimIfFree: claims only an unclaimed document; a held claim survives byte-identical', () => {
  const dir = join(tmpdir(), `sm-cif-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(claimIfFree(dir, { session: 's1', task: 'first task' }), true);
    const held = readLock(dir);
    assert.equal(held.session, 's1');
    assert.equal(held.task, 'first task');
    // second claimant refused; the existing claim untouched
    assert.equal(claimIfFree(dir, { session: 's2', task: 'poacher' }), false);
    const after = readLock(dir);
    assert.equal(after.session, 's1');
    assert.equal(after.task, 'first task');
    assert.equal(after.ts, held.ts); // the claim's own stamp did not move
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimIfFree: two concurrent claimants - exactly one winner', async () => {
  const dir = join(tmpdir(), `sm-cif-race-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const locksUrl = new URL('../lib/slots/locks.mjs', import.meta.url).href;
  const script = `import('${locksUrl}').then(m => console.log(m.claimIfFree(process.argv[1], { session: process.argv[2], task: 't' })));`;
  try {
    const { spawn } = await import('node:child_process');
    const runOne = session => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, session], { encoding: 'utf8' });
      let outText = '';
      child.stdout.on('data', chunk => outText += chunk);
      child.on('close', () => resolve(outText.trim()));
    });
    const results = await Promise.all([runOne('a'), runOne('b')]);
    assert.deepEqual(results.slice().sort(), ['false', 'true'], `got ${results}`);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
