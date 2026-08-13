// Doctor's serve rows: perms honesty + repair, token age, liveness/skew probes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureToken } from '../lib/serve/auth.mjs';
import { fixServePerms, serveChecks } from '../lib/serve/doctor.mjs';

const DIR = join(tmpdir(), `sm-serve-doctor-${process.pid}`);

before(() => {
  rmSync(DIR, { recursive: true, force: true });
  process.env.SLOT_SERVE_DIR = DIR;
});
after(() => {
  rmSync(DIR, { recursive: true, force: true });
  delete process.env.SLOT_SERVE_DIR;
});

test('no token yet: one informational row, no warns', async () => {
  const rows = await serveChecks({ port: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'ok');
  assert.match(rows[0].detail, /first sm serve/);
});

test('perms drift warns and --fix repairs; not-running is data, not failure', async () => {
  ensureToken();
  chmodSync(DIR, 0o755);
  chmodSync(join(DIR, 'token'), 0o644);
  let rows = await serveChecks({ port: 1 }); // nothing listens on :1
  const perms = rows.find(row => row.name === 'serve state perms');
  assert.equal(perms.level, 'warn');
  assert.match(perms.detail, /fix: sm doctor --fix/);
  assert.equal(rows.find(row => row.name === 'serve running').level, 'ok');
  assert.match(rows.find(row => row.name === 'serve running').detail, /not running/);

  assert.equal(fixServePerms(), true);
  assert.equal(statSync(DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(DIR, 'token')).mode & 0o777, 0o600);
  rows = await serveChecks({ port: 1 });
  assert.equal(rows.find(row => row.name === 'serve state perms').level, 'ok');
});

test('stale token warns toward rotation', async () => {
  ensureToken();
  const old = new Date(Date.now() - 120 * 24 * 3600 * 1000);
  const { utimesSync } = await import('node:fs');
  utimesSync(join(DIR, 'token'), old, old);
  const rows = await serveChecks({ port: 1 });
  const age = rows.find(row => row.name === 'serve token age');
  assert.equal(age.level, 'warn');
  assert.match(age.detail, /--rotate-token/);
  writeFileSync(join(DIR, 'token'), 'refresh\n'); // reset mtime for later tests
});
