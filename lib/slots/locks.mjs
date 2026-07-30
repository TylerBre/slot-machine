// The worktree document lifecycle: .worktree-lock is the slot's state of record, in sections -
// `claim` (the lock: dispatch claims, reset/unlock release, embedded resource locks), `worker`
// (the conversation bound to the slot), `turn` (an in-flight session turn). The filename is
// grandfathered legacy naming. readLock keeps its historical contract (the flat claim, or null
// when unclaimed) so claim consumers never see the sections.
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
// (writeFileSync is deliberately absent: every document write flows through mutateDoc's
// tmp-mutex + fsync + rename protocol - there is no unserialized write path.)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveInstance } from '../agents/index.mjs';
import { callOp } from '../agents/contract.mjs';
import { DOCS, LOCK_FILENAME, LOCK_TMP_FILENAME, PREFIX, REPO_DIR, STALE_LOCK_SEC } from '../constants.mjs';
import { listSlots } from '../exec.mjs';
import { loadSchema, validate } from '../schema.mjs';
import { elevate } from '../elevators.mjs';
import { issueFromText, labelFromDir, lockStale } from './pure.mjs';

// The .worktree-lock is the one per-worktree file: a versioned JSON document
// (schema/worktree-lock.schema.json) that embeds resource-lock records under its claim.
export const LOCK_SCHEMA = loadSchema('worktree-lock.schema.json');
export const LOCK_SCHEMA_VERSION = LOCK_SCHEMA.properties.v.const;
export const RESOURCE_LOCK_SCHEMA = loadSchema('resource-lock.schema.json');
export const RESOURCE_LOCK_SCHEMA_VERSION = RESOURCE_LOCK_SCHEMA.properties.v.const;

/**
 * Validate a parsed worktree document against LOCK_SCHEMA (or a given schema).
 * @param {object} lock - the parsed document.
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

// Version elevators: index N lifts a document from version N to N+1. Reads run the ladder so a
// file written by any older sm still normalizes to the current schema (a legacy lock has no `v`,
// = v0). Append the next step when the schema changes; never edit a shipped step.
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
  // v1 -> v2: section the document. The flat claim fields move under `claim` (top-level
  // `resources` ride along); the stale-by-read-time `pane` handle is dropped; `worker` and
  // `turn` sections are born null. `cwd` stays top-level - it is the document's identity.
  (lock, cwd) => ({
    v: 2,
    cwd: lock.cwd ?? cwd ?? null,
    ts: lock.ts,
    claim: {
      session: lock.session ?? null,
      task: lock.task ?? null,
      issue: lock.issue ?? null,
      ts: lock.ts,
      ...(lock.resources ? { resources: lock.resources } : {}),
    },
    worker: null,
    turn: null,
  }),
];

/**
 * Elevate a raw parsed document (any version) up to the current schema version. `cwd` is the
 * directory the file was read from, used to stamp identity onto legacy locks that predate it.
 * @param {object} raw - the raw parsed document (any version).
 * @param {string|null} cwd - the directory the file was read from.
 * @returns {object} the document elevated to the current schema version.
 */
export function elevateLock(raw, cwd = null) {
  return elevate(raw, LOCK_ELEVATORS, LOCK_SCHEMA_VERSION, cwd);
}

// Parse + elevate the on-disk file. Returns { raw, doc }, null when absent, or
// { unparseable: true } when corrupt - the one read path every accessor builds on.
function parseDoc(dir) {
  const lockPath = join(dir, LOCK_FILENAME);
  if (!existsSync(lockPath))
    return null;
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
    const doc = elevateLock(raw, dir);
    if (Array.isArray(doc.claim?.resources))
      doc.claim.resources = doc.claim.resources.map(elevateResourceLock);
    return { raw, doc };
  }
  catch {
    return { unparseable: true };
  }
}

/**
 * Read a slot's full worktree document (sectioned, elevated), if present.
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the document, {unparseable:true} on parse error, or null if absent.
 */
export function readDoc(dir) {
  const parsed = parseDoc(dir);
  if (!parsed)
    return null;
  return parsed.unparseable ? parsed : parsed.doc;
}

/**
 * Read a slot's worker section: the conversation bound to this slot.
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the worker section, or null (absent file, unparseable, or no worker).
 */
export function readWorker(dir) {
  const doc = readDoc(dir);
  return doc && !doc.unparseable ? doc.worker ?? null : null;
}

/**
 * Read a slot's turn section: an in-flight session turn.
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the turn section, or null (absent file, unparseable, or no turn).
 */
export function readTurn(dir) {
  const doc = readDoc(dir);
  return doc && !doc.unparseable ? doc.turn ?? null : null;
}

/**
 * Read a slot's claim (the lock), if present. The historical contract: a flat claim object -
 * `owner` is parsed from the transcript path, which flags cross-wiring (a lock whose transcript
 * points at a different slot).
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the flat claim, {unparseable:true} on parse error, or null when
 *   the file is absent OR the document carries no claim (unclaimed).
 */
export function readLock(dir) {
  const parsed = parseDoc(dir);
  if (!parsed)
    return null;
  if (parsed.unparseable)
    return parsed;
  const { raw, doc } = parsed;
  if (!doc.claim)
    return null; // sectioned document without a claim = unclaimed
  const rawTranscript = raw.transcript ?? raw.claim?.transcript ?? ''; // legacy field, still parsed for cross-wiring in inspect
  const prefixIdx = rawTranscript.lastIndexOf(PREFIX);
  let owner = null;
  if (prefixIdx >= 0) {
    const rest = rawTranscript.slice(prefixIdx + PREFIX.length);
    const slashIdx = rest.indexOf('/');
    owner = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  }
  return {
    v: doc.v,
    cwd: doc.cwd,
    session: doc.claim.session ?? null,
    ts: doc.claim.ts,
    task: doc.claim.task ?? null,
    issue: doc.claim.issue ?? null,
    resources: doc.claim.resources ?? [],
    transcript: rawTranscript || null,
    owner,
  };
}

// A fresh all-null document skeleton for a worktree that has none yet.
const freshDoc = dir => ({ v: LOCK_SCHEMA_VERSION, cwd: dir, ts: Date.now(), claim: null, worker: null, turn: null });

// --- pid identity (turn holders + write-mutex holders) --------------------------------------------

/**
 * Normalize `ps -o lstart=` output into a comparable start-time token. Pure, exported for tests.
 * @param {string|null} out - raw ps stdout.
 * @returns {string|null} the trimmed token, or null when unreadable.
 */
export function parsePidStart(out) {
  const token = (out ?? '').trim();
  return token || null;
}

// The pid's start-time token via ps, or null when unreadable (ps missing/hiccup).
function lstartOf(pid) {
  try {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return res.status === 0 ? parsePidStart(res.stdout) : null;
  }
  catch {
    return null;
  }
}

/**
 * Is the recorded holder {pid, pidStart} still the live process it was when recorded?
 * Probes fail toward ALIVE: EPERM from the kill probe means a live process owned by another
 * uid; an unreadable start time means "assume alive". A readable start time that MISMATCHES
 * the recorded token means the pid was reused - the recorded holder is dead. Misjudging
 * safe-ward refuses a turn; misjudging unsafe-ward corrupts a session.
 * @param {object} rec - the recorded holder ({pid, pidStart}).
 * @param {object} [probes] - injectable probes for tests ({kill, lstart}).
 * @returns {boolean} true when the recorded holder must be treated as alive.
 */
export function pidIdentityLive(rec, probes = {}) {
  if (!rec || typeof rec.pid !== 'number')
    return false;
  const kill = probes.kill ?? (pid => process.kill(pid, 0));
  const lstart = probes.lstart ?? lstartOf;
  try {
    kill(rec.pid);
  }
  catch (err) {
    if (err?.code === 'ESRCH')
      return false; // no such process
    // EPERM (or anything else): the process exists; fall through to the identity check
  }
  if (rec.pidStart == null)
    return true; // no recorded identity to compare - pid liveness is all we have
  const current = lstart(rec.pid);
  if (current == null)
    return true; // unreadable identity: assume alive
  return current === rec.pidStart;
}

// This process's own identity token, memoized (it cannot change while we run).
let selfStart;
function selfIdentity() {
  selfStart ??= lstartOf(process.pid) ?? `pid-${process.pid}-noident`;
  return { pid: process.pid, pidStart: selfStart };
}

// --- the serialized write protocol ----------------------------------------------------------------
// Every document mutation flows through mutateDoc: an O_EXCL tmp file is simultaneously the write
// mutex and the atomic-write vehicle. Crash at any step leaves the old document or the new one,
// never a torn file; a crashed holder's tmp is broken BY RENAME (exactly one breaker wins), never
// by unlink (two unlinking waiters can destroy a third's fresh mutex).

const MUTEX_BUDGET_MS = () => Number.parseInt(process.env.SLOT_DOC_MUTEX_MS ?? '', 10) || 2000;
const TMP_STALE_MS = () => Number.parseInt(process.env.SLOT_DOC_TMP_STALE_MS ?? '', 10) || 5000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Break a stale tmp by rename; true when this process won the break (or the tmp vanished).
function breakStaleTmp(tmpPath) {
  try {
    renameSync(tmpPath, `${tmpPath}.broken.${process.pid}`);
    return true;
  }
  catch {
    return false; // someone else broke it first (ENOENT) - retry the claim from scratch either way
  }
}

// Is the tmp at tmpPath breakable? Readable holder -> pid identity; unreadable content (a peer
// mid-write, or a crash between doc-write and rename) -> only past the age gate.
function tmpBreakable(tmpPath) {
  let raw;
  try {
    raw = readFileSync(tmpPath, 'utf8');
  }
  catch {
    return false; // vanished mid-look: nothing to break
  }
  try {
    const holder = JSON.parse(raw);
    if (typeof holder?.pid === 'number')
      return !pidIdentityLive(holder);
  }
  catch { /* not a holder record - fall through to the age gate */ }
  try {
    return Date.now() - statSync(tmpPath).mtimeMs > TMP_STALE_MS();
  }
  catch {
    return false;
  }
}

// Acquire the write mutex: O_EXCL-create the tmp with our identity. Returns the open fd.
function acquireMutex(tmpPath) {
  const deadline = Date.now() + MUTEX_BUDGET_MS();
  for (;;) {
    try {
      const fd = openSync(tmpPath, 'wx');
      writeSync(fd, JSON.stringify({ ...selfIdentity(), ts: Date.now() }));
      return fd;
    }
    catch (err) {
      if (err?.code !== 'EEXIST')
        throw err;
      if (tmpBreakable(tmpPath))
        breakStaleTmp(tmpPath); // winner or loser, the claim retries from scratch
      if (Date.now() > deadline)
        throw new Error(`worktree document is being written by another process (${tmpPath} held) - mutation in flight`);
      sleepSync(25);
    }
  }
}

// Read-merge-write a section mutation under the mutex: fn receives the current document (or a
// fresh skeleton) and returns the next one. The ONLY write path for the document. The doc is
// written into the tmp (fsync'd) and renamed over the document - atomic replace.
function mutateDoc(dir, fn) {
  const tmpPath = join(dir, LOCK_TMP_FILENAME);
  const fd = acquireMutex(tmpPath);
  let renamed = false;
  try {
    const parsed = parseDoc(dir);
    const doc = parsed && !parsed.unparseable ? parsed.doc : freshDoc(dir);
    const next = { ...fn(doc), ts: Date.now() };
    if (next.claim == null && next.worker == null && next.turn == null) {
      // an all-null document is equivalent to no document
      try {
        unlinkSync(join(dir, LOCK_FILENAME));
      }
      catch { /* already gone */ }
      return next;
    }
    const problems = validateLock(next);
    if (problems.length)
      throw new Error(`refusing to write invalid worktree document:\n  ${problems.join('\n  ')}`);
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    ftruncateSync(fd, 0);
    writeSync(fd, payload, 0);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmpPath, join(dir, LOCK_FILENAME));
    renamed = true;
    return next;
  }
  finally {
    if (!renamed) {
      try {
        closeSync(fd);
      }
      catch { /* already closed */ }
      try {
        unlinkSync(tmpPath); // release the mutex we created and still own
      }
      catch { /* broken away or renamed - nothing to release */ }
    }
  }
}

/**
 * Claim a slot: write the claim section. slot-machine owns the claim lifecycle: dispatch
 * claims, reset/unlock release. Liveness is judged from the live pane, so no transcript needed.
 * `issue` defaults to whatever issueFromText finds in the task, so the claim carries it as truth.
 * The worktree path is the document's identity (`cwd`); the slot label is just its basename.
 * Sibling sections (worker, turn) are preserved.
 * @param {string} dir - the slot worktree directory.
 * @param {object} options - the claim fields.
 * @param {string|null} options.session - the multiplexer session name.
 * @param {string|null} options.task - the task text.
 * @param {string|null} options.issue - the issue id (defaults to one parsed from the task).
 * @returns {object} the written claim (flat, with cwd/v), matching readLock's shape.
 */
export function writeLock(dir, { session = null, task = null, issue = null } = {}) {
  const claim = {
    session,
    task,
    issue: issue ?? issueFromText(task),
    ts: Date.now(),
  };
  const doc = mutateDoc(dir, current => ({ ...current, claim }));
  return { v: doc.v, cwd: doc.cwd, ...claim };
}

/**
 * Release a slot's claim (reclaim). The worker section survives - the conversation continues;
 * the file itself is removed only when no other section holds anything.
 * @param {string} dir - the slot worktree directory.
 * @returns {boolean} true if a claim was released.
 */
export function removeLock(dir) {
  const doc = readDoc(dir);
  if (!doc || doc.unparseable || !doc.claim) {
    if (doc?.unparseable) {
      // an unparseable file holds nothing recoverable; releasing it means removing it (today's behavior)
      try {
        unlinkSync(join(dir, LOCK_FILENAME));
        return true;
      }
      catch {
        return false;
      }
    }
    return false;
  }
  mutateDoc(dir, current => ({ ...current, claim: null }));
  return true;
}

/**
 * Write (or clear, with null) a slot's worker section. Owned-field merge: an update never
 * nulls a `sessionId` it did not explicitly set - the authoritative session pointer survives
 * writers that do not own it (e.g. a reload re-recording agent/transport).
 * @param {string} dir - the slot worktree directory.
 * @param {object|null} worker - worker fields to merge, or null to clear the section.
 * @returns {object|null} the written worker section (or null when cleared).
 */
export function writeWorker(dir, worker) {
  const doc = mutateDoc(dir, (current) => {
    if (worker == null)
      return { ...current, worker: null };
    const prev = current.worker ?? {};
    const next = {
      agent: worker.agent ?? prev.agent,
      model: worker.model !== undefined ? worker.model : prev.model ?? null,
      transport: worker.transport ?? prev.transport ?? 'pane',
      sessionId: worker.sessionId !== undefined ? worker.sessionId : prev.sessionId ?? null,
      createdAt: prev.createdAt ?? worker.createdAt ?? Date.now(),
    };
    return { ...current, worker: next };
  });
  return doc.worker ?? null;
}

// --- turn section ---------------------------------------------------------------------------------
// One turn per worker, structurally: the turn is a document section, and every mutation of the
// document serializes through the write mutex - so claim is a race-free read-check-write, release
// is verify-before-clear, and a dead holder is cleared lazily by the next serialized claimant.

/**
 * Claim a session turn on this slot. Refuses while a pid-live holder is recorded; claims over a
 * dead holder in the same serialized mutation (no unlink, no window between check and write).
 * @param {string} dir - the slot worktree directory.
 * @param {object} [options] - the turn fields.
 * @param {string|null} [options.task] - what the turn is doing.
 * @returns {object} { ok: true, turn } or { ok: false, holder } with the live holder's record.
 */
export function claimTurn(dir, { task = null } = {}) {
  let holder = null;
  const doc = mutateDoc(dir, (current) => {
    if (current.turn && pidIdentityLive(current.turn)) {
      holder = current.turn;
      return current; // refused - reported via holder; the write is a harmless no-op rewrite
    }
    return { ...current, turn: { ...selfIdentity(), startedAt: Date.now(), task } };
  });
  return holder ? { ok: false, holder } : { ok: true, turn: doc.turn };
}

/**
 * Release this process's turn. Verify-before-clear: clears the section only when it still
 * carries the caller's own pid identity - an unconditional clear would convert one transient
 * liveness misjudgment into a standing double-hold.
 * @param {string} dir - the slot worktree directory.
 * @returns {boolean} true when this process's turn was cleared.
 */
export function releaseTurn(dir) {
  const me = selfIdentity();
  let released = false;
  mutateDoc(dir, (current) => {
    if (current.turn && current.turn.pid === me.pid && current.turn.pidStart === me.pidStart) {
      released = true;
      return { ...current, turn: null };
    }
    return current;
  });
  return released;
}

/**
 * Is a pid-live turn in flight on this slot? The destructive lifecycle verbs (reset/rm) refuse
 * while this is true.
 * @param {string} dir - the slot worktree directory.
 * @returns {boolean} true when a live turn holder is recorded.
 */
export function turnLive(dir) {
  const turn = readTurn(dir);
  return !!turn && pidIdentityLive(turn);
}

// --- Resource locks (embedded in the claim section) ----------------------------------------------
// A named machine-level resource (the shared authenticated browser, a port, a proxy) is claimed by a
// slot and recorded in that slot's claim `resources` array - there is no second lockfile. Mutual
// exclusion is a scan across all slots' documents (see claimResource).

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
 * Pure claim transform: add a resource claim. Re-claiming a held name refreshes its record.
 * @param {object} claim - the flat claim to add a resource claim to.
 * @param {string} name - the resource name.
 * @param {string|null} task - the task text.
 * @returns {object} a new claim with the resource claim added.
 */
export function addResource(claim, name, task) {
  const kept = (claim.resources ?? []).filter(rec => rec.resource !== name);
  return { ...claim, resources: [...kept, resourceRecord(name, task)] };
}

/**
 * Pure claim transform: remove a resource claim by name.
 * @param {object} claim - the flat claim to remove a resource claim from.
 * @param {string} name - the resource name to remove.
 * @returns {object} a new claim with the resource claim removed.
 */
export function removeResource(claim, name) {
  return { ...claim, resources: (claim.resources ?? []).filter(rec => rec.resource !== name) };
}

/**
 * Read a worktree's claim as a full flat object (including elevated embedded resources), or null.
 * @param {string} dir - the slot worktree directory.
 * @returns {object|null} the flat claim with resources, or null if absent/unclaimed/unparseable.
 */
export function readLockFull(dir) {
  const doc = readDoc(dir);
  if (!doc || doc.unparseable || !doc.claim)
    return null;
  return { v: doc.v, cwd: doc.cwd, ...doc.claim, resources: doc.claim.resources ?? [] };
}

// Apply a pure claim transform to a slot's claim section, preserving sibling sections.
function mutateClaim(dir, fn) {
  mutateDoc(dir, (current) => {
    if (!current.claim)
      return current; // no claim to transform - callers pre-check
    const flat = fn({ ...current.claim });
    const { session = null, task = null, issue = null, ts, transcript, resources } = flat;
    return {
      ...current,
      claim: {
        session,
        task,
        issue,
        ts,
        ...(transcript != null ? { transcript } : {}),
        ...(resources ? { resources } : {}),
      },
    };
  });
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
 * Claim `name` for the slot at `cwd`, recording it in that slot's claim. Returns
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
  mutateClaim(cwd, claim => addResource(claim, name, task));
  return { ok: true, lock: readLockFull(cwd).resources.find(rec => rec.resource === name) };
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
  mutateClaim(holder.cwd, claim => removeResource(claim, name));
  return true;
}

/**
 * Seconds since the lock owner's newest transcript, via the slot's resolved plugin; null when
 * there is no readable transcript (lockStale then judges liveness from the live pane alone).
 * @param {object} lock - the lock (its worktree path is `cwd`).
 * @returns {number|null} seconds since the newest transcript, or null.
 */
export function lockTranscriptAge(lock) {
  const dir = lock?.cwd;
  if (!dir)
    return null;
  try {
    const { plugin, env } = resolveInstance(REPO_DIR, labelFromDir(dir));
    const res = callOp(plugin, 'transcriptAge', { dir, env });
    return res.ok ? res.value : null;
  }
  catch {
    return null; // roster not loaded or instance unresolved -> liveness-only staleness
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
