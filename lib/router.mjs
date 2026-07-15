// Canonical command router for the namespaced `sm` CLI. Both entry points (bin/sm and
// bin/slot-machine) route through run() - one dispatch table, so they can never drift.
import { REPO_DIR, REPO_NAME, VERSION } from './constants.mjs';
import { helpFor } from './help.mjs';
import { CONFIG_ERROR } from './context.mjs';
import { recordUsage } from './usage.mjs';
import { die } from './format.mjs';
import { cmdRepoConfig, cmdRepoInspect, cmdRepoLs, cmdRepoRm, cmdUse } from './commands/repo.mjs';
import { cmdAttach, cmdBuild, cmdDetach, cmdKill, cmdLs, cmdReload } from './commands/session.mjs';
import { cmdAdd, cmdFocus, cmdFree, cmdInfo, cmdReset, cmdRm, cmdSlotConfig } from './commands/slot.mjs';
import { cmdDispatch, cmdLogs, cmdPreflight, cmdPs, cmdRole, cmdWait, cmdWorkerKill } from './commands/worker.mjs';
import { cmdInbox, cmdMsg, cmdReport } from './commands/msg.mjs';
import { cmdClaim, cmdLocks, cmdRelease, cmdUnlock } from './commands/lock.mjs';
import { cmdDoctor, cmdStats, cmdVersion } from './commands/top.mjs';
import { cmdAgentsAdd, cmdAgentsDir, cmdAgentsLs, cmdAgentsRm } from './commands/agents.mjs';

// route -> handler. Top-level routes are one word; namespaced routes are "ns verb".
export const ROUTES = {
  'doctor': cmdDoctor,
  'stats': cmdStats,
  'version': cmdVersion,
  'repo ls': cmdRepoLs,
  'repo use': cmdUse,
  'repo inspect': cmdRepoInspect,
  'repo rm': cmdRepoRm,
  'repo config': cmdRepoConfig,
  'session ls': cmdLs,
  'session create': cmdBuild,
  'session attach': cmdAttach,
  'session reload': cmdReload,
  'session detach': cmdDetach,
  'session kill': cmdKill,
  'slot ls': cmdFree,
  'slot focus': cmdFocus,
  'slot inspect': cmdInfo,
  'slot create': cmdAdd,
  'slot rm': cmdRm,
  'slot reset': cmdReset,
  'slot config': cmdSlotConfig,
  'worker ps': cmdPs,
  'worker run': cmdDispatch,
  'worker wait': cmdWait,
  'worker logs': cmdLogs,
  'worker kill': cmdWorkerKill,
  'worker role': cmdRole,
  'worker preflight': cmdPreflight,
  'msg send': cmdMsg,
  'msg report': cmdReport,
  'msg inbox': cmdInbox,
  'lock ls': cmdLocks,
  'lock claim': cmdClaim,
  'lock release': cmdRelease,
  'lock prune': cmdUnlock,
  'agents ls': cmdAgentsLs,
  'agents dir': cmdAgentsDir,
  'agents add': cmdAgentsAdd,
  'agents rm': cmdAgentsRm,
};

export const NAMESPACES = new Set(['repo', 'session', 'slot', 'worker', 'msg', 'lock', 'agents']);

// Generic verb aliases within any namespace, plus one-off route aliases.
const VERB_ALIAS = { list: 'ls', remove: 'rm', open: 'focus' };
const ROUTE_ALIAS = { 'msg ls': 'msg inbox' };

// Routes that work without a resolved current repo (repo management + environment checks).
const REPO_FREE = new Set([
  'repo ls',
  'repo use',
  'repo inspect',
  'repo rm',
  'doctor',
  'stats',
  'version',
  'agents ls',
  'agents dir',
  'agents add',
  'agents rm',
]);

// Routes allowed to run despite a broken config - the diagnostic/recovery escape hatch. Help
// (help / --help / -h / bare namespace) returns before dispatch, so doctor + version list here.
const CONFIG_TOLERANT = new Set(['doctor', 'version']);

/**
 * Resolve a help key from user words: '' | namespace | route.
 * @param {string[]} words - The user-provided command words.
 * @returns {string} The resolved help key.
 */
export function helpKey(words) {
  const parts = words.filter(word => word !== '--help' && word !== '-h');
  if (!parts.length)
    return '';
  const joined = parts.slice(0, 2).join(' ');
  const canon = ROUTE_ALIAS[joined] || joined;
  if (ROUTES[canon])
    return canon;
  if (NAMESPACES.has(parts[0]) && parts[1] && ROUTES[`${parts[0]} ${VERB_ALIAS[parts[1]] || parts[1]}`])
    return `${parts[0]} ${VERB_ALIAS[parts[1]] || parts[1]}`;
  return parts[0];
}

/**
 * The single entrypoint.
 * @param {string[]} argv - The command-line arguments.
 * @returns {Promise<void>}
 */
export async function run(argv) {
  const t0 = Date.now();
  let usageCmd = null;
  process.on('exit', (code) => {
    recordUsage({
      cmd: usageCmd ?? '(none)',
      ok: code === 0,
      ms: Date.now() - t0,
      repo: REPO_NAME,
      tty: !!process.stdout.isTTY,
    });
  });

  const main = async () => {
    const args = [...argv];
    // Global one-off repo; consumed here (constants already read it). Only BEFORE a '--'
    // terminator, so a guarded literal message ('sm msg send -- --repo x') keeps its text.
    const term = args.indexOf('--');
    const limit = term >= 0 ? term : args.length;
    const ri = args.slice(0, limit).indexOf('--repo');
    if (ri >= 0) {
      args.splice(ri, args[ri + 1] ? 2 : 1);
    }
    else {
      const eq = args.slice(0, limit).findIndex(arg => arg.startsWith('--repo='));
      if (eq >= 0)
        args.splice(eq, 1);
    }

    // Bare `sm` = continue: re-attach the most recently active session.
    if (args[0] === undefined)
      args.unshift('session', 'attach');

    // Version works without a repo (the one thing you type to identify the build).
    if (args[0] === '--version' || args[0] === '-V') {
      console.log(VERSION);
      return;
    }

    // Help works without a repo: overview, namespace, or route detail.
    if (args[0] === '--help' || args[0] === '-h') {
      console.log(helpFor(''));
      return;
    }
    if (args[0] === 'help') {
      console.log(helpFor(helpKey(args.slice(1))));
      return;
    }

    // Resolve the route.
    let route;
    let rest;
    if (ROUTES[args[0]]) {
      route = args[0];
      rest = args.slice(1);
    }
    else if (NAMESPACES.has(args[0])) {
      const ns = args[0];
      const verb = args[1];
      if (verb === undefined || verb === '--help' || verb === '-h') {
        console.log(helpFor(ns));
        return;
      }
      // Apply the verb alias first, then the route alias, so the two compose (e.g. `msg list` ->
      // `msg ls` -> `msg inbox`); a route alias on the raw verb alone would miss the aliased spelling.
      const aliased = `${ns} ${VERB_ALIAS[verb] || verb}`;
      const canon = ROUTE_ALIAS[aliased] || aliased;
      if (!ROUTES[canon])
        die(`unknown command '${ns} ${verb}'. Try: sm help ${ns}`);
      route = canon;
      rest = args.slice(2);
    }
    else {
      const hint = /^[2-4]$/.test(args[0]) ? ` (did you mean: sm session create ${args[0]})` : '';
      die(`unknown command '${args[0]}'${hint}. Try: sm --help`);
    }

    usageCmd = route;
    // Blocking watches/waits sit idle on an event - that wait is not command latency, so bucket
    // them separately or they poison avg/max. The three watch-capable routes accept --watch and
    // --follow interchangeably; -f means follow only on `worker logs` (elsewhere it is --first-free).
    const watchRoutes = new Set(['slot ls', 'worker ps', 'worker logs']);
    const isWatch = watchRoutes.has(route)
      && (rest.includes('--watch') || rest.includes('--follow') || (route === 'worker logs' && rest.includes('-f')));
    if (isWatch)
      usageCmd += ' --watch';
    else if (rest.includes('--wait') || route === 'worker wait')
      usageCmd += ' --wait';

    // A help flag only opens help when it appears BEFORE a '--' terminator; past '--' it is a
    // literal MESSAGE arg (e.g. sm msg send -- --help sends the text "--help").
    const beforeArgs = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
    if (beforeArgs.includes('--help') || beforeArgs.includes('-h')) {
      console.log(helpFor(route));
      return;
    }
    // A broken config (see loadConfig -> CONFIG_ERROR) fails every repo-needing command loud,
    // but doctor + help stay alive so the user can diagnose and recover.
    if (CONFIG_ERROR && !CONFIG_TOLERANT.has(route)) {
      console.error(CONFIG_ERROR);
      process.exit(1);
    }
    if (!REPO_FREE.has(route) && !REPO_DIR)
      die('no current repo - run: sm repo use <repo>  (or pass --repo <dir>)');

    return ROUTES[route](rest);
  };

  await main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
