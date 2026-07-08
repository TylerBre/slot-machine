// Process plumbing: tmux, git, and gh wrappers.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_BRANCH, BROWSER_PROFILE_MARKER, BROWSER_RESOURCE, DOCS, LOCK_FILENAME, PREFIX } from './constants.mjs';
import { die } from './format.mjs';

/**
 * Run tmux via spawnSync, capturing utf8 output.
 * @param {string[]} args - tmux CLI arguments.
 * @param {object} [opts] - extra spawnSync options.
 * @returns {object} the spawnSync result.
 */
export const tmux = (args, opts = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...opts });
/**
 * Run tmux and return its stdout, or null if it exited nonzero.
 * @param {string[]} args - tmux CLI arguments.
 * @returns {string|null} stdout on success, otherwise null.
 */
export function tmuxOut(args) {
  const result = tmux(args);
  return result.status === 0 ? result.stdout : null;
}
/**
 * Does a tmux session with the given name exist?
 * @param {string} session - tmux session name.
 * @returns {boolean} true if the session exists.
 */
export function hasSession(session) {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}
/**
 * Assert a tmux output is present, dying with context if it is null.
 * @param {string|null} out - the tmux output to check.
 * @param {string} what - label describing the failed tmux operation.
 * @returns {string} the non-null output.
 */
export function req(out, what) {
  if (out == null)
    die(`tmux ${what} failed`);
  return out;
}

/**
 * Type one submitted line into a pane: literal keys (-l) so ';' / key-names / a
 * leading '/' stay literal, then a separate Enter to submit. Good for a shell prompt
 * (e.g. launching Claude); to hand a task message to a Claude composer use sendMessage.
 * @param {string} pane - target tmux pane.
 * @param {string} text - line of text to type and submit.
 */
export function sendLine(pane, text) {
  tmux(['send-keys', '-t', pane, '-l', text]);
  tmux(['send-keys', '-t', pane, 'Enter']);
}

// Block the thread for ms (no deps, no subprocess) - lets a pane's TUI settle between a paste
// and the Enter that submits it.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Is a Claude composer empty (message submitted)? Inspects the last prompt line ('❯ ...') in the
// captured pane - content after the prompt means text is still sitting unsent. No prompt (agent
// already working, or a shell pane) counts as empty so we never falsely block.
function composerEmpty(pane) {
  const cap = tmuxOut(['capture-pane', '-p', '-t', pane]);
  if (cap == null)
    return true;
  const lines = cap.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const idx = lines[index].indexOf('❯');
    if (idx >= 0)
      return lines[index].slice(idx + 1).replace(/[│─\s]/g, '').length === 0;
  }
  return true;
}

/**
 * Reliably deliver a submitted message to a Claude agent's composer. Typing key-by-key (sendLine)
 * breaks two ways: an embedded newline is an Enter that submits the task half-typed, and a long
 * line the TUI paste-detects is ingested asynchronously - so an immediately-following Enter lands
 * mid-ingestion and is dropped, leaving the message sitting unsent. Fix: flatten to one line (no
 * stray newline submits), then submit with an Enter AFTER a short settle, VERIFY the composer
 * actually cleared, and retry the Enter once. Returns true iff it submitted, so callers report
 * "delivered", not just "typed". (No bracketed paste: it only preserves newlines and would leak
 * escape markers into any non-TUI target.)
 * @param {string} pane - target tmux pane.
 * @param {string} text - message to deliver (newlines flattened to one line).
 * @returns {boolean} true if the composer verifiably cleared (message submitted).
 */
export function sendMessage(pane, text) {
  const line = text.replace(/\s*\n\s*/g, '  ').trimEnd(); // one submitted line
  tmux(['send-keys', '-t', pane, '-l', line]);
  for (let attempt = 0; attempt < 2; attempt++) {
    sleepSync(200); // let the TUI finish ingesting the (possibly paste-detected) input
    tmux(['send-keys', '-t', pane, 'Enter']); // submit
    sleepSync(150);
    if (composerEmpty(pane))
      return true; // verified: composer cleared
  }
  return composerEmpty(pane);
}

/**
 * Complete a submit that sendMessage typed but could not land (worker was busy, or the TUI was
 * still ingesting the paste when the Enter arrived): the message text is STILL sitting in the
 * composer, so press Enter and verify it cleared - deliberately WITHOUT re-typing. sendMessage
 * does not clear the composer before typing, so re-typing would duplicate the pending text; the
 * text is already there, so a bare submit is the only safe retry. `msg send --until-idle` calls
 * this on an interval until the composer accepts the submit.
 * @param {string} pane - target tmux pane whose composer holds unsent text.
 * @returns {boolean} true if the composer verifiably cleared (message submitted).
 */
export function resubmitMessage(pane) {
  tmux(['send-keys', '-t', pane, 'Enter']); // submit the text already sitting in the composer
  sleepSync(150);
  return composerEmpty(pane);
}

/**
 * Attach to a tmux session, or switch the current client to it when already inside tmux.
 * @param {string} session - tmux session name to attach to or switch to.
 */
export function attachOrSwitch(session) {
  if (process.env.TMUX)
    spawnSync('tmux', ['switch-client', '-t', session], { stdio: 'inherit' });
  else process.exit(spawnSync('tmux', ['attach', '-t', session], { stdio: 'inherit' }).status ?? 0);
}

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
 * @param {string} slotDir - slot worktree directory.
 * @returns {Promise<{branch: string, dirty: boolean, ahead: number}>} the slot's git state.
 */
export async function slotGit(slotDir) {
  const gitOut = async args => (await run('git', ['-C', slotDir, ...args])).trim();
  return {
    branch: await gitOut(['rev-parse', '--abbrev-ref', 'HEAD']),
    // sm's own lock artifact never counts as user dirt - host repos need not gitignore it.
    dirty: (await gitOut(['status', '--porcelain']))
      .split('\n')
      .filter(Boolean)
      .some(line => line.slice(3) !== LOCK_FILENAME),
    ahead: parseInt((await gitOut(['rev-list', '--count', `origin/${BASE_BRANCH}..HEAD`])) || '0', 10) || 0,
  };
}

/**
 * headRefName -> [{number,state}] across all PRs in the repo (one gh call).
 * @param {string} slug - owner/name repo slug.
 * @returns {Promise<Map<string, Array<{number: number, state: string}>>>} branch -> PRs map.
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
    'number,state,headRefName',
    '--jq',
    '.[] | [.headRefName, (.number|tostring), .state] | @tsv',
  ]);
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line)
      continue;
    const [head, num, state] = line.split('\t');
    if (!map.has(head))
      map.set(head, []);
    map.get(head).push({ number: Number(num), state });
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
