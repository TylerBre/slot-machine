// The mirror session manager, against a fake worker: registry-before-pipe + rollback,
// refcount + linger, the sweep, the server cap, pipe-lost, and parent-loop liveness
// while the worker blocks.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMirrorManager, MirrorRefusal } from '../lib/serve/mirror.mjs';

const BASE = join(tmpdir(), `sm-mirror-${process.pid}`);
const LOG = join(BASE, 'fake.log');
const WORKER = new URL('./fixtures/fake-mirror-worker.mjs', import.meta.url);
const REG = () => JSON.parse(readFileSync(join(BASE, 'state', 'mirror-registry.json'), 'utf8'));
let manager;

function freshManager(overrides = {}) {
  return createMirrorManager({
    workerUrl: WORKER,
    pipesMax: 2,
    lingerMs: 120,
    statusPollMs: 80,
    pollDumpMs: 50,
    ...overrides,
  });
}

before(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  process.env.SLOT_SERVE_DIR = join(BASE, 'state');
  process.env.MIRROR_FAKE_LOG = LOG;
});
after(() => {
  rmSync(BASE, { recursive: true, force: true });
  delete process.env.SLOT_SERVE_DIR;
  delete process.env.MIRROR_FAKE_LOG;
});
afterEach(async () => {
  if (manager) {
    await manager.shutdown();
    manager = null;
  }
  rmSync(LOG, { force: true });
});

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

test('registry is written BEFORE the pipe; a pipe failure rolls it back', async () => {
  manager = freshManager();
  await assert.rejects(() => manager.openMirror('r', '/tmp/r', 'failpipe'), (err) => {
    assert.ok(err instanceof MirrorRefusal);
    assert.equal(err.reason, 'pipe-failed');
    return true;
  });
  assert.equal(REG().sessions.length, 0); // rolled back
  assert.equal(existsSync(join(BASE, 'state', 'spools', 'r.failpipe.spool')), false);
  assert.deepEqual(logLines(), ['pipeStart %failpipe']); // the attempt DID happen, after the registry write
});

test('refcount: two viewers share one pipe; linger tears down after the last leaves; rejoin cancels', async () => {
  manager = freshManager();
  const first = await manager.openMirror('r', '/tmp/r', 'a');
  const second = await manager.openMirror('r', '/tmp/r', 'a');
  assert.equal(first.sink, second.sink);
  assert.equal(first.epoch, second.epoch);
  assert.equal(first.mode, 'pipe');
  assert.deepEqual(logLines(), ['pipeStart %a', 'seed %a']); // ONE pipe (+ its screen seed)
  await sleep(80);
  assert.ok(readFileSync(first.sink, 'utf8').includes('FAKE-PANE-BYTES')); // bytes flow

  manager.closeMirror('r', 'a', first.epoch);
  await sleep(200); // past linger - but one viewer remains
  assert.equal(REG().sessions.length, 1);
  // rejoin during linger cancels teardown
  manager.closeMirror('r', 'a', first.epoch);
  await sleep(40); // inside the linger window
  await manager.openMirror('r', '/tmp/r', 'a');
  await sleep(200);
  assert.equal(REG().sessions.length, 1, 'rejoin during linger must cancel teardown');
  assert.ok(!logLines().includes('pipeStop %a'));
  // final close: linger expires, pipe stops, registry + spool cleaned
  manager.closeMirror('r', 'a', first.epoch);
  await sleep(220);
  assert.ok(logLines().includes('pipeStop %a'));
  assert.equal(REG().sessions.length, 0);
  assert.equal(existsSync(first.sink), false);
});

test('server cap: the third concurrent mirror refuses with server-cap', async () => {
  manager = freshManager();
  await manager.openMirror('r', '/tmp/r', 'a');
  await manager.openMirror('r', '/tmp/r', 'b');
  await assert.rejects(() => manager.openMirror('r', '/tmp/r', 'c'), (err) => {
    assert.equal(err.reason, 'server-cap');
    return true;
  });
});

test('unknown slot refuses with slot-gone; a no-stream backend falls back to poll mode', async () => {
  manager = freshManager();
  await assert.rejects(() => manager.openMirror('r', '/tmp/r', 'gone'), (err) => {
    assert.equal(err.reason, 'slot-gone');
    return true;
  });
  const polled = await manager.openMirror('r', '/tmp/r', 'nostream');
  assert.equal(polled.mode, 'poll');
  assert.ok(readFileSync(polled.sink, 'utf8').includes('POLLED-FRAME'));
});

test('sweep: dead-holder entries are stopped, removed, and their spools unlinked; live foreign holders kept', async () => {
  manager = freshManager();
  const spools = join(BASE, 'state', 'spools');
  mkdirSync(spools, { recursive: true });
  const deadSink = join(spools, 'r.dead.spool');
  const foreignSink = join(spools, 'r.foreign.spool');
  writeFileSync(deadSink, 'x');
  writeFileSync(foreignSink, 'x');
  writeFileSync(join(BASE, 'state', 'mirror-registry.json'), JSON.stringify({
    v: 1,
    sessions: [
      { repo: 'r', slot: 'dead', paneId: '%dead', sink: deadSink, pid: 999999, pidStart: null, openedAt: 1, mode: 'pipe' },
      { repo: 'r', slot: 'foreign', paneId: '%foreign', sink: foreignSink, pid: process.ppid, pidStart: null, openedAt: 1, mode: 'pipe' },
    ],
  }));
  await manager.sweep();
  const kept = REG().sessions;
  assert.deepEqual(kept.map(entry => entry.slot), ['foreign']); // fail toward alive
  assert.equal(existsSync(deadSink), false);
  assert.equal(existsSync(foreignSink), true);
  assert.ok(logLines().includes('pipeStop %dead'));
  // leave no residue for later tests: the surviving foreign entry is this test's fixture
  writeFileSync(join(BASE, 'state', 'mirror-registry.json'), JSON.stringify({ v: 1, sessions: [] }));
  rmSync(foreignSink, { force: true });
});

test('pipe-lost: a dead pipe is detected, surfaced with its epoch, and torn down', async () => {
  manager = freshManager();
  const opened = await manager.openMirror('r', '/tmp/r', 'a');
  try {
    const lost = new Promise(resolvePromise => manager.events.once('pipe-lost', resolvePromise));
    writeFileSync(`${opened.sink}.dead`, ''); // the fake's not-piped signal
    const detail = await lost;
    assert.deepEqual(detail, { repo: 'r', slot: 'a', epoch: opened.epoch });
    // teardown includes a worker round-trip after the emit; poll instead of guessing a delay
    const deadline = Date.now() + 1500;
    while (REG().sessions.length > 0 && Date.now() < deadline)
      await sleep(30);
    assert.equal(REG().sessions.length, 0);
  }
  finally {
    rmSync(`${opened.sink}.dead`, { force: true }); // a leaked .dead poisons later tests
  }
});

test('parent loop stays live while the worker blocks (the whole point of the worker thread)', async () => {
  manager = freshManager();
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 25);
  await manager.openMirror('r', '/tmp/r', 'slowpane'); // the fake worker SPINS 300ms
  clearInterval(ticker);
  assert.ok(ticks >= 6, `parent event loop must tick through a blocking worker call (got ${ticks})`);
});

test('concurrent same-key opens JOIN one session: one pipe, refs counted per viewer, cap honest', async () => {
  manager = freshManager();
  const [first, second] = await Promise.all([
    manager.openMirror('r', '/tmp/r', 'a'),
    manager.openMirror('r', '/tmp/r', 'a'),
  ]);
  assert.equal(first.epoch, second.epoch); // one session, two viewers
  assert.equal(manager.sessionCount(), 1);
  assert.equal(REG().sessions.length, 1);
  assert.equal(logLines().filter(line => line === 'pipeStart %a').length, 1);
  manager.closeMirror('r', 'a', first.epoch);
  await sleep(200);
  assert.equal(REG().sessions.length, 1, 'one close of two viewers must not tear down');
  manager.closeMirror('r', 'a', second.epoch);
  await sleep(220);
  assert.equal(REG().sessions.length, 0);
  // the cap holds under a concurrent stampede of DISTINCT slots (pipesMax 2)
  const results = await Promise.allSettled([
    manager.openMirror('r', '/tmp/r', 'w'),
    manager.openMirror('r', '/tmp/r', 'x'),
    manager.openMirror('r', '/tmp/r', 'y'),
    manager.openMirror('r', '/tmp/r', 'z'),
  ]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const refused = results.filter(result => result.status === 'rejected' && result.reason.reason === 'server-cap');
  assert.equal(fulfilled.length, 2, 'exactly the cap');
  assert.equal(refused.length, 2, 'the rest refused server-cap');
});

test('a stale-epoch close never debits the successor session', async () => {
  manager = freshManager();
  const firstOpen = await manager.openMirror('r', '/tmp/r', 'a');
  // the pipe dies; the manager tears the session down
  const spool = firstOpen.sink;
  writeFileSync(`${spool}.dead`, '');
  await new Promise(resolvePromise => manager.events.once('pipe-lost', resolvePromise));
  rmSync(`${spool}.dead`, { force: true });
  const deadline = Date.now() + 1500;
  while (REG().sessions.length > 0 && Date.now() < deadline) await sleep(30);
  // a successor session opens fresh, with a live viewer
  const secondOpen = await manager.openMirror('r', '/tmp/r', 'a');
  assert.notEqual(secondOpen.epoch, firstOpen.epoch);
  // the FIRST viewer's cleanup finally runs - it must not touch the successor
  manager.closeMirror('r', 'a', firstOpen.epoch);
  await sleep(220);
  assert.equal(REG().sessions.length, 1, 'the successor survives a stale-epoch close');
  manager.closeMirror('r', 'a', secondOpen.epoch);
});

test('a crashed worker is a refusal, not a process death; the next ask respawns', async () => {
  manager = freshManager();
  await assert.rejects(() => manager.openMirror('r', '/tmp/r', 'crash'), (err) => {
    assert.ok(err instanceof MirrorRefusal, `got ${err.constructor.name}: ${err.message}`);
    return true;
  });
  // the manager survives and a fresh worker serves the next open
  const recovered = await manager.openMirror('r', '/tmp/r', 'a');
  assert.equal(recovered.mode, 'pipe');
  manager.closeMirror('r', 'a', recovered.epoch);
});

test('rotate: serialized, epoch-guarded, reseeds, and announces rotated', async () => {
  manager = freshManager();
  const opened = await manager.openMirror('r', '/tmp/r', 'a');
  const rotated = new Promise(resolvePromise => manager.events.once('rotated', resolvePromise));
  await manager.rotate('r', 'a');
  const detail = await rotated;
  assert.deepEqual(detail, { repo: 'r', slot: 'a', epoch: opened.epoch });
  // pipe restarted + a fresh seed after the rotate (open seeded once already)
  assert.equal(logLines().filter(line => line === 'seed %a').length, 2);
  assert.equal(logLines().filter(line => line === 'pipeStart %a').length, 2);
  // ifOverBytes: a co-viewer's duplicate trigger no-ops on the now-small spool
  await manager.rotate('r', 'a', { ifOverBytes: 10_000_000 });
  assert.equal(logLines().filter(line => line === 'pipeStart %a').length, 2, 'no rotate under the threshold');
  manager.closeMirror('r', 'a', opened.epoch);
});
