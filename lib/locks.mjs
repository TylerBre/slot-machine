// Named resource locks: machine-level singletons that aren't slot worktrees - the shared
// authenticated Playwright browser, a port, a proxy. Acquisition is ATOMIC via exclusive
// create ('wx'), so two claimants can't both win; contention loses cleanly with the holder's
// info. Staleness/steal policy lives in the claim command (it needs worker liveness).
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';

function locksDir() {
  return process.env.SLOT_LOCKS_DIR || join(homedir(), '.config', 'slot', 'locks');
}
const lockPath = (name) => join(locksDir(), `${name}.lock`);

// Try to claim `name` for `meta` ({slot, task, session}). Atomic: exclusive create.
// Returns { ok: true, lock } or { ok: false, holder } (holder null if unreadable).
export function claimResource(name, meta = {}) {
  mkdirSync(locksDir(), { recursive: true });
  const lock = {
    resource: name,
    slot: meta.slot ?? null,
    task: meta.task ?? null,
    session: meta.session ?? null,
    ts: Date.now(),
  };
  try {
    writeFileSync(lockPath(name), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
    return { ok: true, lock };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { ok: false, holder: readResourceLock(name) };
  }
}

export function readResourceLock(name) {
  try {
    return JSON.parse(readFileSync(lockPath(name), 'utf8'));
  } catch {
    return null;
  }
}

export function releaseResource(name) {
  try {
    unlinkSync(lockPath(name));
    return true;
  } catch {
    return false;
  }
}

// All held resource locks, oldest first.
export function listResourceLocks() {
  if (!existsSync(locksDir())) return [];
  return readdirSync(locksDir())
    .filter((f) => f.endsWith('.lock'))
    .map((f) => readResourceLock(basename(f, '.lock')))
    .filter(Boolean)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}
