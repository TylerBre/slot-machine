// Slot logic: pure classification/parsing (unit-tested). Zero IO - only depends on constants.
import { PREFIX } from '../constants.mjs';

/**
 * Resolve a --slots SPEC to a Set of slot labels, validated against `labels`
 * (ordered a,b,c,...). SPEC is a comma/space list of tokens; each token is an exact
 * slot label (a, hotfix), a 1-based number (1 == labels[0]), or an inclusive range of
 * letters or numbers (d-f, 3-6). Throws Error on anything malformed or out of range.
 * @param {string} spec - comma/space list of slot tokens.
 * @param {string[]} labels - ordered slot labels to validate against.
 * @returns {Set<string>} the resolved set of slot labels.
 */
export function resolveSlots(spec, labels) {
  const count = labels.length;
  const have = new Set(labels);
  const want = new Set();
  const digits = str => /^\d+$/.test(str);
  const letter = str => /^[a-z]$/.test(str);

  for (const tok of spec.split(/[,\s]+/)) {
    if (!tok)
      continue;
    if (have.has(tok)) {
      want.add(tok); // exact label match (covers multi-char labels like 'hotfix')
      continue;
    }
    const dash = tok.indexOf('-');
    const [lo, hi] = dash >= 0 ? [tok.slice(0, dash), tok.slice(dash + 1)] : [tok, tok];

    if (digits(lo) && digits(hi)) {
      const lowNum = Number(lo);
      const highNum = Number(hi);
      if (lowNum < 1 || highNum > count || lowNum > highNum)
        throw new Error(`slot index out of range '${tok}' (have 1-${count})`);
      for (let index = lowNum; index <= highNum; index++) want.add(labels[index - 1]);
    }
    else if (letter(lo) && letter(hi)) {
      const lowCode = lo.charCodeAt(0);
      const highCode = hi.charCodeAt(0);
      if (lowCode > highCode)
        throw new Error(`bad slot range '${tok}'`);
      for (let code = lowCode; code <= highCode; code++) {
        const ch = String.fromCharCode(code);
        if (!have.has(ch))
          throw new Error(`no such slot '${ch}'`);
        want.add(ch);
      }
    }
    else {
      throw new Error(`bad --slots token '${tok}'`);
    }
  }
  return want;
}

/**
 * Given tmux list-panes lines ("pane_id start_path"), pick the slot panes under
 * `docsDir`, optionally filtered to `want` (a Set of labels, or null for all).
 * Returns [{ pid, lbl }] in input order.
 * @param {string[]} paneLines - tmux list-panes output lines ("pane_id start_path").
 * @param {string} root - the docs root directory.
 * @param {string} prefix - the slot worktree name prefix.
 * @param {Set<string>|null} want - labels to keep, or null for all.
 * @returns {Array<{pid: string, lbl: string}>} the matching slot panes in input order.
 */
export function selectPanes(paneLines, root, prefix, want) {
  const base = `${root}/${prefix}`;
  const out = [];
  for (const line of paneLines) {
    if (!line)
      continue;
    const sp = line.indexOf(' ');
    if (sp < 0)
      continue;
    const pid = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (!path.startsWith(base))
      continue;
    const lbl = path.slice(base.length);
    if (lbl === '' || lbl.includes('/'))
      continue; // must be exactly the slot root
    if (want && !want.has(lbl))
      continue;
    out.push({ pid, lbl });
  }
  return out;
}

/**
 * Decide a slot worktree's status from its checked-out branch (+ how far ahead of main)
 * and that branch's GH PR state. `free` is the reusability flag (true for free + merged).
 * @param {object} state - the gathered slot state.
 * @param {string} state.branch - the checked-out branch name.
 * @param {string} state.baseBranch - the branch a fresh/reset slot sits on (its own worktree
 *   branch, named after the slot); a slot on exactly this branch with 0 commits ahead is free.
 * @param {boolean} state.locked - whether the slot holds a lock.
 * @param {boolean} state.dirty - whether the worktree has uncommitted changes.
 * @param {number|null} state.ahead - commits ahead of the base branch; null when it could not
 *   be computed (origin/<base> unresolvable) - treated as unknown, never as zero.
 * @param {object[]} state.prs - the branch's PRs.
 * @returns {{free: boolean, status: string}} the slot's freeness and status.
 */
export function classifySlot({ branch, baseBranch, locked, dirty, ahead, prs }) {
  if (locked)
    return { free: false, status: 'locked' };
  if (dirty)
    return { free: false, status: 'dirty' };
  const open = prs.filter(pr => pr.state === 'OPEN');
  const merged = prs.filter(pr => pr.state === 'MERGED');
  if (open.length)
    return { free: false, status: 'waiting-merge' };
  if (prs.length && merged.length === prs.length)
    return { free: true, status: 'merged' };
  if (prs.length)
    return { free: false, status: 'closed-pr' };
  // ahead could not be computed (base unresolvable): fail safe - do NOT expose a possibly-WIP
  // slot as reusable, or the dispatcher may clobber committed-but-unpushed work.
  if (ahead == null)
    return { free: false, status: 'unknown' };
  if (branch === baseBranch && ahead === 0)
    return { free: true, status: 'free' };
  if (ahead > 0)
    return { free: false, status: 'wip' };
  return { free: true, status: 'free' };
}

/**
 * Is a held lock stale (reclaimable)? slot-machine owns liveness: a lock is stale when its
 * claiming worker's pane is dead/gone (workerLive false). For a lock that carries a transcript,
 * it is also stale when that transcript has gone quiet past thresholdSec (abandoned-but-alive).
 * A slot-written lock (no transcript) on a live worker is a live claim - never stale.
 * @param {object} args - the staleness inputs.
 * @param {boolean} args.workerLive - whether the claiming worker's pane is alive.
 * @param {string|null} args.transcript - the lock's transcript path, if any.
 * @param {number|null} args.transcriptAgeSec - seconds since the transcript was written.
 * @param {number} args.thresholdSec - staleness threshold in seconds.
 * @returns {boolean} true when the lock is stale.
 */
export function lockStale({ workerLive = true, transcript = null, transcriptAgeSec, thresholdSec }) {
  if (!workerLive)
    return true;
  if (!transcript)
    return false;
  return transcriptAgeSec == null || transcriptAgeSec > thresholdSec;
}

/**
 * A slot that classifies as reusable (free/merged) but has a live worker actively working is
 * NOT actually free - it was likely just handed a task and hasn't cut a branch or written a
 * lock yet. Returns an override {free,status}, or null to keep the original classification.
 * Guards the dispatcher against dispatching over live work (see slotFreenessRows).
 * @param {object} row - the slot row fields to inspect.
 * @param {boolean} row.free - whether the slot classified as reusable.
 * @param {string} row.worker - the worker liveness ('live'/'dead'/'none').
 * @param {string} row.activity - the pane activity ('working'/'waiting'/'idle'/'no-pane').
 * @returns {{free: boolean, status: string}|null} an override, or null to keep the classification.
 */
export function activeOverride({ free, worker, activity }) {
  if (free && worker === 'live' && activity === 'working')
    return { free: false, status: 'active' };
  return null;
}

/**
 * Pick a slot to dispatch fresh work to: a reusable one (free first, then merged) that
 * still has a live Claude worker in its pane. Returns the row, or null if none qualify.
 * @param {object[]} rows - the classified slot rows.
 * @returns {object|null} the chosen slot row, or null if none qualify.
 */
export function pickDispatchSlot(rows) {
  return (
    rows.find(row => row.status === 'free' && row.worker === 'live')
    || rows.find(row => row.status === 'merged' && row.worker === 'live')
    || null
  );
}

/**
 * Which role is running, from the current directory: inside a slot worktree => 'worker'
 * (with the slot label); anywhere else (e.g. the desk shell) => 'dispatcher'.
 * @param {string} cwd - the current working directory.
 * @param {string} root - the docs root directory.
 * @param {string} prefix - the slot worktree name prefix.
 * @returns {{role: string, slot: string|null}} the detected role and slot label.
 */
export function detectRole(cwd, root, prefix) {
  const base = `${root}/${prefix}`;
  if (!cwd.startsWith(base))
    return { role: 'dispatcher', slot: null };
  return { role: 'worker', slot: cwd.slice(base.length).split('/')[0] };
}

/**
 * preflight decision (pure): is `cwd` a safe place for a slot worker to do git work? Returns the
 * slot when inside a slot worktree; flags the main checkout specially so the caller can shout.
 * @param {string} cwd - the current working directory.
 * @param {object} config - path configuration.
 * @param {string} config.root - the docs root directory.
 * @param {string} config.prefix - the slot worktree name prefix.
 * @param {string} config.repoDir - the main repo checkout directory.
 * @returns {{ok: boolean, status: string, slot: string|null}} the preflight decision.
 */
export function preflightStatus(cwd, { root, prefix, repoDir }) {
  const det = detectRole(cwd, root, prefix);
  if (det.role === 'worker' && det.slot)
    return { ok: true, status: 'slot', slot: det.slot };
  if (repoDir && (cwd === repoDir || cwd.startsWith(`${repoDir}/`)))
    return { ok: false, status: 'main-checkout', slot: null };
  return { ok: false, status: 'outside', slot: null };
}

/**
 * Classify what a slot pane is doing from its captured content. 'working' = the Claude
 * footer shows live activity (token counter / "esc to interrupt"); 'waiting' = a
 * permission/selection prompt; 'idle' = at the composer; 'no-pane' = nothing captured.
 * @param {string} capture - the captured pane content.
 * @param {boolean} hasPane - whether the slot has a live pane.
 * @returns {string} the activity ('working'/'waiting'/'idle'/'no-pane').
 */
export function paneActivity(capture, hasPane) {
  if (!hasPane)
    return 'no-pane';
  if (/esc to interrupt|· ↓|· ↑|tokens\)/.test(capture))
    return 'working';
  if (/Do you want|❯ \d\.|Would you like to proceed|Allow this/.test(capture))
    return 'waiting';
  return 'idle';
}

/**
 * Parse a tracker issue id (e.g. "sc-10132") from arbitrary text - a branch name or a task
 * message. Generic, not tied to any tracker: <letters>-<digits> or <letters><digits>, normalized
 * to a dash form. Returns null when none. The one issue-parsing rule.
 * @param {string} text - the text to parse an issue id from.
 * @returns {string|null} the normalized issue id, or null when none.
 */
export function issueFromText(text) {
  const match = text && String(text).match(/\b([a-z]{2,5})-?(\d{2,})\b/i);
  return match ? `${match[1].toLowerCase()}-${match[2]}` : null;
}

/**
 * The slot label is the worktree basename minus the PREFIX - the one derivation, used wherever a
 * cwd needs to display or map to a slot (both lock types identify their holder by cwd).
 * @param {string} dir - the worktree directory.
 * @returns {string|null} the slot label, or null when dir is falsy.
 */
export const labelFromDir = dir => (dir ? dir.slice(dir.lastIndexOf('/') + 1).replace(PREFIX, '') : null);

/**
 * The worker PIDs to kill from `pgrep -P <panePid>` output: the pane shell's direct children (the
 * Claude process cmdBuild launched). Pure so the "which pids" decision is unit-tested without real
 * processes. Empty when the pane is already at a bare shell (nothing to kill).
 * @param {string} pgrepOut - stdout of `pgrep -P <panePid>` (one pid per line).
 * @returns {number[]} the child PIDs to signal.
 */
export function killTargetsFromPgrep(pgrepOut) {
  return (pgrepOut || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\d+$/.test(line))
    .map(Number);
}

/**
 * Panes-per-window that `session reload` appends new slots at: the densest existing slot window's
 * pane count, so reload PRESERVES the session's chosen packing (a 2-pane layout stays 2, and the
 * extra slots spill into new windows). Falls back to the create-default (3) only when there are no
 * slot windows yet to infer from.
 * @param {number[]} paneCounts - pane count of each existing slot window.
 * @returns {number} panes per window to pack the new slots into.
 */
export function reloadPaneWidth(paneCounts) {
  return paneCounts.length ? Math.max(...paneCounts) : 3;
}

/**
 * Where `session reload` places the next appended slot: the first existing slot window with room
 * (fewer than perN panes), else null to open a new window. Pure, so the fill-then-spill packing is
 * unit-tested without tmux. Returns the window object to reuse (from `wins`), or null.
 * @param {Array<{panes: number}>} wins - existing slot windows with their current pane counts.
 * @param {number} perN - target panes per window.
 * @returns {{panes: number}|null} the window to split into, or null to spill into a new window.
 */
export function reloadTargetWindow(wins, perN) {
  return wins.find(win => win.panes < perN) ?? null;
}
