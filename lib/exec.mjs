// Process plumbing: git, gh, and OS-process wrappers. Multiplexer operations live behind
// lib/mux (the backend contract); nothing here talks to tmux.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_BRANCH, BROWSER_PROFILE_MARKER, BROWSER_RESOURCE, DOCS, LOCK_FILENAME, LOCK_TMP_FILENAME, PREFIX } from './constants.mjs';

/**
 * Slot worktree dir names (acme-slot-a ...), sorted.
 * @returns {string[]} sorted slot directory names.
 */
export function listSlots() {
  let names;
  try {
    names = readdirSync(DOCS);
  }
  catch {
    return [];
  }
  return names
    .filter(name => name.startsWith(PREFIX))
    .filter((name) => {
      try {
        return statSync(join(DOCS, name)).isDirectory();
      }
      catch {
        return false;
      }
    })
    .sort();
}

export const pexec = promisify(execFile);

/**
 * stdout string; '' on failure (some git commands exit nonzero but still print).
 * @param {string} cmd - executable to run.
 * @param {string[]} args - arguments to pass.
 * @returns {Promise<string>} captured stdout, or '' on failure.
 */
export async function run(cmd, args) {
  try {
    return (await pexec(cmd, args, { encoding: 'utf8' })).stdout || '';
  }
  catch (err) {
    return err.stdout || '';
  }
}

/**
 * repo slug (owner/name) from a slot's origin remote, for gh.
 * @param {string} slotDir - slot worktree directory.
 * @returns {Promise<string>} the owner/name repo slug.
 */
export async function repoSlug(slotDir) {
  const url = (await run('git', ['-C', slotDir, 'remote', 'get-url', 'origin'])).trim();
  return url.replace(/^(git@github\.com:|https:\/\/github\.com\/)/, '').replace(/\.git$/, '');
}

/**
 * per-worktree git state: checked-out branch, dirty tree, commits ahead of the base branch.
 * ahead is null when the count could not be computed (origin/<base> unresolvable) - the caller
 * must treat that as unknown (fail safe), NOT as zero, or a committed-WIP slot reads as free.
 * @param {string} slotDir - slot worktree directory.
 * @returns {Promise<{branch: string, dirty: boolean, ahead: number|null}>} the slot's git state.
 */
export async function slotGit(slotDir) {
  const gitOut = async args => (await run('git', ['-C', slotDir, ...args])).trim();
  // rev-list --count prints "0" for a resolvable base with no commits ahead; run() returns ''
  // ONLY when git failed (e.g. origin/<base> does not resolve). '' -> null (unknown), never 0.
  const aheadCount = await gitOut(['rev-list', '--count', `origin/${BASE_BRANCH}..HEAD`]);
  return {
    branch: await gitOut(['rev-parse', '--abbrev-ref', 'HEAD']),
    // sm's own artifacts (the worktree document + its transient write mutex, including broken
    // husks) never count as user dirt - host repos need not gitignore them.
    dirty: (await gitOut(['status', '--porcelain']))
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const name = line.slice(3);
        return name !== LOCK_FILENAME && !name.startsWith(LOCK_TMP_FILENAME);
      }),
    ahead: aheadCount === '' ? null : parseInt(aheadCount, 10) || 0,
  };
}

/**
 * headRefName -> [{number,state,headOid}] across all PRs in the repo (one gh call).
 * headOid is the PR head commit - the landed-work proof checks a merged slot's local HEAD
 * against it before a destructive reset.
 * @param {string} slug - owner/name repo slug.
 * @returns {Promise<Map<string, Array<{number: number, state: string, headOid: string}>>>} branch -> PRs map.
 */
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
    'number,state,headRefName,headRefOid',
    '--jq',
    '.[] | [.headRefName, (.number|tostring), .state, .headRefOid] | @tsv',
  ]);
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line)
      continue;
    const [head, num, state, headOid] = line.split('\t');
    if (!map.has(head))
      map.set(head, []);
    map.get(head).push({ number: Number(num), state, headOid: headOid || null });
  }
  return map;
}

/**
 * PIDs of the Chromium processes bound to the shared Playwright-MCP profile, from
 * `ps -Ao pid=,args=` output. Pure, so it is unit-tested without real processes. The
 * profile `marker` also appears in each session's node/npm MCP *server* command line;
 * those are excluded (the server is kept - only the browser it spawned is matched).
 * @param {string} psOutput
 * @param {string} marker - the shared profile-dir substring (BROWSER_PROFILE_MARKER).
 * @returns {number[]} browser PIDs.
 */
export function browserProfilePids(psOutput, marker) {
  const pids = [];
  for (const raw of (psOutput || '').split('\n')) {
    const line = raw.trim();
    const sp = line.indexOf(' '); // `ps pid=,args=` is `<pid> <command>`; split once, no backtracking regex
    if (sp < 0)
      continue;
    const pid = line.slice(0, sp);
    if (!/^\d+$/.test(pid))
      continue;
    const command = line.slice(sp + 1);
    if (!command.includes(marker))
      continue; // not bound to the shared MCP profile
    const argv0 = command.split(/\s+/)[0];
    const exe = argv0.slice(argv0.lastIndexOf('/') + 1); // basename, so an absolute-path node matches too
    if (exe === 'node' || exe === 'npm')
      continue; // the MCP server carries the same path - leave it running
    pids.push(Number(pid));
  }
  return pids;
}

// A shared resource maps to the userland process(es) it stands for; releasing the lock
// must terminate them, not just drop the lockfile. Each process-backed resource registers
// a resolver here - a generic seam, so `release` stays resource-agnostic. The 'browser'
// resource maps to the Chromium bound to the shared Playwright-MCP profile, which only
// exists once the holder has driven it (i.e. at release time), so it is resolved live.
const RESOURCE_PID_RESOLVERS = {
  [BROWSER_RESOURCE]() {
    const out = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' }).stdout || '';
    return browserProfilePids(out, BROWSER_PROFILE_MARKER);
  },
};

/**
 * OS process pids a shared resource maps to (empty for resources with no backing process).
 * SLOT_NO_RESOURCE_KILL disables resolution (returns []), the test/opt-out seam that keeps a
 * release from ever touching real host processes.
 * @param {string} resource - resource name (e.g. BROWSER_RESOURCE).
 * @returns {number[]} live pids the resource stands for.
 */
export function resourceProcessPids(resource) {
  if (process.env.SLOT_NO_RESOURCE_KILL)
    return []; // test/opt-out seam: never touch real host processes
  // Own-property only: an inherited name (constructor, toString, ...) must not resolve to a function.
  if (!Object.hasOwn(RESOURCE_PID_RESOLVERS, resource))
    return [];
  return RESOURCE_PID_RESOLVERS[resource]();
}

/**
 * SIGTERM each pid, ignoring any already gone. Generic - callers decide which pids.
 * @param {number[]} pids
 * @returns {number[]} the pids signalled.
 */
export function killProcesses(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    }
    catch {
      /* already gone */
    }
  }
  return pids;
}
