// The per-repo turn journal: an append-only JSONL of facts about the fleet (worker created,
// task dispatched, turns started/completed, workers replaced). History, never consumed - the
// inbox stays the mailbox. Durability is deliberate, not inherited: appends are fsync'd (a
// record that was reported durable is on disk), the append path takes no lock (a single
// O_APPEND write is atomic at these sizes), and rotation - the only rewrite-shaped operation -
// happens by RENAME under its own lock and fails closed (skip, never proceed unserialized).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSchema, validate } from '../schema.mjs';
import { pidIdentityLive } from './locks.mjs';

export const JOURNAL_SCHEMA = loadSchema('journal-record.schema.json');
export const JOURNAL_SCHEMA_VERSION = JOURNAL_SCHEMA.properties.v.const;

// Env seams (mirroring SLOT_INBOX_DIR): the journal dir and the rotation size cap.
function journalDir() {
  return process.env.SLOT_JOURNAL_DIR || join(homedir(), '.config', 'slot', 'journal');
}
function maxBytes() {
  return Number.parseInt(process.env.SLOT_JOURNAL_MAX_BYTES ?? '', 10) || 5 * 1024 * 1024;
}

const livePath = repo => join(journalDir(), `${repo}.jsonl`);
const rotatedPath = repo => `${livePath(repo)}.1`;

/**
 * Validate a journal record against the record schema.
 * @param {object} record - the record.
 * @returns {string[]} problems ([] when valid).
 */
export function validateJournalRecord(record) {
  return validate(record, JOURNAL_SCHEMA);
}

/**
 * Append one fact to the repo's journal, durably: validate, single O_APPEND write, fsync.
 * Throws on invalid records and on IO failure - the CALLER owns the degrade policy (dispatch
 * warns and proceeds; a future headless turn hard-fails: an unrecorded turn is worse than a
 * refused one).
 * @param {string} repo - the repo name.
 * @param {object} record - the record fields (v/ts are stamped here).
 * @returns {object} the written record.
 */
export function appendJournal(repo, record) {
  const full = { v: JOURNAL_SCHEMA_VERSION, ts: Date.now(), ...record };
  const problems = validateJournalRecord(full);
  if (problems.length)
    throw new Error(`refusing to journal an invalid record:\n  ${problems.join('\n  ')}`);
  mkdirSync(journalDir(), { recursive: true });
  const fd = openSync(livePath(repo), 'a');
  try {
    writeSync(fd, `${JSON.stringify(full)}\n`);
    fsyncSync(fd); // durable-record-before-signal: reported facts are on disk, not in page cache
  }
  finally {
    closeSync(fd);
  }
  rotateJournalIfNeeded(repo);
  return full;
}

// Tolerant JSONL parse: skip lines that do not parse or do not carry the record basics.
function parseLines(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  }
  catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line)
      continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.ts === 'number' && typeof rec.type === 'string')
        records.push(rec);
    }
    catch { /* torn or corrupt line: skip it, the records around it survive */ }
  }
  return records;
}

/**
 * Read the repo's journal. `sinceTs` filters to records at/after the cursor and consults the
 * rotated generation when the cursor predates the live file's first record; `tail` returns the
 * last N records (live + rotated as needed).
 * @param {string} repo - the repo name.
 * @param {object} [options] - read options.
 * @param {number} [options.sinceTs] - only records with ts >= sinceTs.
 * @param {number} [options.tail] - only the last N records.
 * @returns {object[]} records, oldest first.
 */
export function readJournal(repo, { sinceTs, tail } = {}) {
  const live = parseLines(livePath(repo));
  const needRotated
    = (sinceTs != null && (live.length === 0 || live[0].ts > sinceTs))
      || (tail != null && live.length < tail);
  const records = needRotated ? [...parseLines(rotatedPath(repo)), ...live] : live;
  const since = sinceTs != null ? records.filter(rec => rec.ts >= sinceTs) : records;
  return tail != null ? since.slice(-tail) : since;
}

/**
 * Standing subscription: a persistent fs.watch on the journal dir that NUDGES on change.
 * Same contract as subscribeReports (lib/inbox.mjs): the nudge carries no data, the
 * consumer re-reads via readJournal({sinceTs}) - which already consults the rotated
 * generation, so rotation is invisible to subscribers. Filename filtering is prefix-based
 * (live file, .1 generation, rotation lock all start with '<repo>.jsonl'), so a rename
 * mid-rotation still nudges.
 * @param {string} repo - the repo name.
 * @param {() => void} onWake - Called (with nothing) when the journal may have changed.
 * @returns {() => void} unsubscribe - idempotent; no wakes after it returns.
 */
export function subscribeJournal(repo, onWake) {
  mkdirSync(journalDir(), { recursive: true });
  const prefix = `${repo}.jsonl`;
  let timer = null;
  let closed = false;
  const nudge = () => {
    if (closed || timer)
      return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed)
        onWake();
    }, 50);
  };
  let watcher = null;
  try {
    watcher = watch(journalDir(), (_event, fname) => {
      if (!fname || String(fname).startsWith(prefix))
        nudge();
    });
  }
  catch { /* fs.watch unavailable: the safety interval carries it */ }
  const safety = setInterval(nudge, 60_000);
  return () => {
    closed = true;
    watcher?.close();
    clearInterval(safety);
    if (timer)
      clearTimeout(timer);
    timer = null;
  };
}

/**
 * The live journal's size in bytes (doctor's check), 0 when absent.
 * @param {string} repo - the repo name.
 * @returns {number} size in bytes.
 */
export function journalSize(repo) {
  try {
    return statSync(livePath(repo)).size;
  }
  catch {
    return 0;
  }
}

// Rotation lock: an O_EXCL sibling carrying the rotator's pid identity. Stale (dead-holder)
// locks are broken by rename; a live holder or any doubt means SKIP - rotation fails closed,
// and the next append simply tries again.
function acquireRotationLock(repo) {
  const lockPath = `${livePath(repo)}.rotating`;
  const tryCreate = () => {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      return true;
    }
    catch {
      return false;
    }
  };
  if (tryCreate())
    return lockPath;
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (pidIdentityLive({ pid: holder.pid, pidStart: null }))
      return null; // live rotator: fail closed
    renameSync(lockPath, `${lockPath}.broken.${process.pid}`); // exactly one breaker wins
  }
  catch {
    return null; // unreadable/vanished: fail closed
  }
  return tryCreate() ? lockPath : null;
}

/**
 * Rotate the live journal aside (rename to `.1`, one generation kept) when it exceeds the size
 * cap. Rename-based: a concurrent O_APPEND writer finishes harmlessly on the renamed inode and
 * the next append creates a fresh live file. Never rewrites; fails closed when the rotation
 * lock is held.
 * @param {string} repo - the repo name.
 * @returns {boolean} true when a rotation happened.
 */
export function rotateJournalIfNeeded(repo) {
  if (journalSize(repo) <= maxBytes())
    return false;
  const lockPath = acquireRotationLock(repo);
  if (!lockPath)
    return false; // fail closed: skip this pass
  try {
    if (journalSize(repo) <= maxBytes())
      return false; // re-check under the lock: someone else already rotated
    if (existsSync(rotatedPath(repo)))
      unlinkSync(rotatedPath(repo)); // drop the oldest generation (bounded loss of OLD history only)
    renameSync(livePath(repo), rotatedPath(repo));
    return true;
  }
  finally {
    try {
      unlinkSync(lockPath);
    }
    catch { /* already gone */ }
  }
}
