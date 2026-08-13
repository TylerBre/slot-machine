// sm serve http skeleton: auth flow, host allowlist, static hosting + traversal defense,
// meta/catalog/healthz, status taxonomy. Hermetic: ephemeral port, tmp state dir, a
// fixture spawn target that answers the version probe.
import { Buffer } from 'node:buffer';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../lib/constants.mjs';
import { mintCookie } from '../lib/serve/auth.mjs';
import { startServe } from '../lib/serve/http.mjs';

const BASE = join(tmpdir(), `sm-serve-http-${process.pid}`);
const STATE = join(BASE, 'state');
const UI = join(BASE, 'ui');
let serve;

// Raw request helper (fetch forbids Host-header control, which the 421 test needs).
function raw({ method = 'GET', path = '/', headers = {}, body = null, port = serve.port }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolvePromise({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', rejectPromise);
    if (body != null)
      req.write(body);
    req.end();
  });
}
function jsonReq(path, body, headers = {}) {
  return raw({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

before(async () => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(UI, { recursive: true });
  process.env.SLOT_SERVE_DIR = STATE;
  // fixture spawn target: answers the version probe with serve's own version (no skew)
  const fixture = join(BASE, 'fake-sm');
  writeFileSync(fixture, `#!/bin/sh\necho '{"slot-machine":"${VERSION}"}'\n`);
  chmodSync(fixture, 0o755);
  writeFileSync(join(UI, 'index.html'), '<!doctype html><title>cockpit</title>');
  writeFileSync(join(UI, 'app.js'), 'export {}');
  serve = await startServe({ port: 0, uiDir: UI, spawnTarget: fixture, repos: { gemini: '/tmp/gemini' } });
});
after(async () => {
  await serve.close();
  rmSync(BASE, { recursive: true, force: true });
  delete process.env.SLOT_SERVE_DIR;
});

test('healthz: 200 with no auth; wrong method 405', async () => {
  assert.equal((await raw({ path: '/api/v1/healthz' })).status, 200);
  assert.equal((await raw({ method: 'POST', path: '/api/v1/healthz', headers: { 'content-type': 'application/json' } })).status, 405);
});

test('host allowlist: anything but 127.0.0.1/localhost is 421 before routing', async () => {
  const res = await raw({ path: '/api/v1/healthz', headers: { host: 'evil.example:7767' } });
  assert.equal(res.status, 421);
});

test('session flow: wrong token 401; right token mints an HttpOnly SameSite=Strict cookie that authorizes', async () => {
  assert.equal((await jsonReq('/api/v1/session', { token: 'nope' })).status, 401);
  const paired = await jsonReq('/api/v1/session', { token: serve.token });
  assert.equal(paired.status, 204);
  const setCookie = paired.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  // the cookie authorizes /meta; nothing does without it
  assert.equal((await raw({ path: '/api/v1/meta' })).status, 401);
  const meta = await raw({ path: '/api/v1/meta', headers: { cookie } });
  assert.equal(meta.status, 200);
  const body = JSON.parse(meta.text);
  assert.equal(body.skew, false); // fixture answered serve's own version
  assert.deepEqual(body.repos, ['gemini']);
  // Bearer works for curl/scripting
  assert.equal((await raw({ path: '/api/v1/meta', headers: { authorization: `Bearer ${serve.token}` } })).status, 200);
  // an expired cookie refuses
  const stale = mintCookie(serve.token, Date.now() - 90 * 24 * 3600 * 1000);
  assert.equal((await raw({ path: '/api/v1/meta', headers: { cookie: `sm_session=${encodeURIComponent(stale)}` } })).status, 401);
});

test('catalog: only x-web tools, webHidden args absent, outcomes ride along', async () => {
  const res = await raw({ path: '/api/v1/commands', headers: { authorization: `Bearer ${serve.token}` } });
  assert.equal(res.status, 200);
  const { tools } = JSON.parse(res.text);
  const names = tools.map(tool => tool.tool);
  assert.ok(names.includes('floor') && names.includes('worker-run'));
  assert.ok(!names.includes('msg-report') && !names.includes('serve'));
  const watch = tools.find(tool => tool.tool === 'watch');
  assert.ok(!('hook' in watch.inputSchema.properties));
  assert.ok(watch.outcomes.includes('nothing-to-report'));
});

test('static: CSP on everything, traversal defended, SPA fallback to index.html', async () => {
  const index = await raw({ path: '/' });
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-security-policy'], 'default-src \'self\'');
  assert.match(index.text, /cockpit/);
  assert.equal((await raw({ path: '/app.js' })).headers['content-type'], 'text/javascript');
  const traversal = await raw({ path: '/..%2f..%2f..%2fetc%2fpasswd' });
  assert.ok(traversal.status === 404 || traversal.text.includes('cockpit'), 'never escapes uiDir');
  assert.ok(!traversal.text.includes('root:'), 'never serves outside uiDir');
  const spa = await raw({ path: '/some/client/route' });
  assert.match(spa.text, /cockpit/); // index fallback
});

test('taxonomy: 404 unknown api route, 415 wrong content-type, 413 over the body cap', async () => {
  const auth = { authorization: `Bearer ${serve.token}` };
  assert.equal((await raw({ path: '/api/v1/nope', headers: auth })).status, 404);
  assert.equal((await raw({ method: 'POST', path: '/api/v1/session', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  const big = await jsonReq('/api/v1/session', { token: 'x'.repeat(300_000) });
  assert.equal(big.status, 413);
});

test('single instance: a live pidfile refuses a second serve; a stale one is overwritten', async () => {
  // a live FOREIGN holder (the test runner's parent - reliably alive, reliably not us;
  // the guard deliberately exempts our own pid, so the before() serve cannot stand in)
  const LIVE = join(BASE, 'state-live');
  mkdirSync(LIVE, { recursive: true });
  writeFileSync(join(LIVE, 'serve.pid'), JSON.stringify({ pid: process.ppid, startedAt: 1 }));
  process.env.SLOT_SERVE_DIR = LIVE;
  try {
    await assert.rejects(
      () => startServe({ port: 0, spawnTarget: join(BASE, 'fake-sm'), repos: {} }),
      /already running/,
    );
  }
  finally {
    process.env.SLOT_SERVE_DIR = STATE;
  }
  // a stale holder (dead pid) is taken over: point the seam at a fresh dir with a dead pid
  const STALE = join(BASE, 'state-stale');
  mkdirSync(STALE, { recursive: true });
  writeFileSync(join(STALE, 'serve.pid'), JSON.stringify({ pid: 999999, startedAt: 1 }));
  process.env.SLOT_SERVE_DIR = STALE;
  try {
    const second = await startServe({ port: 0, spawnTarget: join(BASE, 'fake-sm'), repos: {} });
    await second.close();
    assert.equal(existsSync(join(STALE, 'serve.pid')), false); // released on close
  }
  finally {
    process.env.SLOT_SERVE_DIR = STATE;
  }
});

test('teardown: a connected SSE client receives serve-shutdown before the socket drops', async () => {
  const CLEAN = join(BASE, 'state-teardown');
  process.env.SLOT_SERVE_DIR = CLEAN;
  let target;
  try {
    target = await startServe({ port: 0, spawnTarget: join(BASE, 'fake-sm'), repos: { gemini: '/tmp/g' } });
    const frames = [];
    await new Promise((resolvePromise) => {
      const req = request(
        { host: '127.0.0.1', port: target.port, path: '/api/v1/repos/gemini/stream?channels=inbox', headers: { authorization: `Bearer ${target.token}` } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', chunk => frames.push(chunk));
          res.on('end', resolvePromise);
          res.on('close', resolvePromise);
          setTimeout(() => target.close(), 100); // shut down while connected
        },
      );
      req.end();
    });
    assert.match(frames.join(''), /event: serve-shutdown/);
  }
  finally {
    if (target)
      await target.close().catch(() => {});
    process.env.SLOT_SERVE_DIR = STATE;
  }
});
