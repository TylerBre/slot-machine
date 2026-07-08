// Config + raw text for the sm CLI. The active repo (= a git repo) is resolved from
// --repo or the persisted current repo; its derived context populates the values below.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { CONFIG_FILE, loadConfig, resolveActive } from './context.mjs';

export const HOME = homedir();

const active = resolveActive(process.argv); // null when no repo is set

export const REPO_DIR = active?.repoDir ?? null; // the repo's main worktree
export const REPO_NAME = active?.name ?? null; // repo name (repo basename)
export const DOCS = active?.root ?? null; // dir holding the slots (sibling of repo)
export const PREFIX = active?.prefix ?? null; // worktree dir prefix, e.g. acme-slot-
export const SESSION_PREFIX = active?.sessionPrefix ?? null; // tmux session name prefix
export const BASE_BRANCH = active?.baseBranch ?? null; // the repo's base branch
export const STALE_LOCK_SEC = 1800; // a lock whose owner transcript is quiet this long is stale
export const LOCK_FILENAME = '.worktree-lock'; // the one lockfile written in each claimed slot worktree
export const CLAIM_WAIT_MS = 10 * 60_000; // `lock claim --wait` gives up after this
export const CLAIM_POLL_MS = 1000; // ...retrying a contended resource this often
export const INBOX_WAIT_MS = 40 * 60_000; // waitForReports overall timeout
export const UNTIL_IDLE_POLL_MS = 8000; // `msg send --until-idle` re-attempts a pending submit this often
export const UNTIL_IDLE_TIMEOUT_MS = 10 * 60_000; // ...and gives up on a still-busy slot after this

// The 'browser' shared resource = the single authenticated Playwright-MCP Chromium. Every
// Claude session's MCP server drives it against ONE persistent profile dir (this marker in
// its --user-data-dir), and Chromium single-locks that dir - so releasing the lock must also
// close the browser or the next claimant cannot attach. See resourceProcessPids /
// killProcesses / RESOURCE_PID_RESOLVERS in exec.mjs.
export const BROWSER_RESOURCE = 'browser';
export const BROWSER_PROFILE_MARKER = 'ms-playwright-mcp';
export const INBOX_POLL_MS = 60_000; // ...safety re-poll interval (a watch backstop)
export const PRUNE_DEFAULT_MIN = 30; // `lock prune --older-than` default, in minutes

/**
 * For `sm doctor`: the current repo + resolved values.
 * @returns {object} the config report: path, fileOk, current, repo, repoDir, values, repos.
 */
export function configReport() {
  const cfg = loadConfig();
  return {
    path: CONFIG_FILE,
    fileOk: existsSync(CONFIG_FILE),
    current: cfg.current || null,
    repo: REPO_NAME,
    repoDir: REPO_DIR,
    values: REPO_DIR
      ? { root: DOCS, prefix: PREFIX, sessionPrefix: SESSION_PREFIX, baseBranch: BASE_BRANCH }
      : null,
    repos: Object.keys(cfg.repos || {}),
  };
}

// tmux pane_current_command values that mean "back at a shell" = Claude exited.
export const SHELL_CMDS = new Set([
  'zsh',
  '-zsh',
  'bash',
  '-bash',
  'sh',
  '-sh',
  'fish',
  '-fish',
  'dash',
  '-dash',
]);

// free-table status token -> color name (see lib/format.mjs `clr`).
export const STATUS_COLOR = {
  'free': 'green',
  'merged': 'green',
  'waiting-merge': 'yellow',
  'wip': 'yellow',
  'stale': 'yellow',
  'active': 'yellow',
  'locked': 'red',
  'dirty': 'red',
  'closed-pr': 'red',
};
