// Canonical command router for the namespaced `sm` CLI. Both entry points (bin/sm and
// bin/slot-machine) route through run() - one dispatch table, so they can never drift.
import { helpFor, REPO_DIR, REPO_NAME } from './constants.mjs';
import { recordUsage } from './usage.mjs';
import { die } from './format.mjs';
import {
  cmdBuild,
  cmdMsg,
  cmdDispatch,
  cmdLs,
  cmdFree,
  cmdInfo,
  cmdLogs,
  cmdPs,
  cmdWorkerKill,
  cmdReset,
  cmdFocus,
  cmdAttach,
  cmdDetach,
  cmdReload,
  cmdUnlock,
  cmdKill,
  cmdRole,
  cmdAdd,
  cmdRm,
  cmdDoctor,
  cmdUse,
  cmdRepoLs,
  cmdRepoInspect,
  cmdRepoRm,
  cmdClaim,
  cmdRelease,
  cmdReport,
  cmdInbox,
  cmdStats,
  cmdLocks,
  cmdPreflight,
} from './commands.mjs';

// route -> handler. Top-level routes are one word; namespaced routes are "ns verb".
export const ROUTES = {
  doctor: cmdDoctor,
  stats: cmdStats,
  'repo ls': cmdRepoLs,
  'repo use': cmdUse,
  'repo inspect': cmdRepoInspect,
  'repo rm': cmdRepoRm,
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
  'worker ps': cmdPs,
  'worker run': cmdDispatch,
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
};

export const NAMESPACES = new Set(['repo', 'session', 'slot', 'worker', 'msg', 'lock']);

// Generic verb aliases within any namespace, plus one-off route aliases.
const VERB_ALIAS = { list: 'ls', remove: 'rm', inspect: 'inspect', open: 'focus' };
const ROUTE_ALIAS = { 'msg ls': 'msg inbox' };

// Routes that work without a resolved current repo (repo management + environment checks).
const REPO_FREE = new Set(['repo ls', 'repo use', 'repo inspect', 'repo rm', 'doctor', 'stats']);

// Resolve a help key from user words: '' | namespace | route.
export function helpKey(words) {
  const w = words.filter((a) => a !== '--help' && a !== '-h');
  if (!w.length) return '';
  const joined = w.slice(0, 2).join(' ');
  const canon = ROUTE_ALIAS[joined] || joined;
  if (ROUTES[canon]) return canon;
  if (NAMESPACES.has(w[0]) && w[1] && ROUTES[`${w[0]} ${VERB_ALIAS[w[1]] || w[1]}`])
    return `${w[0]} ${VERB_ALIAS[w[1]] || w[1]}`;
  if (NAMESPACES.has(w[0])) return w[0];
  return w[0];
}

// The single entrypoint.
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
    const ri = args.indexOf('--repo'); // global one-off repo; consumed here (constants already read it)
    if (ri >= 0) args.splice(ri, args[ri + 1] ? 2 : 1);
    else {
      const eq = args.findIndex((a) => a.startsWith('--repo='));
      if (eq >= 0) args.splice(eq, 1);
    }

    // Bare `sm` = continue: re-attach the most recently active session.
    if (args[0] === undefined) args.unshift('session', 'attach');

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
    } else if (NAMESPACES.has(args[0])) {
      const ns = args[0];
      const verb = args[1];
      if (verb === undefined || verb === '--help' || verb === '-h') {
        console.log(helpFor(ns));
        return;
      }
      const canon = ROUTE_ALIAS[`${ns} ${verb}`] || `${ns} ${VERB_ALIAS[verb] || verb}`;
      if (!ROUTES[canon]) die(`unknown command '${ns} ${verb}'. Try: sm help ${ns}`);
      route = canon;
      rest = args.slice(2);
    } else {
      const hint = /^[2-4]$/.test(args[0]) ? ` (did you mean: sm session create ${args[0]})` : '';
      die(`unknown command '${args[0]}'${hint}. Try: sm --help`);
    }

    usageCmd = route;
    // Blocking watches (--watch, logs --follow, claim --wait) sit idle waiting on an event -
    // that wait is not command latency, so bucket them separately or they poison avg/max.
    // (-f only means follow on `worker logs`; elsewhere it is --first-free.)
    const follow = route === 'worker logs' && (rest.includes('--follow') || rest.includes('-f'));
    if (rest.includes('--watch') || follow) usageCmd += ' --watch';
    else if (rest.includes('--wait')) usageCmd += ' --wait';

    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(helpFor(route));
      return;
    }
    if (!REPO_FREE.has(route) && !REPO_DIR)
      die('no current repo - run: sm repo use <repo>  (or pass --repo <dir>)');

    return ROUTES[route](rest);
  };

  await main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
