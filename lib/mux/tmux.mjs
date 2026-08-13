// The built-in tmux backend. Wraps the tmux CLI behind the multiplexer contract; every tmux
// format string and CLI quirk in slot-machine lives in this file. Groups are tmux windows.
// Pane labels live in the sm-owned @smslot pane option - correlation metadata, deliberately
// NOT @cclabel: that option is a display slot users' own tooling writes (e.g. a zsh precmd
// stamping dir:branch), and the label-first slot correlation must never read user display
// text as a slot label. The tmux.conf pane-border block (lib/tmuxconf.mjs) keeps rendering
// @cclabel/pane_title untouched.
import { spawnSync } from 'node:child_process';
import { err, ERR, ok } from './contract.mjs';
import { TMUX_SETTINGS, tmuxTitlesStatus, writeTmuxBlock } from '../tmuxconf.mjs';

const run = (args, opts = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...opts });
// stdout on success, null on nonzero exit.
function out(args) {
  const result = run(args);
  return result.status === 0 ? result.stdout : null;
}
// A must-succeed capture: ok(stdout) or a crashed envelope naming the op.
function reqOut(args, what) {
  const text = out(args);
  return text == null ? err(ERR.CRASHED, `tmux ${what} failed`) : ok(text);
}

const LABEL_OPT = '@smslot'; // sm-owned pane option carrying the slot label (correlation only)

// --- pure parsers (unit-tested with fixture strings) ---

/**
 * Parse `list-panes -F` tab-separated lines into Pane records.
 * Field order: pane_id, session_name, window_id, @smslot, pane_start_path,
 * pane_current_command, pane_active, session_attached.
 * @param {string} raw - raw list-panes stdout.
 * @returns {object[]} Pane records (see contract typedef).
 */
export function parsePaneLines(raw) {
  return (raw || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, session, group, label, cwd, command, active, attached] = line.split('\t');
      return {
        id,
        session,
        group,
        label: label ?? '',
        cwd: cwd ?? '',
        command: command ?? '',
        focused: active === '1',
        attached: attached === '1',
        exited: false, // tmux does not report exit state; liveness is inferred from command
      };
    });
}

/**
 * Parse `list-sessions -F` lines into session records.
 * @param {string} raw - raw list-sessions stdout.
 * @returns {Array<{name: string, lastActivity: number, groups: number, attached: boolean}>} sessions.
 */
export function parseSessionLines(raw) {
  return (raw || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, activity, groups, attached] = line.split('\t');
      return {
        name,
        lastActivity: Number(activity) || 0,
        groups: Number(groups) || 0,
        attached: attached === '1',
      };
    });
}

/**
 * Parse `list-windows -F` lines into group records.
 * @param {string} raw - raw list-windows stdout.
 * @returns {Array<{id: string, label: string, paneCount: number}>} groups.
 */
export function parseGroupLines(raw) {
  return (raw || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, label, panes] = line.split('\t');
      return { id, label, paneCount: Number(panes) || 0 };
    });
}

const PANE_FORMAT = [
  '#{pane_id}',
  '#{session_name}',
  '#{window_id}',
  `#{${LABEL_OPT}}`,
  '#{pane_start_path}',
  '#{pane_current_command}',
  '#{pane_active}',
  '#{session_attached}',
].join('\t');

export default {
  name: 'tmux',

  // --- session lifecycle ---

  probe() {
    const result = run(['-V']);
    if (result.status !== 0)
      return err(ERR.NOT_INSTALLED, 'tmux not found on PATH');
    return ok({ name: 'tmux', version: (result.stdout || '').trim() });
  },

  insideMux() {
    return ok(!!process.env.TMUX);
  },

  sessionExists({ name }) {
    return ok(spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0);
  },

  listSessions() {
    const raw = out(['list-sessions', '-F', '#{session_name}\t#{session_activity}\t#{session_windows}\t#{session_attached}']);
    return ok(parseSessionLines(raw ?? '')); // no server running = no sessions, not an error
  },

  createSession({ name, cwd, firstGroupLabel }) {
    const res = reqOut(
      ['new-session', '-d', '-s', name, '-n', firstGroupLabel, '-c', cwd, '-P', '-F', '#{window_id}\t#{pane_id}'],
      'new-session',
    );
    if (!res.ok)
      return res;
    const [firstGroupId, firstPaneId] = res.value.trim().split('\t');
    return ok({ firstGroupId, firstPaneId });
  },

  killSession({ name }) {
    run(['kill-session', '-t', name]); // idempotent: a missing session is fine
    return ok();
  },

  attach({ name }) {
    if (process.env.TMUX) {
      const result = spawnSync('tmux', ['switch-client', '-t', name], { stdio: 'inherit' });
      return ok({ switched: true, status: result.status ?? 0 });
    }
    const result = spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' });
    return ok({ switched: false, status: result.status ?? 0 });
  },

  // --- group + pane lifecycle ---

  createGroup({ session, label, cwd }) {
    const res = reqOut(
      ['new-window', '-P', '-F', '#{window_id}\t#{pane_id}', '-t', session, '-n', label, '-c', cwd],
      'new-window',
    );
    if (!res.ok)
      return res;
    const [groupId, paneId] = res.value.trim().split('\t');
    return ok({ groupId, paneId });
  },

  spawnPane({ group, cwd, label }) {
    const res = reqOut(['split-window', '-P', '-F', '#{pane_id}', '-h', '-t', group, '-c', cwd], 'split-window');
    if (!res.ok)
      return res;
    const paneId = res.value.trim();
    if (label)
      run(['set-option', '-p', '-t', paneId, LABEL_OPT, label]);
    return ok({ paneId });
  },

  listGroups({ session }) {
    const res = reqOut(['list-windows', '-t', session, '-F', '#{window_id}\t#{window_name}\t#{window_panes}'], 'list-windows');
    return res.ok ? ok(parseGroupLines(res.value)) : res;
  },

  listPanes({ scope }) {
    const target = scope === 'all' ? ['-a'] : scope.session ? ['-s', '-t', scope.session] : ['-t', scope.group];
    const raw = out(['list-panes', ...target, '-F', PANE_FORMAT]);
    return ok(parsePaneLines(raw ?? '')); // no server running = no panes, not an error
  },

  setLabel({ paneId, label }) {
    run(['set-option', '-p', '-t', paneId, LABEL_OPT, label]);
    return ok();
  },

  setGroupLabel({ groupId, label }) {
    run(['rename-window', '-t', groupId, label]);
    return ok();
  },

  focus({ paneId }) {
    run(['select-window', '-t', paneId]);
    run(['select-pane', '-t', paneId]);
    return ok();
  },

  // --- io primitives ---

  typeText({ paneId, text }) {
    // -l literal: ';', key names, and a leading '/' stay literal text.
    run(['send-keys', '-t', paneId, '-l', text]);
    return ok();
  },

  submitKey({ paneId }) {
    run(['send-keys', '-t', paneId, 'Enter']);
    return ok();
  },

  capture({ paneId, full = false, ansi = false }) {
    const args = ['capture-pane', '-p', '-t', paneId];
    if (full)
      args.push('-S', '-');
    if (ansi)
      args.push('-e');
    const text = out(args);
    if (text == null)
      return err(ERR.CRASHED, `tmux capture-pane failed for ${paneId}`);
    return ok(text);
  },

  // --- capabilities ---

  detach({ name }) {
    run(name ? ['detach-client', '-s', name] : ['detach-client']);
    return ok();
  },

  panePid({ paneId }) {
    const pid = (out(['display-message', '-p', '-t', paneId, '#{pane_pid}']) ?? '').trim();
    if (!/^\d+$/.test(pid))
      return err(ERR.CRASHED, `no pane pid for ${paneId}`);
    return ok(Number(pid));
  },

  // --- streaming (the pane mirror's substrate) ---

  streamStart({ paneId, sink, byteCap }) {
    // pipe-pane executes its argument via a shell - the ONE sanctioned shell string in
    // this codebase. Nothing request-derived may enter it: the sink must be a plain path
    // (serve passes only its own spool paths) and the cap a positive integer. Validated
    // HERE regardless of caller - defense in depth, not trust.
    if (typeof sink !== 'string' || !/^[\w/.-]+$/.test(sink))
      return err(ERR.CONFIG, `refusing pipe sink with unsafe characters: ${sink}`);
    if (!Number.isInteger(byteCap) || byteCap <= 0)
      return err(ERR.CONFIG, `byteCap must be a positive integer, got ${byteCap}`);
    // -o: only open when NO pipe exists - we never clobber a pipe someone else owns.
    // (Replacement of OUR pipe by another tool stays undetectable - pane_pipe is a
    // boolean - and is documented as a limitation; the mirror then freezes silently.)
    const res = run(['pipe-pane', '-o', '-t', paneId, `exec /usr/bin/head -c ${byteCap} >> ${sink}`]);
    if (res.status !== 0)
      return err(ERR.CRASHED, `tmux pipe-pane failed for ${paneId}`);
    return ok({ started: true });
  },

  streamStop({ paneId }) {
    run(['pipe-pane', '-t', paneId]); // bare pipe-pane = off; idempotent by tmux's own rules
    return ok(true);
  },

  streamStatus({ paneId }) {
    const piped = (out(['display-message', '-p', '-t', paneId, '#{pane_pipe}']) ?? '').trim();
    if (piped !== '0' && piped !== '1')
      return err(ERR.CRASHED, `no pipe status for ${paneId}`);
    return ok({ piped: piped === '1' });
  },

  paneSize({ paneId }) {
    const size = (out(['display-message', '-p', '-t', paneId, '#{pane_width} #{pane_height}']) ?? '').trim();
    const match = /^(\d+) (\d+)$/.exec(size);
    if (!match)
      return err(ERR.CRASHED, `no pane size for ${paneId}`);
    return ok({ cols: Number(match[1]), rows: Number(match[2]) });
  },

  arrangeLayout({ group }) {
    run(['select-layout', '-t', group, 'even-horizontal']); // the one layout sm uses
    return ok();
  },

  ensureLabelsVisible() {
    const { path, changed } = writeTmuxBlock();
    // Apply live too when a server is running (conf edits only apply on source); ignore failures.
    for (const [opt, val] of TMUX_SETTINGS)
      run(['set', '-g', opt, val]);
    return ok({ path, changed });
  },

  labelsVisible() {
    const live = (out(['show-options', '-gv', 'pane-border-status']) ?? '').trim();
    return ok(tmuxTitlesStatus(live || undefined));
  },
};
