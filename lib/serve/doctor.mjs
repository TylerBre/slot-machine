// Doctor's serve checks, as data - cmdDoctor renders them; tests drive them hermetically.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { SERVE_PORT } from '../constants.mjs';
import { serveStateDir, tokenAgeDays } from './auth.mjs';

const TOKEN_STALE_DAYS = 90;

function httpJson(port, path, headers = {}) {
  return new Promise((resolvePromise) => {
    const req = get({ host: '127.0.0.1', port, path, headers, timeout: 700 }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolvePromise({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        }
        catch {
          resolvePromise({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolvePromise(null);
    });
    req.on('error', () => resolvePromise(null));
  });
}

/**
 * Tighten the serve state permissions to their contract (0700 dir, 0600 files).
 * @returns {boolean} true when something was repaired.
 */
export function fixServePerms() {
  const dir = serveStateDir();
  if (!existsSync(dir))
    return false;
  let changed = false;
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
    changed = true;
  }
  const token = join(dir, 'token');
  if (existsSync(token) && (statSync(token).mode & 0o777) !== 0o600) {
    chmodSync(token, 0o600);
    changed = true;
  }
  return changed;
}

/**
 * The serve health rows for doctor: state-dir perms, token age, liveness, skew.
 * Absence of serve is data, not failure - the rows say what to do.
 * @param {object} [options] - Options.
 * @param {number} [options.port] - The serve port to probe (default SERVE_PORT).
 * @returns {Promise<Array<{name: string, level: string, detail: string}>>} check rows.
 */
export async function serveChecks({ port = SERVE_PORT } = {}) {
  const rows = [];
  const dir = serveStateDir();
  const tokenPath = join(dir, 'token');

  if (!existsSync(tokenPath)) {
    rows.push({ name: 'serve', level: 'ok', detail: 'not set up yet - first sm serve mints the pairing token' });
    return rows;
  }
  const dirMode = statSync(dir).mode & 0o777;
  const tokenMode = statSync(tokenPath).mode & 0o777;
  rows.push({
    name: 'serve state perms',
    level: dirMode === 0o700 && tokenMode === 0o600 ? 'ok' : 'warn',
    detail: dirMode === 0o700 && tokenMode === 0o600
      ? `${dir} 0700, token 0600`
      : `state dir ${dirMode.toString(8)} / token ${tokenMode.toString(8)} - the token is an execution credential; fix: sm doctor --fix`,
  });
  const age = tokenAgeDays();
  rows.push({
    name: 'serve token age',
    level: age != null && age > TOKEN_STALE_DAYS ? 'warn' : 'ok',
    detail: age != null && age > TOKEN_STALE_DAYS
      ? `${age} days old (and it lands in browser history at pairing) - rotate: sm serve --rotate-token`
      : `${age ?? '?'} days old`,
  });

  // Mirror visibility: tracked sessions and orphan spools (a spool no registry entry
  // names holds terminal bytes nobody will ever unlink).
  try {
    const registry = JSON.parse(readFileSync(join(dir, 'mirror-registry.json'), 'utf8'));
    const tracked = new Set((registry.sessions ?? []).map(entry => entry.sink));
    const spools = existsSync(join(dir, 'spools'))
      ? readdirSync(join(dir, 'spools')).map(name => join(dir, 'spools', name))
      : [];
    const orphans = spools.filter(spool => !tracked.has(spool));
    rows.push({
      name: 'serve mirrors',
      level: orphans.length ? 'warn' : 'ok',
      detail: orphans.length
        ? `${registry.sessions?.length ?? 0} tracked, ${orphans.length} ORPHAN spool(s) holding terminal bytes - restart sm serve to sweep`
        : `${registry.sessions?.length ?? 0} tracked session(s), no orphan spools`,
    });
  }
  catch {
    // no registry yet: nothing mirrored, nothing to say
  }

  const health = await httpJson(port, '/api/v1/healthz');
  if (!health || health.status !== 200) {
    rows.push({ name: 'serve running', level: 'ok', detail: `not running on :${port} - sm serve to start` });
    return rows;
  }
  rows.push({ name: 'serve running', level: 'ok', detail: `healthy on 127.0.0.1:${port}` });
  const token = readFileSync(tokenPath, 'utf8').trim();
  const meta = await httpJson(port, '/api/v1/meta', { authorization: `Bearer ${token}` });
  if (meta?.status === 200 && meta.body) {
    rows.push({
      name: 'serve skew',
      level: meta.body.skew ? 'warn' : 'ok',
      detail: meta.body.skew
        ? `serve ${meta.body.serveVersion} vs binary ${meta.body.binaryVersion} - restart sm serve`
        : `serve and binary agree (${meta.body.serveVersion})`,
    });
  }
  return rows;
}
