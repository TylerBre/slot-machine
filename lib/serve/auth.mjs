// sm serve auth: the pairing token and stateless HMAC cookie sessions. The token is an
// arbitrary-code-execution credential for this host: 32 random bytes, 0600 in a 0700
// dir, constant-time compares everywhere, and sessions that are stateless HMAC
// derivatives of it - no JS-readable credential exists after pairing. See README.md.
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The serve state home (token, mirror registry, spools). Overridable for tests via
 * SLOT_SERVE_DIR.
 * @returns {string} the state directory path.
 */
export function serveStateDir() {
  return process.env.SLOT_SERVE_DIR || join(homedir(), '.config', 'slot', 'serve');
}

const tokenPath = () => join(serveStateDir(), 'token');

/** 30-day rolling sessions; re-pairing is one visit to the printed URL. */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The pairing token: minted once (crypto.randomBytes(32) hex), persisted 0600 in a 0700
 * dir, stable across restarts. `rotate` re-mints (sm serve --rotate-token).
 * @param {object} [options] - Options.
 * @param {boolean} [options.rotate] - Force a fresh token.
 * @returns {string} the token (64 hex chars).
 */
export function ensureToken({ rotate = false } = {}) {
  mkdirSync(serveStateDir(), { recursive: true, mode: 0o700 });
  chmodSync(serveStateDir(), 0o700); // assert-and-repair: pre-existing dirs get tightened
  if (!rotate && existsSync(tokenPath())) {
    chmodSync(tokenPath(), 0o600);
    return readFileSync(tokenPath(), 'utf8').trim();
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath(), 0o600);
  return token;
}

/**
 * Days since the token was minted (surfaced in meta + doctor so rotation has a prompt),
 * or null when no token exists yet.
 * @returns {number|null} whole days.
 */
export function tokenAgeDays() {
  try {
    return Math.floor((Date.now() - statSync(tokenPath()).mtimeMs) / 86_400_000);
  }
  catch {
    return null;
  }
}

const mac = (token, exp) => createHmac('sha256', token).update(String(exp)).digest('hex');

function safeEqual(left, right) {
  const first = Buffer.from(String(left ?? ''), 'utf8');
  const second = Buffer.from(String(right ?? ''), 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

/**
 * Mint a session cookie value: `exp.HMAC-SHA256(token, exp)`. Stateless - verification
 * needs only the persisted token, so cookies survive serve restarts and no server-side
 * session table exists.
 * @param {string} token - the pairing token.
 * @param {number} [now] - clock injection for tests.
 * @returns {string} the cookie value.
 */
export function mintCookie(token, now = Date.now()) {
  const exp = now + SESSION_TTL_MS;
  return `${exp}.${mac(token, exp)}`;
}

/**
 * Verify a session cookie: unexpired and HMAC-authentic, constant-time.
 * @param {string} token - the pairing token.
 * @param {string|null} cookie - the presented cookie value.
 * @param {number} [now] - clock injection for tests.
 * @returns {boolean} valid.
 */
export function verifyCookie(token, cookie, now = Date.now()) {
  const [expRaw, presented] = String(cookie ?? '').split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now || !presented)
    return false;
  return safeEqual(presented, mac(token, exp));
}

/**
 * Verify a directly-presented pairing token (Authorization: Bearer, or the session
 * exchange), constant-time.
 * @param {string} token - the persisted token.
 * @param {string|null} presented - what the caller sent.
 * @returns {boolean} match.
 */
export function verifyToken(token, presented) {
  return safeEqual(presented, token);
}
