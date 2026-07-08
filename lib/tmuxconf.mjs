// The tmux settings sm's layout benefits from: per-pane titles in the pane border, so N
// worker panes are tellable-apart at a glance. Managed as a marked block in the user's
// tmux.conf - upsert is idempotent, so re-running never duplicates or drifts.
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BEGIN = '# >>> slot-machine >>>';
const END = '# <<< slot-machine <<<';

// What --fix-tmux writes to the conf, and what it applies to a live server.
export const TMUX_SETTINGS = [
  ['pane-border-status', 'top'],
  ['pane-border-format', ' #P:#{?#{@cclabel},#{@cclabel},#{pane_title}} '],
];

export const TMUX_BLOCK = `${BEGIN}
# Per-pane titles in the pane border, so worker panes are tellable-apart at a glance.
# (@cclabel is an optional per-pane title override; falls back to the pane title.)
set -g pane-border-status top
set -g pane-border-format " #P:#{?#{@cclabel},#{@cclabel},#{pane_title}} "
${END}`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pure (unit-tested): insert the marked block, or replace an existing one in place.
export function upsertBlock(text) {
  const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
  if (re.test(text)) return text.replace(re, TMUX_BLOCK);
  return (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + TMUX_BLOCK + '\n';
}

// Prefer an existing ~/.tmux.conf, then the XDG path; default to ~/.tmux.conf.
export function tmuxConfPath() {
  const home = join(homedir(), '.tmux.conf');
  const xdg = join(homedir(), '.config', 'tmux', 'tmux.conf');
  if (existsSync(home)) return home;
  if (existsSync(xdg)) return xdg;
  return home;
}

// Upsert the block into the user's tmux.conf. Returns { path, changed }.
export function writeTmuxBlock() {
  const p = tmuxConfPath();
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const next = upsertBlock(cur);
  const changed = next !== cur;
  if (changed) writeFileSync(p, next);
  return { path: p, changed };
}

// Is the pane-title setup active? Judge the live server when one is running (source of
// truth - conf edits don't apply until sourced), else fall back to the conf file text.
export function tmuxTitlesStatus(liveBorderStatus) {
  if (liveBorderStatus)
    return {
      ok: liveBorderStatus === 'top' || liveBorderStatus === 'bottom',
      source: 'server',
      value: liveBorderStatus,
    };
  const p = tmuxConfPath();
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const ok = /^\s*set(?:-option)?\s+-g\s+pane-border-status\s+(top|bottom)\b/m.test(text);
  return { ok, source: 'conf', value: ok ? 'configured' : 'unset' };
}
