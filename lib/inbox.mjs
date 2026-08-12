// Worker -> dispatcher back-channel: a per-repo append-only message inbox. A worker runs
// `sm msg report "<msg>"` to reach the dispatcher; the dispatcher reads with `sm msg inbox`.
// Screen-scraping panes was the old (lossy) channel; this is the structured one.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { INBOX_POLL_MS, INBOX_WAIT_MS } from './constants.mjs';
import { loadSchema, validate } from './schema.mjs';
import { elevate } from './elevators.mjs';

// Overridable for tests. Per-repo JSONL under the config dir.
function inboxDir() {
  return process.env.SLOT_INBOX_DIR || join(homedir(), '.config', 'slot', 'inbox');
}

// Short thread sleep (no deps) between lock-acquire retries.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const INBOX_LOCK_STALE_MS = 5000; // a write-lock held longer than this is assumed abandoned + stolen

/**
 * Serialize inbox writers across processes for one repo. A worker's appendReport and the
 * dispatcher's consume/clear rewrites must not interleave, or a report appended during a
 * read-modify-write is silently dropped. Uses an O_EXCL lockfile (the cross-process primitive);
 * a lock whose holder crashed is stolen once it is older than INBOX_LOCK_STALE_MS so the inbox
 * can never wedge. Best-effort: if it cannot acquire within the window it proceeds anyway (the
 * unserialized race is far rarer than a permanent deadlock would be).
 * @param {string} repo - Repo identifier (its inbox is the critical section).
 * @param {() => T} fn - The read-modify-write (or append) to run under the lock.
 * @returns {T} whatever fn returns.
 * @template T
 */
function withInboxLock(repo, fn) {
  mkdirSync(inboxDir(), { recursive: true });
  const lockPath = `${inboxPath(repo)}.lock`;
  let fd = null;
  for (let waited = 0; waited < INBOX_LOCK_STALE_MS * 2; waited += 25) {
    try {
      fd = openSync(lockPath, 'wx'); // O_CREAT|O_EXCL: fails if another writer holds it
      break;
    }
    catch (err) {
      if (err.code !== 'EEXIST')
        throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > INBOX_LOCK_STALE_MS)
          unlinkSync(lockPath); // holder is gone - steal it
      }
      catch { /* raced another releaser; just retry */ }
      sleepSync(25);
    }
  }
  try {
    return fn();
  }
  finally {
    if (fd != null) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      }
      catch { /* already removed */ }
    }
  }
}

const INBOX_SCHEMA = loadSchema('inbox-report.schema.json');
const INBOX_SCHEMA_VERSION = INBOX_SCHEMA.properties.v.const;
// v0 (legacy, no `v`) -> v1: stamp version, default slot.
const INBOX_ELEVATORS = [
  raw => ({ v: 1, ts: raw.ts, slot: raw.slot ?? null, message: raw.message }),
];
/**
 * Path to a repo's append-only inbox JSONL file.
 * @param {string} repo - Repo identifier; falls back to 'default'.
 * @returns {string} Absolute path to the inbox file.
 */
export function inboxPath(repo) {
  return join(inboxDir(), `${repo || 'default'}.jsonl`);
}

/**
 * The newest entry's ts, or 0 for an empty/absent inbox. The baseline every ts-anchored
 * consumer (cursors, watch wakes, monotonic stamping) measures from.
 * @param {string} repo - Repo identifier.
 * @returns {number} newest ts, or 0.
 */
export function lastEntryTs(repo) {
  const path = inboxPath(repo);
  if (!existsSync(path))
    return 0;
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const ts = JSON.parse(lines[index]).ts;
      if (typeof ts === 'number')
        return ts;
    }
    catch { /* corrupt tail line: look further back */ }
  }
  return 0;
}

/**
 * Append one report. entry: { slot, message }. Stamps ts STRICTLY MONOTONIC per repo
 * (max(now, newest+1), under the inbox lock): two same-millisecond reports get distinct,
 * increasing stamps, so every `ts > cursor` comparison in the read-cursor/watch machinery
 * is exact - a report can never hide behind a timestamp tie.
 * @param {string} repo - Repo identifier.
 * @param {object} entry - The report to append.
 * @param {string|null} [entry.slot] - Originating slot, or null.
 * @param {string} entry.message - The message text.
 * @returns {object} the written record.
 */
export function appendReport(repo, { slot = null, message }) {
  // Under the lock so the monotonic stamp and the append are one atomic step, and an
  // append never interleaves with a concurrent consume/clear rewrite.
  return withInboxLock(repo, () => {
    const record = { v: INBOX_SCHEMA_VERSION, ts: Math.max(Date.now(), lastEntryTs(repo) + 1), slot, message };
    const problems = validate(record, INBOX_SCHEMA);
    if (problems.length)
      throw new Error(`invalid inbox report: ${problems.join('; ')}`);
    appendFileSync(inboxPath(repo), `${JSON.stringify(record)}\n`);
    return record;
  });
}

/**
 * Inbox entries for a repo, oldest first. Skips unparseable lines.
 * @param {string} repo - Repo identifier.
 * @param {object} [options] - Read options.
 * @param {number} [options.sinceTs] - Only entries with ts strictly greater than this.
 * @returns {object[]} Parsed inbox entries, oldest first.
 */
export function readInbox(repo, { sinceTs } = {}) {
  const path = inboxPath(repo);
  if (!existsSync(path))
    return [];
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const record = elevate(JSON.parse(line), INBOX_ELEVATORS, INBOX_SCHEMA_VERSION);
        const problems = validate(record, INBOX_SCHEMA);
        if (problems.length) {
          console.error(`sm: skipping malformed inbox line (${problems.join('; ')})`);
          return null;
        }
        return record;
      }
      catch {
        return null;
      }
    })
    .filter(Boolean);
  return sinceTs != null ? entries.filter(record => record.ts > sinceTs) : entries;
}

/**
 * Shape oldest-first inbox entries for display: keep only the most recent `number` (the last N),
 * then optionally reverse to newest-first. Pure - the display knobs for `sm msg inbox`.
 * @param {object[]} entries - Inbox entries, oldest first (as readInbox returns them).
 * @param {object} [options] - Shaping options.
 * @param {string|number} [options.number] - Keep only the most recent N; ignored unless a non-negative integer.
 * @param {boolean} [options.newestFirst] - Reverse so the newest entry prints first.
 * @returns {object[]} The shaped entries.
 */
export function shapeInbox(entries, { number, newestFirst = false } = {}) {
  let out = entries;
  const keep = Number(number);
  // slice(-0) === slice(0) returns the whole array, so N=0 must be special-cased to empty.
  if (number != null && Number.isInteger(keep) && keep >= 0)
    out = keep === 0 ? [] : out.slice(-keep);
  return newestFirst ? [...out].reverse() : out;
}

const CURSOR_SCHEMA = loadSchema('inbox-cursor.schema.json');
const CURSOR_KINDS = ['read', 'surfaced'];

/**
 * Cursor/watch state lives in a SIBLING of the inbox dir, never inside it: waitForReports
 * fs.watches the inbox dir, and a state write in there would wake every watcher on
 * every non-destructive read. Exported for the watch's armed marker (same invariant).
 * @returns {string} the state directory path.
 */
export function inboxStateDir() {
  const override = process.env.SLOT_INBOX_DIR;
  return override ? `${override}-state` : join(homedir(), '.config', 'slot', 'inbox-state');
}
const stateDir = inboxStateDir;

function cursorPath(repo, kind) {
  if (!CURSOR_KINDS.includes(kind))
    throw new Error(`unknown cursor kind '${kind}' (expected: ${CURSOR_KINDS.join(', ')})`);
  return join(stateDir(), `${repo || 'default'}.${kind}.json`);
}

/**
 * A repo's cursor position, or 0 when never advanced. Absent/corrupt files read as 0 -
 * fail toward "everything unread": a lost cursor re-shows reports, never loses them.
 * @param {string} repo - Repo identifier.
 * @param {'read'|'surfaced'} kind - Which cursor.
 * @returns {number} newest consumed ts, or 0.
 */
export function readCursor(repo, kind) {
  try {
    const doc = JSON.parse(readFileSync(cursorPath(repo, kind), 'utf8'));
    return validate(doc, CURSOR_SCHEMA).length ? 0 : doc.ts;
  }
  catch (err) {
    if (err.message?.startsWith('unknown cursor kind'))
      throw err;
    return 0;
  }
}

/**
 * Advance a cursor FORWARD to ts; a backward or equal move is ignored (monotonic, like
 * the inbox stamps it tracks - a stale caller can never un-read newer reports).
 * @param {string} repo - Repo identifier.
 * @param {'read'|'surfaced'} kind - Which cursor.
 * @param {number} ts - Candidate position (newest ts just consumed).
 * @returns {number} the resulting cursor position.
 */
export function advanceCursor(repo, kind, ts) {
  const current = readCursor(repo, kind);
  if (!(ts > current))
    return current;
  const doc = { v: 1, ts };
  const problems = validate(doc, CURSOR_SCHEMA);
  if (problems.length)
    throw new Error(`invalid cursor: ${problems.join('; ')}`);
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(cursorPath(repo, kind), `${JSON.stringify(doc)}\n`);
  return ts;
}

/**
 * Drop both cursor files (a cleared inbox has nothing unread or unsurfaced).
 * @param {string} repo - Repo identifier.
 */
export function deleteCursors(repo) {
  for (const kind of CURSOR_KINDS)
    rmSync(cursorPath(repo, kind), { force: true });
}

/**
 * Cursor-based inbox counts for floor and starvation checks: raw total, unread
 * (ts > read cursor), and the oldest unread ts (null when nothing is unread).
 * @param {string} repo - Repo identifier.
 * @returns {{unread: number, total: number, oldestUnreadTs: number|null}} the counts.
 */
export function inboxCounts(repo) {
  const entries = readInbox(repo);
  const unread = entries.filter(record => record.ts > readCursor(repo, 'read'));
  return { unread: unread.length, total: entries.length, oldestUnreadTs: unread[0]?.ts ?? null };
}

/**
 * Clear all entries from a repo's inbox, and both cursors with them.
 * @param {string} repo - Repo identifier.
 */
export function clearInbox(repo) {
  withInboxLock(repo, () => {
    const path = inboxPath(repo);
    if (existsSync(path))
      writeFileSync(path, '');
    deleteCursors(repo);
  });
}

/**
 * Consume exactly the already-displayed reports without touching the rest: rewrite the inbox
 * keeping every entry whose ts is not in `tsList`. `msg inbox --watch --clear` uses this so it
 * drops only the reports it printed - reports that arrived before the watch (never displayed)
 * or during the print stay. Timestamps are unique and monotonic (appendReport enforces it), so
 * a ts set identifies entries exactly - unlike the index ranges this replaces, which shifted
 * under a concurrent clear/consume rewrite.
 * @param {string} repo - Repo identifier.
 * @param {number[]} tsList - Timestamps of the displayed entries to consume.
 */
export function consumeReports(repo, tsList) {
  const drop = new Set(tsList);
  // Read-modify-write under the lock: re-read inside the critical section so a report appended
  // during/after the display is preserved rather than clobbered by the rewrite.
  withInboxLock(repo, () => {
    const kept = readInbox(repo).filter(record => !drop.has(record.ts));
    writeFileSync(inboxPath(repo), kept.map(record => `${JSON.stringify(record)}\n`).join(''));
  });
}

/**
 * Standing subscription: a persistent fs.watch on the inbox dir that NUDGES on change.
 * The nudge carries no data - the consumer re-reads via readInbox({sinceTs}) with its own
 * cursor, so a missed or collapsed nudge can never lose a record. Bursts are debounced
 * (one wake per 50ms window); a slow safety interval covers platforms where fs.watch
 * misses events. This is waitForReports' machinery made persistent, for long-lived
 * consumers (sm serve's SSE stream).
 * @param {string} repo - Repo identifier.
 * @param {() => void} onWake - Called (with nothing) when the inbox may have changed.
 * @returns {() => void} unsubscribe - idempotent; no wakes after it returns.
 */
export function subscribeReports(repo, onWake) {
  mkdirSync(inboxDir(), { recursive: true });
  const target = basename(inboxPath(repo));
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
    watcher = watch(inboxDir(), (_event, fname) => {
      if (!fname || fname === target)
        nudge();
    });
  }
  catch { /* fs.watch unavailable: the safety interval carries it */ }
  const safety = setInterval(nudge, INBOX_POLL_MS);
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
 * Push-based subscribe: resolve with the entries newer than `baselineTs` the moment one lands.
 * fs.watch on the inbox dir rides FSEvents/inotify (a real wakeup, not a poll); a slow safety
 * check covers any missed event, and `timeoutMs` resolves [] so a caller never hangs forever.
 * The baseline is a TIMESTAMP, not a length: a destructive `--clear`/consume in another process
 * shrinks the file, and a length baseline would then never trip (the latent bug this replaces) -
 * ts baselines survive rewrites because appendReport's stamps are strictly monotonic.
 * @param {string} repo - Repo identifier.
 * @param {object} [options] - Wait options.
 * @param {number} [options.baselineTs] - Newest ts already seen; defaults to the current newest.
 * @param {number} [options.timeoutMs] - Max wait before resolving []; defaults to INBOX_WAIT_MS.
 * @param {number} [options.safetyMs] - Safety poll interval in ms; defaults to INBOX_POLL_MS.
 * @returns {Promise<object[]>} Entries newer than the baseline, or [] on timeout.
 */
export function waitForReports(repo, { baselineTs, timeoutMs = INBOX_WAIT_MS, safetyMs = INBOX_POLL_MS } = {}) {
  const base = baselineTs ?? lastEntryTs(repo);
  mkdirSync(inboxDir(), { recursive: true });
  const target = basename(inboxPath(repo));
  return new Promise((resolve) => {
    let done = false;
    let watcher;
    // finish closes over safety/deadline before their declarations; nothing can call it
    // until after both are initialized (fs.watch events never fire in the same tick).
    const finish = (val) => {
      if (done)
        return;
      done = true;
      watcher?.close();
      clearInterval(safety);
      clearTimeout(deadline);
      resolve(val);
    };
    const check = () => {
      const fresh = readInbox(repo, { sinceTs: base });
      if (fresh.length)
        finish(fresh);
    };
    try {
      watcher = watch(inboxDir(), (_event, fname) => {
        if (!fname || fname === target)
          check();
      });
    }
    catch {
      /* fs.watch unavailable -> safety interval carries it */
    }
    const safety = setInterval(check, safetyMs);
    const deadline = setTimeout(finish, timeoutMs, []);
    check(); // close the race: a report that landed before the watcher armed
  });
}
