// State gatherers: tmux/git/gh (+ filesystem) state about slots, and the composite freeness scan.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_BRANCH, DOCS, PREFIX, SESSION_PREFIX, SHELL_CMDS } from '../constants.mjs';
import { die } from '../format.mjs';
import { listSlots, prMap, repoSlug, run, slotGit, tmuxOut } from '../exec.mjs';
import { activeOverride, classifySlot, issueFromText, paneActivity, selectPanes } from './pure.mjs';
import { lockIsLive, readLock } from './locks.mjs';

/**
 * Normalize a user-given slot reference (label or full worktree name) once - the one
 * canonical strip is slice(PREFIX.length), never replace() (which can mangle labels
 * containing the prefix substring mid-string).
 * @param {string} arg - the slot label or full worktree name.
 * @returns {{name: string, label: string, dir: string, exists: boolean}} the resolved slot reference.
 */
export function slotRef(arg) {
  const name = arg.startsWith(PREFIX) ? arg : PREFIX + arg;
  const label = name.slice(PREFIX.length);
  const dir = join(DOCS, name);
  return { name, label, dir, exists: existsSync(dir) };
}

/**
 * slot label -> 'live' (a pane is running something - Claude reports its version string as
 * the command, e.g. "2.1.201", or a subprocess like git) | 'dead' (a pane fell back to a
 * bare shell = Claude exited). Absent => no pane in any running session.
 * @returns {Map<string, string>} slot label -> 'live'/'dead'.
 */
export function slotWorkerMap() {
  const out = tmuxOut(['list-panes', '-a', '-F', '#{pane_start_path} #{pane_current_command}']) ?? '';
  const workerMap = new Map();
  for (const line of out.split('\n')) {
    if (!line)
      continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0)
      continue;
    const lbl = paneSlotLabel(line.slice(0, sp));
    if (lbl == null)
      continue;
    const live = !SHELL_CMDS.has(line.slice(sp + 1));
    workerMap.set(lbl, workerMap.get(lbl) === 'live' || live ? 'live' : 'dead');
  }
  return workerMap;
}

// A pane counts as a slot's only when its start path is exactly the slot worktree root
// under `docs` - the same rule selectPanes applies, so every gatherer agrees on which
// panes are workers. Returns the label, or null.
function paneSlotLabel(path) {
  const base = `${DOCS}/${PREFIX}`;
  if (!path.startsWith(base))
    return null;
  const lbl = path.slice(base.length);
  return lbl === '' || lbl.includes('/') ? null : lbl;
}

/**
 * slot label -> pane location { session, window, pane } (prefers an attached session),
 * for slots with a running pane. The single pane resolver - logs/focus/kill/ps all use it.
 * @returns {Map<string, {session: string, window: string, pane: string}>} slot label -> pane location.
 */
export function slotPanes() {
  const out
    = tmuxOut([
      'list-panes',
      '-a',
      '-F',
      '#{session_attached}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_start_path}',
    ]) ?? '';
  const best = new Map(); // label -> { session, window, pane, att }
  for (const line of out.split('\n')) {
    if (!line)
      continue;
    const [att, session, window, pane, path] = line.split('\t');
    if (!path)
      continue;
    const lbl = paneSlotLabel(path);
    if (lbl == null)
      continue;
    const attNum = Number(att) || 0;
    const prev = best.get(lbl);
    if (!prev || attNum > prev.att)
      best.set(lbl, { session, window, pane, att: attNum });
  }
  const result = new Map();
  for (const [lbl, info] of best) result.set(lbl, { session: info.session, window: info.window, pane: info.pane });
  return result;
}

/**
 * Running tmux sessions whose name starts with the configured session prefix.
 * @returns {Array<{name: string, windows: number, attached: boolean}>} the matching sessions.
 */
export function slotSessions() {
  const out
    = tmuxOut(['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}']) ?? '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached] = line.split('\t');
      return { name, windows: Number(windows), attached: attached === '1' };
    })
    .filter(session => session.name.startsWith(SESSION_PREFIX));
}

/**
 * Count the slot panes in a single tmux session.
 * @param {string} session - the tmux session name.
 * @returns {number} the number of slot panes in the session.
 */
export function slotPaneCount(session) {
  return selectPanes(
    (tmuxOut(['list-panes', '-s', '-t', session, '-F', '#{pane_id} #{pane_start_path}']) ?? '').split('\n'),
    DOCS,
    PREFIX,
    null,
  ).length;
}

/**
 * Running tmux sessions, each annotated with its slot pane count.
 * @returns {Array<{name: string, windows: number, attached: boolean, slots: number}>} the sessions with slot counts.
 */
export const sessionRows = () => slotSessions().map(session => ({ ...session, slots: slotPaneCount(session.name) }));

/**
 * Classify every slot worktree (git fetch + one gh call + per-slot git, concurrently),
 * sorted by slot name. Adds live/dead worker and stale-lock detection.
 * @returns {Promise<object[]>} the classified slot rows, sorted by slot label.
 */
export async function slotFreenessRows() {
  const slots = listSlots();
  if (!slots.length)
    die(`ls: no ${PREFIX}* worktrees in ${DOCS} - create one: sm slot create a`);
  const first = join(DOCS, slots[0]);
  await run('git', ['-C', first, 'fetch', '-q', 'origin', BASE_BRANCH]); // freshen base branch for accurate ahead counts
  const prs = await prMap(await repoSlug(first));
  const workers = slotWorkerMap();
  const panes = slotPanes();
  const rows = await Promise.all(
    slots.map(async (name) => {
      const dir = join(DOCS, name);
      const short = name.slice(PREFIX.length);
      const { branch, dirty, ahead } = await slotGit(dir);
      const lock = readLock(dir);
      const branchPrs = prs.get(branch) || [];
      const worker = workers.get(short) || 'none';
      const classification = classifySlot({ branch, baseBranch: name, locked: !!lock, dirty, ahead, prs: branchPrs });
      let { free, status } = classification;
      // Lock is authoritative: a live claim (or dead-owner stale) beats any git-state guess.
      if (status === 'locked' && !lockIsLive(lock, worker === 'live')) {
        status = 'stale';
      }
      // Backstop: reusable-looking + a live worker mid-task (no lock yet) => not free; don't dispatch over it.
      else if (free && worker === 'live') {
        const pane = panes.get(short)?.pane;
        const activity = paneActivity(
          pane ? (tmuxOut(['capture-pane', '-p', '-t', pane]) ?? '') : '',
          !!pane,
        );
        const override = activeOverride({ free, worker, activity });
        if (override)
          ({ free, status } = override);
      }
      // issue: lock is source of truth; fall back to parsing the branch for unlocked/legacy slots.
      return {
        slot: short,
        branch,
        issue: lock?.issue ?? issueFromText(branch),
        free,
        status,
        prs: branchPrs,
        worker,
      };
    }),
  );
  return rows.sort((rowA, rowB) => rowA.slot.localeCompare(rowB.slot));
}
