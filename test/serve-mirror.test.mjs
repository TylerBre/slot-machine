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
  assert.equal(first.mode, 'pipe');
  assert.deepEqual(logLines(), ['pipeStart %a', 'seed %a']); // ONE pipe (+ its screen seed)
  await sleep(80);
  assert.ok(readFileSync(first.sink, 'utf8').includes('FAKE-PANE-BYTES')); // bytes flow

  manager.closeMirror('r', 'a');
  await sleep(200); // past linger - but one viewer remains
  assert.equal(REG().sessions.length, 1);
  // rejoin during linger cancels teardown
  manager.closeMirror('r', 'a');
  await sleep(40); // inside the linger window
  await manager.openMirror('r', '/tmp/r', 'a');
  await sleep(200);
  assert.equal(REG().sessions.length, 1, 'rejoin during linger must cancel teardown');
  assert.ok(!logLines().includes('pipeStop %a'));
  // final close: linger expires, pipe stops, registry + spool cleaned
  manager.closeMirror('r', 'a');
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

test('pipe-lost: a dead pipe is detected, surfaced, and torn down', async () => {
  manager = freshManager();
  const opened = await manager.openMirror('r', '/tmp/r', 'a');
  const lost = new Promise(resolvePromise => manager.events.once('pipe-lost', resolvePromise));
  writeFileSync(`${opened.sink}.dead`, ''); // the fake's not-piped signal
  const detail = await lost;
  assert.deepEqual(detail, { repo: 'r', slot: 'a' });
  // teardown includes a worker round-trip after the emit; poll instead of guessing a delay
  const deadline = Date.now() + 1500;
  while (REG().sessions.length > 0 && Date.now() < deadline)
    await sleep(30);
  assert.equal(REG().sessions.length, 0);
  rmSync(`${opened.sink}.dead`, { force: true });
});

test('parent loop stays live while the worker blocks (the whole point of the worker thread)', async () => {
  manager = freshManager();
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 25);
  await manager.openMirror('r', '/tmp/r', 'slowpane'); // the fake worker SPINS 300ms
  clearInterval(ticker);
  assert.ok(ticks >= 6, `parent event loop must tick through a blocking worker call (got ${ticks})`);
});
