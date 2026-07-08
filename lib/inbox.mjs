// Worker -> dispatcher back-channel: a per-repo append-only message inbox. A worker runs
// `sm msg report "<msg>"` to reach the dispatcher; the dispatcher reads with `sm msg inbox`.
// Screen-scraping panes was the old (lossy) channel; this is the structured one.
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, watch } from 'node:fs';

// Overridable for tests. Per-repo JSONL under the config dir.
function inboxDir() {
  return process.env.SLOT_INBOX_DIR || join(homedir(), '.config', 'slot', 'inbox');
}
export function inboxPath(repo) {
  return join(inboxDir(), `${repo || 'default'}.jsonl`);
}

// Append one report. entry: { slot, message }. Stamps ts (epoch ms).
export function appendReport(repo, { slot = null, message }) {
  mkdirSync(inboxDir(), { recursive: true });
  appendFileSync(inboxPath(repo), JSON.stringify({ ts: Date.now(), slot, message }) + '\n');
}

// All inbox entries for a repo, oldest first. Skips unparseable lines.
export function readInbox(repo) {
  const p = inboxPath(repo);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function clearInbox(repo) {
  const p = inboxPath(repo);
  if (existsSync(p)) writeFileSync(p, '');
}

// Push-based subscribe: resolve with the entries newer than `baseline` the moment one lands.
// fs.watch on the inbox dir rides FSEvents/inotify (a real wakeup, not a poll); a slow safety
// check covers any missed event, and `timeoutMs` resolves [] so a caller never hangs forever.
export function waitForReports(repo, { baseline, timeoutMs = 40 * 60 * 1000, safetyMs = 60_000 } = {}) {
  const base = baseline ?? readInbox(repo).length;
  mkdirSync(inboxDir(), { recursive: true });
  const target = basename(inboxPath(repo));
  return new Promise((resolve) => {
    let done = false;
    let watcher;
    // finish closes over safety/deadline before their declarations; nothing can call it
    // until after both are initialized (fs.watch events never fire in the same tick).
    const finish = (val) => {
      if (done) return;
      done = true;
      watcher?.close();
      clearInterval(safety);
      clearTimeout(deadline);
      resolve(val);
    };
    const check = () => {
      const all = readInbox(repo);
      if (all.length > base) finish(all.slice(base));
    };
    try {
      watcher = watch(inboxDir(), (_event, fname) => {
        if (!fname || fname === target) check();
      });
    } catch {
      /* fs.watch unavailable -> safety interval carries it */
    }
    const safety = setInterval(check, safetyMs);
    const deadline = setTimeout(() => finish([]), timeoutMs);
    check(); // close the race: a report that landed before the watcher armed
  });
}
