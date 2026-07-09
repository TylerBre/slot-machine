// Worker -> dispatcher back-channel: a per-repo append-only message inbox. A worker runs
// `sm msg report "<msg>"` to reach the dispatcher; the dispatcher reads with `sm msg inbox`.
// Screen-scraping panes was the old (lossy) channel; this is the structured one.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
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
 * Append one report. entry: { slot, message }. Stamps ts (epoch ms).
 * @param {string} repo - Repo identifier.
 * @param {object} entry - The report to append.
 * @param {string|null} [entry.slot] - Originating slot, or null.
 * @param {string} entry.message - The message text.
 */
export function appendReport(repo, { slot = null, message }) {
  const record = { v: INBOX_SCHEMA_VERSION, ts: Date.now(), slot, message };
  const problems = validate(record, INBOX_SCHEMA);
  if (problems.length)
    throw new Error(`invalid inbox report: ${problems.join('; ')}`);
  // Under the lock so an append never interleaves with a concurrent consume/clear rewrite.
  withInboxLock(repo, () => appendFileSync(inboxPath(repo), `${JSON.stringify(record)}\n`));
}

/**
 * All inbox entries for a repo, oldest first. Skips unparseable lines.
 * @param {string} repo - Repo identifier.
 * @returns {object[]} Parsed inbox entries, oldest first.
 */
export function readInbox(repo) {
  const path = inboxPath(repo);
  if (!existsSync(path))
    return [];
  return readFileSync(path, 'utf8')
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

/**
 * Clear all entries from a repo's inbox.
 * @param {string} repo - Repo identifier.
 */
export function clearInbox(repo) {
  withInboxLock(repo, () => {
    const path = inboxPath(repo);
    if (existsSync(path))
      writeFileSync(path, '');
  });
}

/**
 * Consume a contiguous run of already-displayed reports without touching the rest: rewrite the
 * inbox keeping every entry except those at [from, to). `msg inbox --watch --clear` uses this so it
 * drops only the reports it printed - reports that arrived before the watch (never displayed) or
 * during the print stay. The inbox is append-only, so older entries never move and the range holds.
 * @param {string} repo - Repo identifier.
 * @param {number} from - Index of the first displayed entry.
 * @param {number} to - Index just past the last displayed entry.
 */
export function consumeReports(repo, from, to) {
  // Read-modify-write under the lock: re-read inside the critical section so a report appended
  // after `to` (during/after the display) is preserved rather than clobbered by the rewrite.
  withInboxLock(repo, () => {
    const kept = readInbox(repo).filter((_entry, index) => index < from || index >= to);
    writeFileSync(inboxPath(repo), kept.map(record => `${JSON.stringify(record)}\n`).join(''));
  });
}

/**
 * Push-based subscribe: resolve with the entries newer than `baseline` the moment one lands.
 * fs.watch on the inbox dir rides FSEvents/inotify (a real wakeup, not a poll); a slow safety
 * check covers any missed event, and `timeoutMs` resolves [] so a caller never hangs forever.
 * @param {string} repo - Repo identifier.
 * @param {object} [options] - Wait options.
 * @param {number} [options.baseline] - Entry count already seen; defaults to current inbox length.
 * @param {number} [options.timeoutMs] - Max wait before resolving []; defaults to INBOX_WAIT_MS.
 * @param {number} [options.safetyMs] - Safety poll interval in ms; defaults to INBOX_POLL_MS.
 * @returns {Promise<object[]>} Entries newer than the baseline, or [] on timeout.
 */
export function waitForReports(repo, { baseline, timeoutMs = INBOX_WAIT_MS, safetyMs = INBOX_POLL_MS } = {}) {
  const base = baseline ?? readInbox(repo).length;
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
      const all = readInbox(repo);
      if (all.length > base)
        finish(all.slice(base));
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
