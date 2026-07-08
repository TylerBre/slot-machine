// Lock lifecycle: the .worktree-lock schema/versioning + read/write/remove, and the embedded
// named resource locks. slot-machine owns the lock lifecycle (dispatch claims, reset/unlock release).
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS, LOCK_FILENAME, PREFIX, STALE_LOCK_SEC } from '../constants.mjs';
import { listSlots } from '../exec.mjs';
import { loadSchema, validate } from '../schema.mjs';
import { elevate } from '../elevators.mjs';
import { issueFromText, labelFromDir, lockStale } from './pure.mjs';

/**
 * Read a slot's .worktree-lock, if present. `owner` is parsed from the transcript path,
 * which flags cross-wiring (a lock whose transcript points at a different slot).
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the parsed lock, {unparseable:true} on parse error, or null if absent.
 */
export function readLock(dir) {
  const lockPath = join(dir, LOCK_FILENAME);
  if (!existsSync(lockPath))
    return null;
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
    const lock = elevateLock(raw, dir);
    const rawTranscript = raw.transcript || ''; // legacy field, still parsed for cross-wiring in inspect
    const prefixIdx = rawTranscript.lastIndexOf(PREFIX);
    let owner = null;
    if (prefixIdx >= 0) {
      const rest = rawTranscript.slice(prefixIdx + PREFIX.length);
      const slashIdx = rest.indexOf('/');
      owner = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    }
    return {
      v: lock.v,
      cwd: lock.cwd,
      session: lock.session,
      ts: lock.ts,
      task: lock.task ?? null,
      issue: lock.issue ?? null,
      resources: lock.resources ?? [],
      transcript: raw.transcript ?? null,
      owner,
    };
  }
  catch {
    return { unparseable: true };
  }
}

// The .worktree-lock is the one lockfile: a versioned JSON document (schema/worktree-lock.schema.json)
// that embeds resource-lock records. Both schemas are the source of truth for their shapes.
export const LOCK_SCHEMA = loadSchema('worktree-lock.schema.json');
export const LOCK_SCHEMA_VERSION = LOCK_SCHEMA.properties.v.const;
export const RESOURCE_LOCK_SCHEMA = loadSchema('resource-lock.schema.json');
export const RESOURCE_LOCK_SCHEMA_VERSION = RESOURCE_LOCK_SCHEMA.properties.v.const;

/**
 * Validate a parsed worktree lock against LOCK_SCHEMA (or a given schema).
 * @param {object} lock - the parsed lock.
 * @param {object} [schema] - the schema to validate against (defaults to LOCK_SCHEMA).
 * @returns {string[]} problems ([] when valid).
 */
export function validateLock(lock, schema = LOCK_SCHEMA) {
  return validate(lock, schema);
}

/**
 * Validate a resource-lock record against RESOURCE_LOCK_SCHEMA.
 * @param {object} rec - the resource-lock record.
 * @returns {string[]} problems ([] when valid).
 */
export function validateResourceLock(rec) {
  return validate(rec, RESOURCE_LOCK_SCHEMA);
}

// Version elevators: index N lifts a lock from version N to N+1. readLock runs the ladder so a lock
// written by any older sm still normalizes to the current schema (a legacy lock has no `v`, = v0).
// Append the next step when the schema changes; never edit a shipped step.
const LOCK_ELEVATORS = [
  // v0 (legacy, no `v`) -> v1: stamp version, adopt cwd from the read path, ensure issue; the old
  // `slot` label and `transcript` fields are dropped (cwd is the identity now).
  (lock, cwd) => ({
    v: 1,
    cwd: lock.cwd ?? cwd ?? null,
    session: lock.session ?? null,
    pane: lock.pane ?? null,
    task: lock.task ?? null,
    issue: lock.issue ?? issueFromText(lock.task),
    ts: lock.ts,
  }),
];

/**
 * Elevate a raw parsed lock (any version) up to the current schema version. `cwd` is the directory
 * the lock was read from, used to stamp identity onto legacy locks that predate the field.
 * @param {object} raw - the raw parsed lock (any version).
 * @param {string|null} cwd - the directory the lock was read from.
 * @returns {object} the lock elevated to the current schema version.
 */
export function elevateLock(raw, cwd = null) {
  return elevate(raw, LOCK_ELEVATORS, LOCK_SCHEMA_VERSION, cwd);
}

/**
 * Claim a slot by writing .worktree-lock. slot-machine owns the lock lifecycle: dispatch
 * claims, reset/unlock release. Liveness is judged from the live pane, so no transcript needed.
 * `issue` defaults to whatever issueFromText finds in the task, so the lock carries it as truth.
 * The worktree path is the lock's identity (`cwd`); the slot label is just its basename.
 * @param {string} dir - the slot worktree directory.
 * @param {object} options - the lock fields.
 * @param {string|null} options.session - the tmux session name.
 * @param {string|null} options.pane - the tmux pane id.
 * @param {string|null} options.task - the task text.
 * @param {string|null} options.issue - the issue id (defaults to one parsed from the task).
 * @returns {object} the written lock object.
 */
export function writeLock(dir, { session = null, pane = null, task = null, issue = null } = {}) {
  const lock = {
    v: LOCK_SCHEMA_VERSION,
    cwd: dir,
    session,
    pane,
    task,
    issue: issue ?? issueFromText(task),
    ts: Date.now(),
  };
  writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/**
 * Release a slot's lock (reclaim). Returns true if a lock file was removed.
 * @param {string} dir - the slot worktree directory.
 * @returns {boolean} true if a lock file was removed.
 */
export function removeLock(dir) {
  try {
    unlinkSync(join(dir, LOCK_FILENAME));
    return true;
  }
  catch {
    return false;
  }
}

// --- Resource locks (embedded in the one worktree lockfile) --------------------------------------
// A named machine-level resource (the shared authenticated browser, a port, a proxy) is claimed by a
// slot and recorded as an entry in that slot's .worktree-lock `resources` array - there is no second
// lockfile. Mutual exclusion is a scan across all slots' locks (see claimResource).

// Append the next step when the schema changes; never edit a shipped step (see LOCK_ELEVATORS).
const RESOURCE_LOCK_ELEVATORS = [
  // v0 (legacy, no `v`) -> v1: stamp version (shipped step; do not edit)
  rec => ({ v: 1, resource: rec.resource, task: rec.task ?? null, pid: rec.pid ?? null, ts: rec.ts }),
  // v1 -> v2: drop the vestigial `pid` (the holder is identified by the enclosing lock's cwd)
  rec => ({ v: 2, resource: rec.resource, task: rec.task ?? null, ts: rec.ts }),
];

/**
 * Elevate a raw parsed resource-lock record (any version) up to the current schema version.
 * @param {object} raw - the raw parsed resource-lock record.
 * @returns {object} the record elevated to the current schema version.
 */
export function elevateResourceLock(raw) {
  return elevate(raw, RESOURCE_LOCK_ELEVATORS, RESOURCE_LOCK_SCHEMA_VERSION);
}

function resourceRecord(name, task) {
  return {
    v: RESOURCE_LOCK_SCHEMA_VERSION,
    resource: name,
    task: task ?? null,
    ts: Date.now(),
  };
}

/**
 * Pure lock transform: add a resource claim. Re-claiming a held name refreshes its record.
 * @param {object} lock - the worktree lock to add a resource claim to.
 * @param {string} name - the resource name.
 * @param {string|null} task - the task text.
 * @returns {object} a new lock with the resource claim added.
 */
export function addResource(lock, name, task) {
  const kept = (lock.resources ?? []).filter(rec => rec.resource !== name);
  return { ...lock, resources: [...kept, resourceRecord(name, task)] };
}

/**
 * Pure lock transform: remove a resource claim by name.
 * @param {object} lock - the worktree lock to remove a resource claim from.
 * @param {string} name - the resource name to remove.
 * @returns {object} a new lock with the resource claim removed.
 */
export function removeResource(lock, name) {
  return { ...lock, resources: (lock.resources ?? []).filter(rec => rec.resource !== name) };
}

/**
 * Read a worktree lock as a full elevated object (including embedded resources), or null.
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the elevated lock, or null if absent or unparseable.
 */
export function readLockFull(dir) {
  const lockPath = join(dir, LOCK_FILENAME);
  if (!existsSync(lockPath))
    return null;
  try {
    const lock = elevateLock(JSON.parse(readFileSync(lockPath, 'utf8')), dir);
    if (Array.isArray(lock.resources))
      lock.resources = lock.resources.map(elevateResourceLock);
    return lock;
  }
  catch {
    return null;
  }
}
function writeLockFull(dir, lock) {
  return writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(lock, null, 2)}\n`);
}

const slotDirs = () => listSlots().map(name => join(DOCS, name));

// ponytail: O(slots) scan per call - fine at single-user scale.
/**
 * Every held resource across all slots, flattened + tagged with its holding slot. Oldest first.
 * @returns {object[]} all held resource claims tagged with cwd/slot, oldest first.
 */
export function listResourceLocks() {
  const held = [];
  for (const dir of slotDirs()) {
    const lock = readLockFull(dir);
    for (const rec of lock?.resources ?? []) held.push({ ...rec, cwd: dir, slot: labelFromDir(dir) });
  }
  return held.sort((recA, recB) => (recA.ts || 0) - (recB.ts || 0));
}

/**
 * The slot holding `name`, or null. Mutual exclusion means at most one.
 * @param {string} name - the resource name.
 * @returns {object|null} the holding resource claim, or null.
 */
export function resourceHolder(name) {
  return listResourceLocks().find(rec => rec.resource === name) ?? null;
}

// ponytail: scan-based mutual exclusion, not an atomic file create - a TOCTOU race under two
// simultaneous claims is possible; fine at single-user scale, add an flock if it ever bites.
/**
 * Claim `name` for the slot at `cwd`, recording it in that slot's .worktree-lock. Returns
 * { ok, lock } or { ok: false, holder } / { ok: false, reason: 'slot-not-locked' }.
 * @param {string} name - the resource name to claim.
 * @param {object} options - the claim options.
 * @param {string} options.cwd - the claiming slot's worktree directory.
 * @param {string|null} options.task - the task text.
 * @returns {object} { ok, lock } on success, or { ok:false, holder } / { ok:false, reason }.
 */
export function claimResource(name, { cwd, task = null } = {}) {
  const holder = resourceHolder(name);
  if (holder && holder.cwd !== cwd)
    return { ok: false, holder };
  const lock = readLockFull(cwd);
  if (!lock)
    return { ok: false, holder: null, reason: 'slot-not-locked' };
  const next = addResource(lock, name, task);
  writeLockFull(cwd, next);
  return { ok: true, lock: next.resources.find(rec => rec.resource === name) };
}

/**
 * Release `name` from whichever slot holds it. Returns true if a claim was removed.
 * @param {string} name - the resource name to release.
 * @returns {boolean} true if a claim was removed.
 */
export function releaseResource(name) {
  const holder = resourceHolder(name);
  if (!holder)
    return false;
  const lock = readLockFull(holder.cwd);
  if (!lock)
    return false;
  writeLockFull(holder.cwd, removeResource(lock, name));
  return true;
}

/**
 * seconds since the lock owner's transcript was last written; null if it's gone.
 * @param {object} lock - the lock whose transcript age to measure.
 * @returns {number|null} seconds since the transcript was written, or null.
 */
export function lockTranscriptAge(lock) {
  if (!lock || !lock.transcript || !existsSync(lock.transcript))
    return null;
  try {
    return Math.floor((Date.now() - statSync(lock.transcript).mtimeMs) / 1000);
  }
  catch {
    return null;
  }
}

/**
 * Is a held lock a LIVE claim? One place builds the lockStale() args so call sites
 * cannot drift (two once dropped workerLive and misjudged every lock as live).
 * @param {object} lock - the parsed lock.
 * @param {boolean} workerLive - whether the claiming worker's pane is alive.
 * @param {number} thresholdSec - staleness threshold in seconds.
 * @returns {boolean} true when the lock is a live claim.
 */
export function lockIsLive(lock, workerLive, thresholdSec = STALE_LOCK_SEC) {
  if (!lock || lock.unparseable)
    return false;
  return !lockStale({
    workerLive,
    transcript: lock.transcript,
    transcriptAgeSec: lockTranscriptAge(lock),
    thresholdSec,
  });
}
