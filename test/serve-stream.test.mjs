// The multiplexed SSE stream: cursor-exact resume, live push, tail-N defaults, gap and
// cursor-reset honesty, ka heartbeats, snapshot conflation, and the id-stamping law.
// Real-HTTP tests ride ephemeral servers over tmp state seams; the stall tests drive the
// hub directly through a fake socket.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../lib/constants.mjs';
import { appendReport, clearInbox } from '../lib/inbox.mjs';
import { appendJournal } from '../lib/slots/journal.mjs';
import { createStreamHub, parseVector } from '../lib/serve/stream.mjs';
import { startServe } from '../lib/serve/http.mjs';

const BASE = join(tmpdir(), `sm-serve-stream-${process.pid}`);
const REPO = 'streamrepo';
let serve;
let fixture;

// --- a minimal SSE client over node:http ---------------------------------------------
function sseConnect({ port, token, path }) {
  const events = [];
  const waiters = [];
  let buffer = '';
  let lastId = null;
  const req = request(
    { host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${token}` } },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const cut = buffer.indexOf('\n\n');
          if (cut < 0)
            break;
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const parsed = { event: 'message', id: null, data: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: '))
              parsed.event = line.slice(7);
            else if (line.startsWith('id: '))
              parsed.id = line.slice(4);
            else if (line.startsWith('data: '))
              parsed.data = JSON.parse(line.slice(6));
          }
          if (parsed.id)
            lastId = parsed.id;
          events.push(parsed);
          for (const waiter of [...waiters]) waiter();
        }
      });
    },
  );
  req.end();
  return {
    events,
    lastId: () => lastId,
    close: () => req.destroy(),
    // wait until `count` events of `type` have arrived (or timeout)
    waitFor: (type, count = 1, timeoutMs = 3000) => new Promise((resolvePromise, rejectPromise) => {
      const check = () => {
        if (events.filter(evt => evt.event === type).length >= count) {
          resolvePromise();
          return true;
        }
        return false;
      };
      if (check())
        return;
      const timer = setTimeout(() => rejectPromise(new Error(`timeout waiting for ${count} ${type} (have ${events.map(evt => evt.event).join(',')})`)), timeoutMs);
      waiters.push(() => {
        if (check()) {
          clearTimeout(timer);
          waiters.length = 0;
        }
      });
    }),
  };
}

before(async () => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  process.env.SLOT_SERVE_DIR = join(BASE, 'state');
  process.env.SLOT_INBOX_DIR = join(BASE, 'inbox');
  process.env.SLOT_JOURNAL_DIR = join(BASE, 'journal');
  fixture = join(BASE, 'fake-sm');
  writeFileSync(fixture, `#!/bin/sh
case "$*" in
  *version*) echo '{"slot-machine":"${VERSION}"}' ;;
  *floor*) echo '{"repo":"${REPO}","slots":[{"slot":"a","worker":"live"}],"inbox":{"unread":1,"total":5}}' ;;
  *watch*) echo '{"events":[],"acked":false}'; exit 3 ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(fixture, 0o755);
  serve = await startServe({
    port: 0,
    spawnTarget: fixture,
    repos: { [REPO]: '/tmp/stream-repo' },
    streamIntervals: { floorMs: 150, watchMs: 60_000, kaMs: 120 },
  });
});
after(async () => {
  await serve.close();
  rmSync(BASE, { recursive: true, force: true });
  delete process.env.SLOT_SERVE_DIR;
  delete process.env.SLOT_INBOX_DIR;
  delete process.env.SLOT_JOURNAL_DIR;
});

test('inbox: cursor-exact replay, live push, vector ids advance with delivery', async () => {
  clearInbox(REPO);
  const first = appendReport(REPO, { slot: 'a', message: 'done: one' });
  appendReport(REPO, { slot: 'b', message: 'blocked: two' });
  appendReport(REPO, { slot: 'c', message: 'three' });
  const client = sseConnect({
    port: serve.port,
    token: serve.token,
    path: `/api/v1/repos/${REPO}/stream?channels=inbox&inbox=${first.ts}`,
  });
  try {
    await client.waitFor('inbox', 2);
    const got = client.events.filter(evt => evt.event === 'inbox');
    assert.deepEqual(got.map(evt => evt.data.record.message), ['blocked: two', 'three']); // strictly after the cursor
    assert.equal(got[0].data.verb, 'blocked'); // verb parsed serve-side
    assert.equal(parseVector(got[1].id).inbox, got[1].data.record.ts); // id == delivered-through
    // live push: a new report arrives without polling
    appendReport(REPO, { slot: 'd', message: 'needs-decision: four' });
    await client.waitFor('inbox', 3);
    assert.equal(client.events.filter(evt => evt.event === 'inbox').at(-1).data.record.message, 'needs-decision: four');
  }
  finally {
    client.close();
  }
});

test('tail-N default replays the recent past exactly; a future cursor clamps with cursor-reset', async () => {
  clearInbox(REPO);
  for (let index = 0; index < 60; index++)
    appendReport(REPO, { slot: 'a', message: `report ${index}` });
  const tail = sseConnect({ port: serve.port, token: serve.token, path: `/api/v1/repos/${REPO}/stream?channels=inbox` });
  try {
    await tail.waitFor('inbox', 50);
    const got = tail.events.filter(evt => evt.event === 'inbox');
    assert.equal(got.length, 50); // the tail default, not all 60
    assert.equal(got[0].data.record.message, 'report 10');
  }
  finally {
    tail.close();
  }
  const future = sseConnect({
    port: serve.port,
    token: serve.token,
    path: `/api/v1/repos/${REPO}/stream?channels=inbox&inbox=${Date.now() + 60_000}`,
  });
  try {
    await future.waitFor('cursor-reset', 1);
    appendReport(REPO, { slot: 'z', message: 'after the clamp' });
    await future.waitFor('inbox', 1);
    assert.equal(future.events.filter(evt => evt.event === 'inbox')[0].data.record.message, 'after the clamp');
  }
  finally {
    future.close();
  }
});

test('reconnect across a serve RESTART: a dead serve\'s vector resumes exactly on a new one', async () => {
  clearInbox(REPO);
  appendReport(REPO, { slot: 'a', message: 'before restart' });
  const client = sseConnect({ port: serve.port, token: serve.token, path: `/api/v1/repos/${REPO}/stream?channels=inbox` });
  await client.waitFor('inbox', 1);
  const vector = client.lastId();
  client.close();
  await serve.close();

  appendReport(REPO, { slot: 'b', message: 'landed while serve was dead' });
  appendReport(REPO, { slot: 'c', message: 'this one too' });
  serve = await startServe({
    port: 0,
    spawnTarget: fixture,
    repos: { [REPO]: '/tmp/stream-repo' },
    streamIntervals: { floorMs: 150, watchMs: 60_000, kaMs: 120 },
  });
  const resumed = sseConnect({
    port: serve.port,
    token: serve.token,
    path: `/api/v1/repos/${REPO}/stream?channels=inbox&inbox=${parseVector(vector).inbox}`,
  });
  try {
    await resumed.waitFor('inbox', 2);
    const got = resumed.events.filter(evt => evt.event === 'inbox');
    assert.deepEqual(got.map(evt => evt.data.record.message), ['landed while serve was dead', 'this one too']);
  }
  finally {
    resumed.close();
  }
});

test('gap honesty: consumption underneath a disconnected client surfaces an advisory, never silence', async () => {
  clearInbox(REPO);
  const seen = appendReport(REPO, { slot: 'a', message: 'seen and consumed' });
  // clearInbox resets tail-based ts monotonicity: a fresh append in the SAME millisecond
  // as the consumed record would stamp an equal ts and hide below the cursor - a real,
  // documented edge (advisory-grade, sub-millisecond). Step past it deterministically.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  clearInbox(REPO); // the tmux desk's --clear eats it
  appendReport(REPO, { slot: 'b', message: 'fresh after the clear' });
  const client = sseConnect({
    port: serve.port,
    token: serve.token,
    path: `/api/v1/repos/${REPO}/stream?channels=inbox&inbox=${seen.ts}`,
  });
  try {
    await client.waitFor('gap', 1);
    const gap = client.events.find(evt => evt.event === 'gap');
    assert.equal(gap.data.channel, 'inbox');
    assert.equal(gap.data.from, seen.ts);
    await client.waitFor('inbox', 1);
    assert.equal(client.events.filter(evt => evt.event === 'inbox')[0].data.record.message, 'fresh after the clear');
  }
  finally {
    client.close();
  }
});

test('journal channel: tail replay then live facts, cursor-exact ids', async () => {
  appendJournal(REPO, { slot: 'a', type: 'worker-created' });
  const client = sseConnect({ port: serve.port, token: serve.token, path: `/api/v1/repos/${REPO}/stream?channels=journal` });
  try {
    await client.waitFor('journal', 1);
    appendJournal(REPO, { slot: 'a', type: 'task-dispatched', task: 'live fact', submitted: true });
    await client.waitFor('journal', 2);
    const got = client.events.filter(evt => evt.event === 'journal');
    assert.equal(got.at(-1).data.record.task, 'live fact');
    assert.equal(parseVector(got.at(-1).id).journal, got.at(-1).data.record.ts);
  }
  finally {
    client.close();
  }
});

test('ka: real heartbeat events flow on an idle stream', async () => {
  const client = sseConnect({ port: serve.port, token: serve.token, path: `/api/v1/repos/${REPO}/stream?channels=inbox` });
  try {
    await client.waitFor('ka', 2, 2000);
    assert.equal(typeof client.events.find(evt => evt.event === 'ka').data.ts, 'number');
  }
  finally {
    client.close();
  }
});

test('floor: complete snapshots with monotonic rev ride the poller', async () => {
  const client = sseConnect({ port: serve.port, token: serve.token, path: `/api/v1/repos/${REPO}/stream?channels=floor` });
  try {
    await client.waitFor('floor', 2, 3000);
    const got = client.events.filter(evt => evt.event === 'floor');
    assert.equal(got[0].data.snapshot.slots[0].slot, 'a'); // the exact cmdFloor JSON shape
    assert.ok(got[1].data.rev > got[0].data.rev);
  }
  finally {
    client.close();
  }
});

// --- the stall tests: a fake socket drives backpressure deterministically -------------
class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.stalled = false;
  }

  writeHead() {}
  write(chunk) {
    this.frames.push(String(chunk));
    return !this.stalled;
  }

  end() {}
  release() {
    this.stalled = false;
    this.emit('drain');
  }
}
const fakeReq = () => Object.assign(new EventEmitter(), { headers: {} });
const parseFrames = frames => frames.join('').split('\n\n').filter(Boolean).map((frame) => {
  const parsed = { event: null, id: null, data: null };
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: '))
      parsed.event = line.slice(7);
    else if (line.startsWith('id: '))
      parsed.id = line.slice(4);
    else if (line.startsWith('data: '))
      parsed.data = JSON.parse(line.slice(6));
  }
  return parsed;
});

test('stall: snapshots conflate to the latest; every id obeys the delivered-through law', async () => {
  clearInbox(REPO);
  const hub = createStreamHub({
    spawnTarget: fixture,
    repos: { [REPO]: '/tmp/stream-repo' },
    intervals: { floorMs: 60, watchMs: 60_000, kaMs: 60_000 },
  });
  const res = new FakeRes();
  res.stalled = true; // stalled from the first write
  const req = fakeReq();
  try {
    hub.handle(req, res, REPO, new URL(`http://x/api/v1/repos/${REPO}/stream?channels=inbox,floor`));
    // while stalled: ~10 floor polls land (conflating to the latest), inbox records pile
    // into the ring
    await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
    appendReport(REPO, { slot: 'a', message: 'queued one' });
    appendReport(REPO, { slot: 'b', message: 'queued two' });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    res.release();
    // freeze the capture right after the flush, BEFORE any live poll lands (a poll
    // already in flight would legitimately write another snapshot - conflation governs
    // the stall, not liveness). The drain flush runs on microtasks, ahead of this timer.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
    req.emit('close');
    const events = parseFrames(res.frames);
    const floors = events.filter(evt => evt.event === 'floor');
    // ~10 polls happened; at most the one stalled write plus the one conflated flush
    assert.ok(floors.length <= 2, `snapshots must conflate under stall (got ${floors.length})`);
    // the law: every frame's inbox vector equals the ts of the newest inbox record
    // WRITTEN BEFORE it - never the file tip
    let deliveredThrough = 0;
    for (const evt of events) {
      if (evt.event === 'inbox')
        deliveredThrough = evt.data.record.ts;
      if (evt.id != null)
        assert.equal(parseVector(evt.id).inbox, deliveredThrough, `${evt.event} frame stamped ahead of delivery`);
    }
    assert.equal(events.filter(evt => evt.event === 'inbox').length, 2);
  }
  finally {
    req.emit('close'); // disconnect: cleanups run, pollers release
    hub.closeAll();
  }
});
