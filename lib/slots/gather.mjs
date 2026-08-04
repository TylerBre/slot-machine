// State gatherers: multiplexer/git/gh (+ filesystem) state about slots, and the composite
// freeness scan. All pane/session state comes through the active mux backend (lib/mux) as
// structured records - no multiplexer format strings here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_BRANCH, DOCS, PREFIX, REPO_DIR, SESSION_PREFIX, SHELL_CMDS } from '../constants.mjs';
import { die } from '../format.mjs';
import { listSlots, prMap, repoSlug, run, slotGit } from '../exec.mjs';
import { mux } from '../mux/index.mjs';
import { activeOverride, classifySlot, issueFromText, paneLabel, selectPanes } from './pure.mjs';
import { activityOf, loadRoster } from '../agents/index.mjs';
import { lockIsLive, readLock } from './locks.mjs';

// Every pane the backend can see; [] when no server is running.
function allPanes() {
  const res = mux('listPanes', { scope: 'all' });
  return res.ok ? res.value : [];
}

// A pane's worker is live while something beyond a bare shell runs in it: the pane has not
// exited (backends that report it) and its foreground command is not a shell (Claude reports
// its version string as the command, e.g. "2.1.201", or a subprocess like git).
const paneLive = pane => !pane.exited && !SHELL_CMDS.has(pane.command);

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
 * slot label -> 'live' (a pane is running something) | 'dead' (a pane fell back to a bare
 * shell = the agent exited). Absent => no pane in any running session.
 * @returns {Map<string, string>} slot label -> 'live'/'dead'.
 */
export function slotWorkerMap() {
  const workerMap = new Map();
  for (const pane of allPanes()) {
    const lbl = paneLabel(pane, DOCS, PREFIX);
    if (lbl == null)
      continue;
    const live = paneLive(pane);
    workerMap.set(lbl, workerMap.get(lbl) === 'live' || live ? 'live' : 'dead');
  }
  return workerMap;
}

/**
 * slot label -> pane location { session, window, pane } (prefers an attached session),
 * for slots with a running pane. The single pane resolver - logs/focus/kill/ps all use it.
 * @returns {Map<string, {session: string, window: string, pane: string}>} slot label -> pane location.
 */
export function slotPanes() {
  const best = new Map(); // label -> { session, window, pane, att }
  for (const pane of allPanes()) {
    const lbl = paneLabel(pane, DOCS, PREFIX);
    if (lbl == null)
      continue;
    const attNum = pane.attached ? 1 : 0;
    const prev = best.get(lbl);
    if (!prev || attNum > prev.att)
      best.set(lbl, { session: pane.session, window: pane.group, pane: pane.id, att: attNum });
  }
  const result = new Map();
  for (const [lbl, info] of best) result.set(lbl, { session: info.session, window: info.window, pane: info.pane });
  return result;
}

/**
 * Running sessions whose name starts with the configured session prefix.
 * @returns {Array<{name: string, windows: number, attached: boolean}>} the matching sessions.
 */
export function slotSessions() {
  const res = mux('listSessions');
  return (res.ok ? res.value : [])
    .map(session => ({ name: session.name, windows: session.groups, attached: session.attached }))
    .filter(session => session.name.startsWith(SESSION_PREFIX));
}

/**
 * Count the slot panes in a single session.
 * @param {string} session - the session name.
 * @returns {number} the number of slot panes in the session.
 */
export function slotPaneCount(session) {
  const res = mux('listPanes', { scope: { session } });
  return selectPanes(res.ok ? res.value : [], DOCS, PREFIX, null).length;
}

/**
 * Running sessions, each annotated with its slot pane count.
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
  await loadRoster();
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
        const cap = pane ? mux('capture', { paneId: pane }) : null;
        const activity = activityOf(REPO_DIR, short, cap?.ok ? cap.value : '', !!pane);
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
