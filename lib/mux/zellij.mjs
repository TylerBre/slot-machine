// The zellij backend. Requires zellij >= 0.44.0 - the release that added the CLI-automation
// surface this backend is built on (per-pane --pane-id targeting on dump-screen/write-chars/
// send-keys, list-panes --json, id-returning new-pane/new-tab, background sessions). Groups
// are zellij tabs; pane labels are zellij pane names (--name at spawn / rename-pane), which
// render on the pane frame natively - no config block needed.
//
// Known v1 limits vs tmux: no pane pid (worker kill degrades with a clear message), no
// arrangeLayout (zellij tiles on its own), and liveness for shell panes leans on a prompt
// heuristic (see paneCommand below) because zellij does not report a pane's foreground command.
import { spawnSync } from 'node:child_process';
import { err, ERR, ok } from './contract.mjs';

const MIN_VERSION = [0, 44, 0];

const run = (args, opts = {}) => spawnSync('zellij', args, { encoding: 'utf8', ...opts });
// stdout on success, null on nonzero exit.
function out(args, opts = {}) {
  const result = run(args, opts);
  return result.status === 0 ? result.stdout : null;
}
// Session-scoped action call: zellij's action CLI operates on one session at a time.
const act = (session, args) => out(['--session', session, 'action', ...args]);

// --- pure helpers (unit-tested with fixture strings) ---

/**
 * Parse `zellij list-sessions -n` lines into { name, exited } records.
 * Line shape: `name [Created 2s ago]` with ` (EXITED - ...)` appended for dead sessions.
 * @param {string} raw - raw list-sessions -n stdout.
 * @returns {Array<{name: string, exited: boolean}>} session records.
 */
export function parseZellijSessions(raw) {
  return (raw || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const name = line.split(' ')[0];
      return { name, exited: line.includes('EXITED') };
    });
}

/**
 * Is this zellij pane title a default one ("Pane #3") rather than a stamped label? Default
 * titles must not leak into Pane.label or the label-first slot correlation would treat every
 * unlabeled pane as a slot.
 * @param {string} title - the pane title.
 * @returns {boolean} true when the title is a zellij default.
 */
export const isDefaultTitle = title => /^Pane #\d+$/.test(title || '');

/**
 * Does captured pane text end at a shell prompt? Used to classify a null-command zellij pane
 * as "back at a shell" (agent exited), since zellij cannot report the foreground command.
 * ponytail: last-line prompt heuristic; replace with a zellij fg-command source if one lands.
 * @param {string} capture - the captured pane text.
 * @returns {boolean} true when the last non-empty line looks like a shell prompt.
 */
export function looksLikeShellPrompt(capture) {
  const lines = (capture || '').split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trimEnd();
    if (!line)
      continue;
    return /[%$#>❯]\s*$/.test(line);
  }
  return true; // an empty pane is a fresh shell
}

/**
 * Map zellij `list-panes --json` records (one session) to contract Pane records.
 * Plugin panes are dropped; ids are namespaced `terminal_<n>`; default titles become ''.
 * @param {object[]} rawPanes - parsed list-panes --json array.
 * @param {string} session - the owning session name.
 * @param {boolean} attached - whether the session has connected clients.
 * @returns {object[]} Pane records (see contract typedef).
 */
export function panesFromJson(rawPanes, session, attached) {
  return (rawPanes || [])
    .filter(pane => !pane.is_plugin)
    .map(pane => ({
      id: `terminal_${pane.id}`,
      session,
      group: String(pane.tab_id),
      label: isDefaultTitle(pane.title) ? '' : (pane.title ?? ''),
      cwd: pane.pane_cwd ?? '',
      command: pane.terminal_command ?? '',
      focused: !!pane.is_focused,
      attached,
      exited: !!pane.exited,
    }));
}

// --- session-state readers shared by several ops ---

// Live (non-EXITED) sessions.
const liveSessions = () => parseZellijSessions(out(['list-sessions', '-n']) ?? '').filter(session => !session.exited);

// Does the session have at least one connected client? (Header-only output = none.)
function sessionAttached(name) {
  const raw = act(name, ['list-clients']) ?? '';
  return raw.split('\n').filter(Boolean).length > 1;
}

// One session's raw list-panes --json array, or []. --all: every tab, not just the focused one.
function rawPanes(session) {
  const raw = act(session, ['list-panes', '--all', '--json']);
  if (raw == null)
    return [];
  try {
    return JSON.parse(raw);
  }
  catch {
    return [];
  }
}

// Block the thread for ms - zellij session/tab startup is async and the action CLI has no
// wait verb, so creation ops poll briefly for the pane they just caused to exist.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Poll `read` (up to ~2s) until it yields a non-null value; null when it never does.
function pollFor(read) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = read();
    if (value != null)
      return value;
    sleepSync(100);
  }
  return null;
}

// Contract Pane records for one session, with the shell-prompt liveness fill-in: a pane with
// no reportable command and no exit state gets classified by capturing its screen - a shell
// prompt at the bottom means the agent exited back to the shell (command 'zsh' so SHELL_CMDS
// matches), anything else means something is running (command stays '').
function sessionPanes(session) {
  const attached = sessionAttached(session);
  const panes = panesFromJson(rawPanes(session), session, attached);
  for (const pane of panes) {
    if (pane.command === '' && !pane.exited) {
      const cap = act(session, ['dump-screen', '--pane-id', pane.id]);
      if (cap != null && looksLikeShellPrompt(cap))
        pane.command = 'zsh'; // "at a shell" sentinel; matches SHELL_CMDS
    }
  }
  return panes;
}

// Version gate, memoized: every entry-point op refuses to run on a pre-0.44 zellij.
let versionChecked = null;
function versionGate() {
  if (versionChecked)
    return versionChecked;
  const raw = out(['--version']);
  if (raw == null)
    return (versionChecked = err(ERR.NOT_INSTALLED, 'zellij not found on PATH'));
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  const parts = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  const okVersion
    = parts[0] > MIN_VERSION[0]
      || (parts[0] === MIN_VERSION[0] && parts[1] > MIN_VERSION[1])
      || (parts[0] === MIN_VERSION[0] && parts[1] === MIN_VERSION[1] && parts[2] >= MIN_VERSION[2]);
  versionChecked = okVersion
    ? ok({ name: 'zellij', version: raw.trim() })
    : err(ERR.UNSUPPORTED, `zellij >= 0.44.0 required for CLI automation (found ${raw.trim()})`);
  return versionChecked;
}

/** Reset the memoized version gate (test-only). */
export function resetVersionGateForTest() {
  versionChecked = null;
}

// The pane a fresh tab auto-creates: the tab's sole non-plugin pane.
function tabPane(session, tabId) {
  const pane = panesFromJson(rawPanes(session), session, false).find(candidate => candidate.group === String(tabId));
  return pane?.id ?? null;
}

export default {
  name: 'zellij',

  // --- session lifecycle ---

  probe() {
    return versionGate();
  },

  insideMux() {
    return ok(!!process.env.ZELLIJ);
  },

  sessionExists({ name }) {
    return ok(liveSessions().some(session => session.name === name));
  },

  listSessions() {
    // zellij has no per-session activity timestamp; lastActivity 0 keeps the sort stable and
    // "most recent" degrades to first prefix match. Group count comes from the panes scan.
    return ok(
      liveSessions().map((session) => {
        const tabs = new Set(rawPanes(session.name).filter(pane => !pane.is_plugin).map(pane => pane.tab_id));
        return { name: session.name, lastActivity: 0, groups: tabs.size, attached: sessionAttached(session.name) };
      }),
    );
  },

  createSession({ name, cwd, firstGroupLabel }) {
    const gate = versionGate();
    if (!gate.ok)
      return gate;
    const created = run(['attach', '--create-background', name], { cwd });
    if (created.status !== 0)
      return err(ERR.CRASHED, `zellij attach --create-background failed: ${(created.stderr || '').trim()}`);
    // The background session starts with one tab + one pane - asynchronously; poll until the
    // first pane exists, then name the tab and hand both back.
    const first = pollFor(() => panesFromJson(rawPanes(name), name, false)[0] ?? null);
    if (!first)
      return err(ERR.CRASHED, `zellij session '${name}' created but its first pane never appeared`);
    act(name, ['rename-tab', '--tab-id', first.group, firstGroupLabel]);
    return ok({ firstGroupId: first.group, firstPaneId: first.id });
  },

  killSession({ name }) {
    run(['kill-session', name]); // idempotent: a missing session is fine
    run(['delete-session', name]); // clear the EXITED entry so the name is reusable
    return ok();
  },

  attach({ name }) {
    if (process.env.ZELLIJ) {
      const result = run(['action', 'switch-session', name]);
      return ok({ switched: true, status: result.status ?? 0 });
    }
    const result = spawnSync('zellij', ['attach', name], { stdio: 'inherit' });
    return ok({ switched: false, status: result.status ?? 0 });
  },

  // --- group + pane lifecycle ---

  createGroup({ session, label, cwd }) {
    const tabId = (act(session, ['new-tab', '--name', label, '--cwd', cwd]) ?? '').trim();
    if (!tabId)
      return err(ERR.CRASHED, 'zellij new-tab failed');
    const paneId = pollFor(() => tabPane(session, tabId)); // tab startup is async
    if (!paneId)
      return err(ERR.CRASHED, `zellij tab ${tabId} created but its pane never appeared`);
    return ok({ groupId: tabId, paneId });
  },

  spawnPane({ group, cwd, label }) {
    // No -d direction: zellij silently drops the pane when a direction is combined with
    // --tab-id (verified live on 0.44.3). Zellij tiles the tab on its own.
    const args = ['new-pane', '--tab-id', group, '--cwd', cwd];
    if (label)
      args.push('--name', label);
    // new-pane needs the owning session; groups are per-session, so scan for it.
    for (const session of liveSessions()) {
      if (rawPanes(session.name).some(pane => String(pane.tab_id) === String(group) && !pane.is_plugin)) {
        const paneId = (act(session.name, args) ?? '').trim();
        if (!paneId)
          return err(ERR.CRASHED, 'zellij new-pane failed');
        // Callers type into the pane immediately; wait until it actually exists.
        const seen = pollFor(() =>
          rawPanes(session.name).some(pane => !pane.is_plugin && `terminal_${pane.id}` === paneId) ? paneId : null);
        return seen ? ok({ paneId }) : err(ERR.CRASHED, `zellij pane ${paneId} never appeared in tab ${group}`);
      }
    }
    return err(ERR.CRASHED, `no live session owns tab ${group}`);
  },

  listGroups({ session }) {
    const groups = new Map();
    for (const pane of rawPanes(session)) {
      if (pane.is_plugin)
        continue;
      const id = String(pane.tab_id);
      const entry = groups.get(id) ?? { id, label: pane.tab_name ?? '', paneCount: 0 };
      entry.paneCount++;
      groups.set(id, entry);
    }
    return ok([...groups.values()]);
  },

  listPanes({ scope }) {
    const gate = versionGate();
    if (!gate.ok)
      return gate;
    if (scope === 'all')
      return ok(liveSessions().flatMap(session => sessionPanes(session.name)));
    if (scope.session)
      return ok(sessionPanes(scope.session));
    // group scope: find the owning session, then filter
    for (const session of liveSessions()) {
      const panes = sessionPanes(session.name).filter(pane => pane.group === String(scope.group));
      if (panes.length)
        return ok(panes);
    }
    return ok([]);
  },

  setLabel({ paneId, label }) {
    for (const session of liveSessions()) {
      if (panesFromJson(rawPanes(session.name), session.name, false).some(pane => pane.id === paneId)) {
        act(session.name, ['rename-pane', '--pane-id', paneId, label]);
        return ok();
      }
    }
    return ok(); // pane gone: nothing to label
  },

  setGroupLabel({ groupId, label }) {
    for (const session of liveSessions()) {
      if (rawPanes(session.name).some(pane => String(pane.tab_id) === String(groupId))) {
        act(session.name, ['rename-tab', '--tab-id', String(groupId), label]);
        return ok();
      }
    }
    return ok();
  },

  focus({ paneId }) {
    for (const session of liveSessions()) {
      if (panesFromJson(rawPanes(session.name), session.name, false).some(pane => pane.id === paneId)) {
        act(session.name, ['focus-pane-id', paneId]);
        return ok();
      }
    }
    return ok();
  },

  // --- io primitives ---

  typeText({ paneId, text }) {
    const session = owningSession(paneId);
    if (!session)
      return err(ERR.CRASHED, `no live session owns pane ${paneId}`);
    act(session, ['write-chars', '--pane-id', paneId, text]);
    return ok();
  },

  submitKey({ paneId }) {
    const session = owningSession(paneId);
    if (!session)
      return err(ERR.CRASHED, `no live session owns pane ${paneId}`);
    act(session, ['send-keys', '--pane-id', paneId, 'Enter']);
    return ok();
  },

  capture({ paneId, full = false, ansi = false }) {
    const session = owningSession(paneId);
    if (!session)
      return err(ERR.CRASHED, `no live session owns pane ${paneId}`);
    const args = ['dump-screen', '--pane-id', paneId];
    if (full)
      args.push('--full');
    if (ansi)
      args.push('--ansi');
    const text = act(session, args);
    if (text == null)
      return err(ERR.CRASHED, `zellij dump-screen failed for ${paneId}`);
    return ok(text);
  },

  // --- capabilities ---

  detach({ name }) {
    if (name) {
      act(name, ['detach']); // detach that session's clients
      return ok();
    }
    if (!process.env.ZELLIJ)
      return err(ERR.UNSUPPORTED, 'detach self only works inside zellij');
    out(['action', 'detach']);
    return ok();
  },

  // panePid: omitted - zellij does not expose a pane's process id; `sm worker kill` reports
  // the limitation and the worker is ended from inside its pane instead.
  // arrangeLayout: omitted - zellij tiles panes on its own.
  // ensureLabelsVisible / labelsVisible: omitted - pane frames render names natively.
};

// The live session owning a pane id (zellij's action CLI is session-scoped). Memoized per
// process: a pane never moves between sessions, and callers hit the same pane repeatedly
// (type -> submit -> capture), so one scan per pane is enough.
const paneSessionCache = new Map();
function owningSession(paneId) {
  if (paneSessionCache.has(paneId))
    return paneSessionCache.get(paneId);
  for (const session of liveSessions()) {
    if (panesFromJson(rawPanes(session.name), session.name, false).some(pane => pane.id === paneId)) {
      paneSessionCache.set(paneId, session.name);
      return session.name;
    }
  }
  return null; // not cached: the pane may appear on a later scan
}
