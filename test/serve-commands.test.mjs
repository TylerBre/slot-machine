// The command endpoint: spawn-per-request against a fixture binary, the versioned
// envelope, repo pinning, pools, per-repo worker-run serialization, and the skew gate.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { request } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../lib/constants.mjs';
import { startServe } from '../lib/serve/server.mjs';

const BASE = join(tmpdir(), `sm-serve-cmd-${process.pid}`);
const LOG = join(BASE, 'spawn.log');
let serve;

function rawAgainst(target, { method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ host: '127.0.0.1', port: target.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolvePromise({
        status: res.statusCode,
        json: (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
          }
          catch {
            return null;
          }
        })(),
      }));
    });
    req.on('error', rejectPromise);
    if (body != null)
      req.write(body);
    req.end();
  });
}
function invokeAgainst(target, tool, payload, extraHeaders = {}) {
  return rawAgainst(target, {
    method: 'POST',
    path: `/api/v1/commands/${tool}`,
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${target.token}`,
      'sec-fetch-site': 'same-origin',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}
const invoke = (tool, payload, extraHeaders = {}) => invokeAgainst(serve, tool, payload, extraHeaders);

before(async () => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  process.env.SLOT_SERVE_DIR = join(BASE, 'state');
  const fixture = join(BASE, 'fake-sm');
  // The fixture stands in for the spawned sm binary: logs its argv, honors a hang knob,
  // answers the version probe, and exits per scenario (watch -> 3, slot-explode -> 1).
  writeFileSync(fixture, `#!/bin/sh
echo "$*" >> "${LOG}"
if [ -n "$SM_FIXTURE_HANG_MS" ]; then
  sleep "$(awk "BEGIN{print $SM_FIXTURE_HANG_MS/1000}")"
fi
case "$*" in
  *version*) echo '{"slot-machine":"${VERSION}"}' ;;
  *watch*) echo '{"events":[],"acked":false}'; exit 3 ;;
  *slot-explode*) echo 'boom' >&2; exit 1 ;;
  *) echo '{"okFromFixture":true}' ;;
esac
`);
  chmodSync(fixture, 0o755);
  serve = await startServe({
    port: 0,
    spawnTarget: fixture,
    repos: { gemini: '/tmp/gemini-repo', beta: '/tmp/beta-repo' },
    spawnTimeoutMs: 1_500,
  });
});
after(async () => {
  delete process.env.SM_FIXTURE_HANG_MS;
  await serve.close();
  rmSync(BASE, { recursive: true, force: true });
  delete process.env.SLOT_SERVE_DIR;
});

test('happy path: exact argv (--repo pin first, --json before --), parsed data in the envelope', async () => {
  rmSync(LOG, { force: true });
  const res = await invoke('msg-send', { repo: 'gemini', args: { message: 'hello worker', slots: 'a' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { v: 1, ok: true, outcome: 'ok', data: { okFromFixture: true } });
  const argv = readFileSync(LOG, 'utf8').trim();
  assert.match(argv, /^--repo \/tmp\/gemini-repo msg send/);
  assert.match(argv, /--json -- hello worker$/); // --json BEFORE the positional terminator
});

test('x-exit: watch exit 3 is ok/nothing-to-report; an unmapped failure carries stderr', async () => {
  const nothing = await invoke('watch', { repo: 'gemini', args: { check: true } });
  assert.equal(nothing.status, 200);
  assert.equal(nothing.json.ok, true);
  assert.equal(nothing.json.outcome, 'nothing-to-report');
  assert.deepEqual(nothing.json.data, { events: [], acked: false }); // stdout still parsed
  const failed = await invoke('slot-reset', { repo: 'gemini', args: { slot: 'slot-explode' } });
  assert.equal(failed.status, 200); // the ENVELOPE carries command failure; HTTP stays 200
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.outcome, 'error');
  assert.match(failed.json.error, /boom/);
});

test('gates: unknown tool 404, unexposed 403, unknown/path-shaped repo 404 pre-spawn, bad args 400, no origin proof 403', async () => {
  assert.equal((await invoke('no-such-tool', { repo: 'gemini', args: {} })).status, 404);
  assert.equal((await invoke('msg-report', { repo: 'gemini', args: { message: 'forged' } })).status, 403);
  rmSync(LOG, { force: true });
  assert.equal((await invoke('floor', { repo: '/tmp/gemini-repo', args: {} })).status, 404);
  assert.equal((await invoke('floor', { repo: 'unregistered', args: {} })).status, 404);
  assert.equal(existsSync(LOG), false, 'repo gate must refuse BEFORE any spawn');
  assert.equal((await invoke('floor', { repo: 'gemini', args: { bogus: true } })).status, 400);
  assert.equal((await invoke('msg-inbox', { repo: 'gemini', args: { clear: true } })).status, 400); // webHidden
  assert.equal((await invoke('floor', { repo: 'gemini', args: {} }, { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('timeout: a hung child is killed and reported 504', async () => {
  process.env.SM_FIXTURE_HANG_MS = '5000';
  try {
    const res = await invoke('floor', { repo: 'gemini', args: {} });
    assert.equal(res.status, 504);
  }
  finally {
    delete process.env.SM_FIXTURE_HANG_MS;
  }
});

test('pools: interactive fills at 8 -> 429 naming the pool; blocking pool independent', async () => {
  process.env.SM_FIXTURE_HANG_MS = '1200';
  try {
    const hung = Array.from({ length: 8 }, () => invoke('floor', { repo: 'gemini', args: {} }));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    const overflow = await invoke('journal', { repo: 'gemini', args: {} });
    assert.equal(overflow.status, 429);
    assert.equal(overflow.json.pool, 'interactive');
    const blocking = await invoke('msg-send', { repo: 'beta', args: { message: 'x', untilIdle: true } });
    assert.equal(blocking.status, 200); // partitioned: the blocking pool still has room
    await Promise.all(hung);
  }
  finally {
    delete process.env.SM_FIXTURE_HANG_MS;
  }
});

test('worker-run: serialized per repo, parallel across repos', async () => {
  process.env.SM_FIXTURE_HANG_MS = '500';
  try {
    const start = Date.now();
    await Promise.all([
      invoke('worker-run', { repo: 'gemini', args: { message: 'task one' } }),
      invoke('worker-run', { repo: 'gemini', args: { message: 'task two' } }),
    ]);
    assert.ok(Date.now() - start >= 950, 'same-repo worker-runs must serialize');
    const start2 = Date.now();
    await Promise.all([
      invoke('worker-run', { repo: 'gemini', args: { message: 'task three' } }),
      invoke('worker-run', { repo: 'beta', args: { message: 'task four' } }),
    ]);
    assert.ok(Date.now() - start2 < 950, 'cross-repo worker-runs must overlap');
  }
  finally {
    delete process.env.SM_FIXTURE_HANG_MS;
  }
});

test('skew gate: mutating tools 503 under version skew, reads still pass', async () => {
  const oldFixture = join(BASE, 'fake-sm-old');
  writeFileSync(oldFixture, `#!/bin/sh
case "$*" in
  *version*) echo '{"slot-machine":"0.0.1"}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(oldFixture, 0o755);
  const old = await startServe({ port: 0, spawnTarget: oldFixture, repos: { gemini: '/tmp/gemini-repo' } });
  try {
    const read = await invokeAgainst(old, 'floor', { repo: 'gemini', args: {} });
    assert.equal(read.status, 200); // reads ride through skew
    const mutate = await invokeAgainst(old, 'slot-reset', { repo: 'gemini', args: { slot: 'a' } });
    assert.equal(mutate.status, 503);
    assert.match(mutate.json.error, /skew/);
  }
  finally {
    await old.close();
  }
});
