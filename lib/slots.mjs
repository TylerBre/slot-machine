// Slot logic: pure classification/parsing (unit-tested) + tmux/git/gh state gatherers.
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { docs, PREFIX, SESSION_PREFIX, BASE_BRANCH, STALE_LOCK_SEC, SHELL_CMDS } from './constants.mjs';
import { die } from './format.mjs';
import { tmuxOut, run, repoSlug, slotGit, prMap, listSlots } from './exec.mjs';

// --- pure logic (unit-tested) --------------------------------------------

// Resolve a --slots SPEC to a Set of slot labels, validated against `labels`
// (ordered a,b,c,...). SPEC is a comma/space list of tokens; each token is an exact
// slot label (a, hotfix), a 1-based number (1 == labels[0]), or an inclusive range of
// letters or numbers (d-f, 3-6). Throws Error on anything malformed or out of range.
export function resolveSlots(spec, labels) {
  const n = labels.length;
  const have = new Set(labels);
  const want = new Set();
  const digits = (s) => /^[0-9]+$/.test(s);
  const letter = (s) => /^[a-z]$/.test(s);

  for (const tok of spec.split(/[,\s]+/)) {
    if (!tok) continue;
    if (have.has(tok)) {
      want.add(tok); // exact label match (covers multi-char labels like 'hotfix')
      continue;
    }
    const dash = tok.indexOf('-');
    const [lo, hi] = dash >= 0 ? [tok.slice(0, dash), tok.slice(dash + 1)] : [tok, tok];

    if (digits(lo) && digits(hi)) {
      const a = Number(lo),
        b = Number(hi);
      if (a < 1 || b > n || a > b) throw new Error(`slot index out of range '${tok}' (have 1-${n})`);
      for (let i = a; i <= b; i++) want.add(labels[i - 1]);
    } else if (letter(lo) && letter(hi)) {
      const a = lo.charCodeAt(0),
        b = hi.charCodeAt(0);
      if (a > b) throw new Error(`bad slot range '${tok}'`);
      for (let c = a; c <= b; c++) {
        const ch = String.fromCharCode(c);
        if (!have.has(ch)) throw new Error(`no such slot '${ch}'`);
        want.add(ch);
      }
    } else {
      throw new Error(`bad --slots token '${tok}'`);
    }
  }
  return want;
}

// Given tmux list-panes lines ("pane_id start_path"), pick the slot panes under
// `docsDir`, optionally filtered to `want` (a Set of labels, or null for all).
// Returns [{ pid, lbl }] in input order.
export function selectPanes(paneLines, root, prefix, want) {
  const base = `${root}/${prefix}`;
  const out = [];
  for (const line of paneLines) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const pid = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (!path.startsWith(base)) continue;
    const lbl = path.slice(base.length);
    if (lbl === '' || lbl.includes('/')) continue; // must be exactly the slot root
    if (want && !want.has(lbl)) continue;
    out.push({ pid, lbl });
  }
  return out;
}

// Decide a slot worktree's status from its checked-out branch (+ how far ahead of main)
// and that branch's GH PR state. `free` is the reusability flag (true for free + merged).
export function classifySlot({ branch, baseBranch, locked, dirty, ahead, prs }) {
  if (locked) return { free: false, status: 'locked' };
  if (dirty) return { free: false, status: 'dirty' };
  const open = prs.filter((p) => p.state === 'OPEN');
  const merged = prs.filter((p) => p.state === 'MERGED');
  if (open.length) return { free: false, status: 'waiting-merge' };
  if (prs.length && merged.length === prs.length) return { free: true, status: 'merged' };
  if (prs.length) return { free: false, status: 'closed-pr' };
  if (branch === baseBranch && ahead === 0) return { free: true, status: 'free' };
  if (ahead > 0) return { free: false, status: 'wip' };
  return { free: true, status: 'free' };
}

// Is a held lock stale (reclaimable)? slot-machine owns liveness: a lock is stale when its
// claiming worker's pane is dead/gone (workerLive false). For a lock that carries a transcript,
// it is also stale when that transcript has gone quiet past thresholdSec (abandoned-but-alive).
// A slot-written lock (no transcript) on a live worker is a live claim - never stale.
export function lockStale({ workerLive = true, transcript = null, transcriptAgeSec, thresholdSec }) {
  if (!workerLive) return true;
  if (!transcript) return false;
  return transcriptAgeSec == null || transcriptAgeSec > thresholdSec;
}

// A slot that classifies as reusable (free/merged) but has a live worker actively working is
// NOT actually free - it was likely just handed a task and hasn't cut a branch or written a
// lock yet. Returns an override {free,status}, or null to keep the original classification.
// Guards the dispatcher against dispatching over live work (see slotFreenessRows).
export function activeOverride({ free, worker, activity }) {
  if (free && worker === 'live' && activity === 'working') return { free: false, status: 'active' };
  return null;
}

// Pick a slot to dispatch fresh work to: a reusable one (free first, then merged) that
// still has a live Claude worker in its pane. Returns the row, or null if none qualify.
export function pickDispatchSlot(rows) {
  return (
    rows.find((r) => r.status === 'free' && r.worker === 'live') ||
    rows.find((r) => r.status === 'merged' && r.worker === 'live') ||
    null
  );
}

// Which role is running, from the current directory: inside a slot worktree => 'worker'
// (with the slot label); anywhere else (e.g. the desk shell) => 'dispatcher'.
export function detectRole(cwd, root, prefix) {
  const p = `${root}/${prefix}`;
  if (!cwd.startsWith(p)) return { role: 'dispatcher', slot: null };
  return { role: 'worker', slot: cwd.slice(p.length).split('/')[0] };
}

// preflight decision (pure): is `cwd` a safe place for a slot worker to do git work? Returns the
// slot when inside a slot worktree; flags the main checkout specially so the caller can shout.
export function preflightStatus(cwd, { root, prefix, repoDir }) {
  const det = detectRole(cwd, root, prefix);
  if (det.role === 'worker' && det.slot) return { ok: true, status: 'slot', slot: det.slot };
  if (repoDir && (cwd === repoDir || cwd.startsWith(repoDir + '/')))
    return { ok: false, status: 'main-checkout', slot: null };
  return { ok: false, status: 'outside', slot: null };
}

// Classify what a slot pane is doing from its captured content. 'working' = the Claude
// footer shows live activity (token counter / "esc to interrupt"); 'waiting' = a
// permission/selection prompt; 'idle' = at the composer; 'no-pane' = nothing captured.
export function paneActivity(capture, hasPane) {
  if (!hasPane) return 'no-pane';
  if (/esc to interrupt|· ↓|· ↑|tokens\)/.test(capture)) return 'working';
  if (/Do you want|❯ [0-9]\.|Would you like to proceed|Allow this/.test(capture)) return 'waiting';
  return 'idle';
}

// --- state gatherers ------------------------------------------------------

// Read a slot's .worktree-lock, if present. `owner` is parsed from the transcript path,
// which flags cross-wiring (a lock whose transcript points at a different slot).
export function readLock(dir) {
  const p = join(dir, '.worktree-lock');
  if (!existsSync(p)) return null;
  try {
    const l = JSON.parse(readFileSync(p, 'utf8'));
    const t = l.transcript || '';
    const i = t.lastIndexOf(PREFIX);
    let owner = null;
    if (i >= 0) {
      const rest = t.slice(i + PREFIX.length);
      const j = rest.indexOf('/');
      owner = j >= 0 ? rest.slice(0, j) : rest;
    }
    return { session: l.session, ts: l.ts, task: l.task ?? null, transcript: l.transcript, owner };
  } catch {
    return { unparseable: true };
  }
}

// Claim a slot by writing .worktree-lock. slot-machine owns the lock lifecycle: dispatch
// claims, reset/unlock release. Liveness is judged from the live pane, so no transcript needed.
export function writeLock(dir, { session = null, pane = null, task = null } = {}) {
  const label = dir.slice(dir.lastIndexOf('/') + 1).replace(PREFIX, '');
  const lock = { slot: label, session, pane, task, ts: Date.now() };
  writeFileSync(join(dir, '.worktree-lock'), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

// Release a slot's lock (reclaim). Returns true if a lock file was removed.
export function removeLock(dir) {
  try {
    unlinkSync(join(dir, '.worktree-lock'));
    return true;
  } catch {
    return false;
  }
}

// seconds since the lock owner's transcript was last written; null if it's gone.
export function lockTranscriptAge(lock) {
  if (!lock || !lock.transcript || !existsSync(lock.transcript)) return null;
  try {
    return Math.floor((Date.now() - statSync(lock.transcript).mtimeMs) / 1000);
  } catch {
    return null;
  }
}

// Normalize a user-given slot reference (label or full worktree name) once - the one
// canonical strip is slice(PREFIX.length), never replace() (which can mangle labels
// containing the prefix substring mid-string).
export function slotRef(arg) {
  const name = arg.startsWith(PREFIX) ? arg : PREFIX + arg;
  const label = name.slice(PREFIX.length);
  const dir = join(docs, name);
  return { name, label, dir, exists: existsSync(dir) };
}

// Is a held lock a LIVE claim? One place builds the lockStale() args so call sites
// cannot drift (two once dropped workerLive and misjudged every lock as live).
export function lockIsLive(lock, workerLive, thresholdSec = STALE_LOCK_SEC) {
  if (!lock || lock.unparseable) return false;
  return !lockStale({
    workerLive,
    transcript: lock.transcript,
    transcriptAgeSec: lockTranscriptAge(lock),
    thresholdSec,
  });
}

// slot label -> 'live' (a pane is running something - Claude reports its version string as
// the command, e.g. "2.1.201", or a subprocess like git) | 'dead' (a pane fell back to a
// bare shell = Claude exited). Absent => no pane in any running session.
export function slotWorkerMap() {
  const out = tmuxOut(['list-panes', '-a', '-F', '#{pane_start_path} #{pane_current_command}']) ?? '';
  const m = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const lbl = paneSlotLabel(line.slice(0, sp));
    if (lbl == null) continue;
    const live = !SHELL_CMDS.has(line.slice(sp + 1));
    m.set(lbl, m.get(lbl) === 'live' || live ? 'live' : 'dead');
  }
  return m;
}

// A pane counts as a slot's only when its start path is exactly the slot worktree root
// under `docs` - the same rule selectPanes applies, so every gatherer agrees on which
// panes are workers. Returns the label, or null.
function paneSlotLabel(path) {
  const base = `${docs}/${PREFIX}`;
  if (!path.startsWith(base)) return null;
  const lbl = path.slice(base.length);
  return lbl === '' || lbl.includes('/') ? null : lbl;
}

// slot label -> pane location { session, window, pane } (prefers an attached session),
// for slots with a running pane. The single pane resolver - logs/focus/kill/ps all use it.
export function slotPanes() {
  const out =
    tmuxOut([
      'list-panes',
      '-a',
      '-F',
      '#{session_attached}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_start_path}',
    ]) ?? '';
  const best = new Map(); // label -> { session, window, pane, att }
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [att, session, window, pane, path] = line.split('\t');
    if (!path) continue;
    const lbl = paneSlotLabel(path);
    if (lbl == null) continue;
    const a = Number(att) || 0;
    const prev = best.get(lbl);
    if (!prev || a > prev.att) best.set(lbl, { session, window, pane, att: a });
  }
  const m = new Map();
  for (const [lbl, v] of best) m.set(lbl, { session: v.session, window: v.window, pane: v.pane });
  return m;
}

// Running tmux sessions whose name starts with the configured session prefix.
export function slotSessions() {
  const out =
    tmuxOut(['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}']) ?? '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached] = line.split('\t');
      return { name, windows: Number(windows), attached: attached === '1' };
    })
    .filter((s) => s.name.startsWith(SESSION_PREFIX));
}

export const slotPaneCount = (session) =>
  selectPanes(
    (tmuxOut(['list-panes', '-s', '-t', session, '-F', '#{pane_id} #{pane_start_path}']) ?? '').split('\n'),
    docs,
    PREFIX,
    null,
  ).length;

export const sessionRows = () => slotSessions().map((s) => ({ ...s, slots: slotPaneCount(s.name) }));

// Classify every slot worktree (git fetch + one gh call + per-slot git, concurrently),
// sorted by slot name. Adds live/dead worker and stale-lock detection.
export async function slotFreenessRows() {
  const slots = listSlots();
  if (!slots.length) die(`ls: no ${PREFIX}* worktrees in ${docs} - create one: sm slot create a`);
  const first = join(docs, slots[0]);
  await run('git', ['-C', first, 'fetch', '-q', 'origin', BASE_BRANCH]); // freshen base branch for accurate ahead counts
  const prs = await prMap(await repoSlug(first));
  const workers = slotWorkerMap();
  const panes = slotPanes();
  const rows = await Promise.all(
    slots.map(async (name) => {
      const dir = join(docs, name);
      const short = name.slice(PREFIX.length);
      const { branch, dirty, ahead } = await slotGit(dir);
      const lock = readLock(dir);
      const branchPrs = prs.get(branch) || [];
      const worker = workers.get(short) || 'none';
      const v = classifySlot({ branch, baseBranch: name, locked: !!lock, dirty, ahead, prs: branchPrs });
      let { free, status } = v;
      // Lock is authoritative: a live claim (or dead-owner stale) beats any git-state guess.
      if (status === 'locked' && !lockIsLive(lock, worker === 'live')) status = 'stale';
      // Backstop: reusable-looking + a live worker mid-task (no lock yet) => not free; don't dispatch over it.
      else if (free && worker === 'live') {
        const pane = panes.get(short)?.pane;
        const activity = paneActivity(
          pane ? (tmuxOut(['capture-pane', '-p', '-t', pane]) ?? '') : '',
          !!pane,
        );
        const ov = activeOverride({ free, worker, activity });
        if (ov) ({ free, status } = ov);
      }
      return { slot: short, branch, free, status, prs: branchPrs, worker };
    }),
  );
  return rows.sort((a, b) => a.slot.localeCompare(b.slot));
}
