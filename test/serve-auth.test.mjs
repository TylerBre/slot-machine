// sm serve auth: token mint/rotate, stateless HMAC cookie sessions, constant-time compares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureToken, mintCookie, SESSION_TTL_MS, tokenAgeDays, verifyCookie, verifyToken } from '../lib/serve/auth.mjs';

function fresh(tag) {
  const dir = join(tmpdir(), `sm-serve-auth-${tag}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.SLOT_SERVE_DIR = dir;
  return dir;
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SLOT_SERVE_DIR;
}

test('ensureToken: mints once (0600 in a 0700 dir), stable across calls, rotate re-mints', () => {
  const dir = fresh('mint');
  try {
    const token = ensureToken();
    assert.match(token, /^[0-9a-f]{64}$/); // 32 random bytes, hex
    assert.equal(ensureToken(), token); // stable
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, 'token'), 'utf8').trim(), token);
    const rotated = ensureToken({ rotate: true });
    assert.notEqual(rotated, token);
    assert.equal(ensureToken(), rotated);
    assert.equal(typeof tokenAgeDays(), 'number');
  }
  finally {
    cleanup(dir);
  }
});

test('cookie sessions: stateless HMAC round-trip; expiry, tamper, and wrong-token all refuse', () => {
  const dir = fresh('cookie');
  try {
    const token = ensureToken();
    const now = 1_800_000_000_000;
    const cookie = mintCookie(token, now);
    assert.equal(verifyCookie(token, cookie, now), true);
    assert.equal(verifyCookie(token, cookie, now + SESSION_TTL_MS + 1), false); // expired
    const [exp, mac] = cookie.split('.');
    assert.equal(verifyCookie(token, `${exp}.${'0'.repeat(mac.length)}`, now), false); // tampered mac
    assert.equal(verifyCookie(token, `${Number(exp) + 9999}.${mac}`, now), false); // tampered exp
    assert.equal(verifyCookie('f'.repeat(64), cookie, now), false); // wrong token
    assert.equal(verifyCookie(token, '', now), false);
    assert.equal(verifyCookie(token, null, now), false);
  }
  finally {
    cleanup(dir);
  }
});

test('verifyToken: exact match only, length-mismatch safe', () => {
  const dir = fresh('tok');
  try {
    const token = ensureToken();
    assert.equal(verifyToken(token, token), true);
    assert.equal(verifyToken(token, `${token}0`), false);
    assert.equal(verifyToken(token, token.slice(0, -1)), false);
    assert.equal(verifyToken(token, ''), false);
    assert.equal(verifyToken(token, null), false);
  }
  finally {
    cleanup(dir);
  }
});
