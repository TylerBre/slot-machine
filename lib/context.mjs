// Repo resolution + persisted config. A repo's whole context is derived from its
// main-worktree dir: root = the parent dir (slots are siblings), prefix = <name>-slot-,
// session prefix = <name>, base = the repo's default branch. Overridable and
// persisted per-repo in ~/.config/slot/config.json; `sm repo use` sets the current repo.
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const CONFIG_FILE = join(homedir(), '.config', 'slot', 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
export function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// The main worktree path for a git dir (resolves a slot worktree back to its repo).
export function mainWorktree(dir) {
  const r = spawnSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = (r.stdout || '').match(/^worktree (.+)$/m); // first entry is the main worktree
  return m ? m[1] : null;
}

export function defaultBranch(dir) {
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    encoding: 'utf8',
  });
  const b = r.status === 0 ? r.stdout.trim().replace(/^origin\//, '') : '';
  return b || 'main';
}

// Derive a repo context from a repo's main-worktree dir, applying stored/flag overrides.
export function deriveContext(repoDir, over = {}) {
  const name = basename(repoDir);
  return {
    repoDir,
    name,
    root: dirname(repoDir),
    prefix: over.prefix || `${name}-slot-`,
    sessionPrefix: over.sessionPrefix || name,
    baseBranch: over.baseBranch || 'main',
  };
}

function repoFlag(argv) {
  const i = argv.indexOf('--repo');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--repo='));
  return eq ? eq.slice('--repo='.length) : null;
}

// The active repo for this invocation: --repo DIR (one-off) wins, else the persisted
// current repo. Returns a full context, or null if none is resolvable.
export function resolveActive(argv) {
  const cfg = loadConfig();
  const rf = repoFlag(argv);
  if (rf) {
    const main = mainWorktree(resolve(rf)) || resolve(rf);
    if (cfg.repos && cfg.repos[main]) return { repoDir: main, ...cfg.repos[main] };
    return { ...deriveContext(main), baseBranch: defaultBranch(main) };
  }
  if (cfg.current && cfg.repos && cfg.repos[cfg.current])
    return { repoDir: cfg.current, ...cfg.repos[cfg.current] };
  return null;
}
