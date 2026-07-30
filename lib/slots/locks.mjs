// The worktree document lifecycle: .worktree-lock is the slot's state of record, in sections -
// `claim` (the lock: dispatch claims, reset/unlock release, embedded resource locks), `worker`
// (the conversation bound to the slot), `turn` (an in-flight session turn). The filename is
// grandfathered legacy naming. readLock keeps its historical contract (the flat claim, or null
// when unclaimed) so claim consumers never see the sections.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInstance } from '../agents/index.mjs';
import { callOp } from '../agents/contract.mjs';
import { DOCS, LOCK_FILENAME, PREFIX, REPO_DIR, STALE_LOCK_SEC } from '../constants.mjs';
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

// Write the document (validated), or unlink it when every section is null - an all-null
// document is equivalent to no document. (The serialized tmp-mutex protocol lands in the
// write path next; today this is the single choke point it will wrap.)
function writeDoc(dir, doc) {
  const next = { ...doc, ts: Date.now() };
  if (next.claim == null && next.worker == null && next.turn == null) {
    try {
      unlinkSync(join(dir, LOCK_FILENAME));
    }
    catch { /* already gone */ }
    return next;
  }
  const problems = validateLock(next);
  if (problems.length)
    throw new Error(`refusing to write invalid worktree document:\n  ${problems.join('\n  ')}`);
  writeFileSync(join(dir, LOCK_FILENAME), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Read-merge-write a section mutation: fn receives the current document (or a fresh skeleton)
// and returns the next one. The ONLY write path for the document.
function mutateDoc(dir, fn) {
  const parsed = parseDoc(dir);
  const doc = parsed && !parsed.unparseable ? parsed.doc : freshDoc(dir);
  return writeDoc(dir, fn(doc));
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
