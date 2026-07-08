// Process plumbing: tmux, git, and gh wrappers.
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { docs, PREFIX, BASE_BRANCH } from './constants.mjs';
import { die } from './format.mjs';

export const tmux = (args, opts = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...opts });
export const tmuxOut = (args) => {
  const r = tmux(args);
  return r.status === 0 ? r.stdout : null;
};
export const hasSession = (s) =>
  spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status === 0;
export const req = (out, what) => {
  if (out == null) die(`tmux ${what} failed`);
  return out;
};

// Type one submitted line into a pane: literal keys (-l) so ';' / key-names / a
// leading '/' stay literal, then a separate Enter to submit.
export function sendLine(pane, text) {
  tmux(['send-keys', '-t', pane, '-l', text]);
  tmux(['send-keys', '-t', pane, 'Enter']);
}

export function attachOrSwitch(session) {
  if (process.env.TMUX) spawnSync('tmux', ['switch-client', '-t', session], { stdio: 'inherit' });
  else process.exit(spawnSync('tmux', ['attach', '-t', session], { stdio: 'inherit' }).status ?? 0);
}

// Slot worktree dir names (acme-slot-a ...), sorted.
export function listSlots() {
  let names;
  try {
    names = readdirSync(docs);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(PREFIX))
    .filter((n) => {
      try {
        return statSync(join(docs, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export const pexec = promisify(execFile);

// stdout string; '' on failure (some git commands exit nonzero but still print).
export async function run(cmd, args) {
  try {
    return (await pexec(cmd, args, { encoding: 'utf8' })).stdout || '';
  } catch (e) {
    return e.stdout || '';
  }
}

// repo slug (owner/name) from a slot's origin remote, for gh.
export async function repoSlug(slotDir) {
  const url = (await run('git', ['-C', slotDir, 'remote', 'get-url', 'origin'])).trim();
  return url.replace(/^(git@github\.com:|https:\/\/github\.com\/)/, '').replace(/\.git$/, '');
}

// per-worktree git state: checked-out branch, dirty tree, commits ahead of the base branch.
export async function slotGit(slotDir) {
  const g = async (a) => (await run('git', ['-C', slotDir, ...a])).trim();
  return {
    branch: await g(['rev-parse', '--abbrev-ref', 'HEAD']),
    // sm's own lock artifact never counts as user dirt - host repos need not gitignore it.
    dirty: (await g(['status', '--porcelain']))
      .split('\n')
      .filter(Boolean)
      .some((l) => l.slice(3) !== '.worktree-lock'),
    ahead: parseInt((await g(['rev-list', '--count', `origin/${BASE_BRANCH}..HEAD`])) || '0', 10) || 0,
  };
}

// headRefName -> [{number,state}] across all PRs in the repo (one gh call).
export async function prMap(slug) {
  const out = await run('gh', [
    'pr',
    'list',
    '--repo',
    slug,
    '--state',
    'all',
    '--limit',
    '400',
    '--json',
    'number,state,headRefName',
    '--jq',
    '.[] | [.headRefName, (.number|tostring), .state] | @tsv',
  ]);
  const m = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [head, num, state] = line.split('\t');
    if (!m.has(head)) m.set(head, []);
    m.get(head).push({ number: Number(num), state });
  }
  return m;
}
