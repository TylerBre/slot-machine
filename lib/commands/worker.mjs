// worker namespace: the operating model (role/preflight), worker status (ps/logs), dispatch, kill.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCS,
  PREFIX,
  REPO_DIR,
} from '../constants.mjs';
import { ROLE_DISPATCHER, ROLE_WORKER } from '../help.mjs';
import {
  clr,
  die,
  emitJson,
  oneLine,
  pad,
} from '../format.mjs';
import {
  killProcesses,
  listSlots,
  run,
  tmuxOut,
} from '../exec.mjs';
import {
  detectRole,
  paneActivity,
  preflightStatus,
} from '../slots/pure.mjs';
import { readLock } from '../slots/locks.mjs';
import {
  slotPanes,
  slotRef,
  slotWorkerMap,
} from '../slots/gather.mjs';
import { argOptions, parseCmd, projectDir, watchLoop } from './shared.mjs';
import { cmdMsg } from './msg.mjs';

// Last assistant text from a slot's newest Claude transcript (null if none).
function lastAssistant(dir) {
  const projDir = projectDir(dir);
  let files;
  try {
    files = readdirSync(projDir).filter(file => file.endsWith('.jsonl'));
  }
  catch {
    return null;
  }
  if (!files.length)
    return null;
  const newest = files.map(file => [file, statSync(join(projDir, file)).mtimeMs]).sort((left, right) => right[1] - left[1])[0][0];
  let text = null;
  try {
    for (const line of readFileSync(join(projDir, newest), 'utf8').split('\n')) {
      if (!line)
        continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      }
      catch {
        continue;
      }
      if (parsed.type === 'assistant') {
        for (const block of parsed.message?.content || []) {
          if (block && block.type === 'text' && block.text && block.text.trim())
            text = block.text.trim();
        }
      }
    }
  }
  catch {
    return null;
  }
  return text;
}

const activityColor = activity => (activity === 'working' ? clr.green : activity === 'waiting' ? clr.yellow : clr.dim);

/**
 * role: print the desk->slots operating model. Auto-detects dispatcher vs worker from
 * the current dir; pass 'dispatcher' or 'worker' to force one.
 * @param {string[]} argv - CLI arguments for the role command.
 */
export function cmdRole(argv) {
  const { values, positionals } = parseCmd('role', argv, argOptions('worker-role'));
  const forced = positionals[0];
  const det = detectRole(process.cwd(), DOCS, PREFIX);
  const role = forced === 'worker' || forced === 'dispatcher' ? forced : det.role;
  const text = role === 'worker' ? ROLE_WORKER : ROLE_DISPATCHER;
  if (values.json) {
    emitJson({ role, slot: det.slot, text });
    return;
  }
  if (role === 'worker' && det.slot)
    console.log(clr.bold(`slot ${det.slot}\n`));
  console.log(text);
}

/**
 * preflight: a slot worker runs this before any git work to confirm cwd is its own slot worktree,
 * not the main checkout. Exit 0 in a slot, non-zero otherwise, so it can gate a chain:
 *   sm worker preflight && git switch -c my-branch
 * Guards the class of bug where a worker branches/commits in the main repo instead of its slot.
 * @param {string[]} argv - CLI arguments for the preflight command.
 */
export function cmdPreflight(argv) {
  const { values } = parseCmd('preflight', argv, argOptions('worker-preflight'));
  const cwd = process.cwd();
  const { ok, status, slot } = preflightStatus(cwd, { root: DOCS, prefix: PREFIX, repoDir: REPO_DIR });
  if (values.json) {
    emitJson({ ok, status, slot, cwd });
    if (!ok)
      process.exit(1);
    return;
  }
  if (status === 'slot') {
    console.log(clr.green(`OK - in slot ${clr.bold(slot)} (${PREFIX}${slot}). Safe to work here.`));
  }
  else if (status === 'main-checkout') {
    console.log(
      `${clr.red(`STOP - you are in the MAIN checkout (${REPO_DIR}), not a slot worktree.`)
      }\nNever branch, commit, or push here. cd to your slot (${PREFIX}<label>), then re-run 'sm worker preflight' before any git work.`,
    );
  }
  else {
    console.log(
      `${clr.yellow(`WARNING - cwd is not a slot worktree under ${DOCS}/${PREFIX}*.`)
      }\ncd to your slot before working so your branch and commits land in the right place.`,
    );
  }
  if (!ok)
    process.exit(1);
}

/**
 * ps: every worker at a glance - live/dead, working/idle/waiting, current task. The cheap
 * dispatcher poll (tmux only, no git/gh); `sm slot ls` is the one that decides reusability.
 * @param {string[]} argv - CLI arguments for the ps command.
 */
export async function cmdPs(argv) {
  const { values } = parseCmd('ps', argv, argOptions('worker-ps'));
  const labels = listSlots().map(name => name.slice(PREFIX.length));
  if (!labels.length)
    die(`ps: no ${PREFIX}* worktrees in ${DOCS} - create one: sm slot create a`);

  const snapshot = () => {
    const workers = slotWorkerMap();
    const panes = slotPanes();
    return labels.map((lbl) => {
      const worker = workers.get(lbl) || 'none';
      const pane = panes.get(lbl)?.pane ?? null;
      const activity
        = worker === 'live'
          ? paneActivity(pane ? (tmuxOut(['capture-pane', '-p', '-t', pane]) ?? '') : '', !!pane)
          : '-';
      const task = readLock(join(DOCS, PREFIX + lbl))?.task ?? null;
      return { slot: lbl, worker, activity, task };
    });
  };
  const render = (rows) => {
    const lw = Math.max(4, ...rows.map(row => row.slot.length));
    const aw = Math.max(8, ...rows.map(row => row.activity.length));
    console.log(clr.dim(`${pad('slot', lw)} ${pad('worker', 6)} ${pad('activity', aw)} task`));
    for (const row of rows) {
      const worker = (row.worker === 'live' ? clr.green : row.worker === 'dead' ? clr.red : clr.dim)(
        pad(row.worker, 6),
      );
      const activity = activityColor(row.activity)(pad(row.activity, aw));
      const task = row.task ? oneLine(row.task, 60) : clr.dim('-');
      console.log(`${clr.bold(pad(row.slot, lw))} ${worker} ${activity} ${task}`);
    }
  };

  if (values.json) {
    emitJson(snapshot());
    return;
  }
  if (!values.watch) {
    render(snapshot());
    return;
  }
  return watchLoop('sm worker ps', 5000, snapshot, render);
}

/**
 * dispatch MESSAGE - alias for `msg --first-free`: send to the first reusable slot.
 * @param {string[]} argv - CLI arguments for the dispatch command.
 */
export function cmdDispatch(argv) {
  return cmdMsg(['--first-free', ...argv], 'run');
}

/**
 * logs SLOT: one worker in depth - activity, last assistant message, pane tail. -f follows.
 * @param {string[]} argv - CLI arguments for the logs command.
 */
export async function cmdLogs(argv) {
  const { values, positionals } = parseCmd('logs', argv, argOptions('worker-logs'));
  if (!positionals.length)
    die('logs: name a slot, e.g. sm worker logs h');
  const { name, label: short, dir, exists } = slotRef(positionals[0]);
  if (!exists)
    die(`logs: no worktree ${name} in ${DOCS}`);
  const lineCount = Math.max(1, parseInt(values.lines || '20', 10) || 20);

  const snapshot = () => {
    const pane = slotPanes().get(short)?.pane ?? null;
    const capture = pane ? (tmuxOut(['capture-pane', '-p', '-t', pane]) ?? '') : '';
    const capLines = capture.split('\n');
    while (capLines.length && !capLines[capLines.length - 1].trim()) capLines.pop();
    return {
      slot: short,
      pane,
      activity: paneActivity(capture, !!pane),
      lastMessage: lastAssistant(dir),
      tail: capLines.slice(-lineCount),
    };
  };
  const render = (snap) => {
    console.log(`${clr.bold(snap.slot)}  ${activityColor(snap.activity)(snap.activity)}`);
    if (snap.lastMessage)
      console.log(`  last: ${clr.dim(oneLine(snap.lastMessage, 500))}`);
    console.log(clr.dim(`  --- pane (last ${snap.tail.length}) ---`));
    for (const line of snap.tail) console.log(`  ${line}`);
  };

  if (values.json) {
    emitJson(snapshot());
    return;
  }
  if (!values.follow) {
    render(snapshot());
    return;
  }
  return watchLoop(`sm worker logs ${short} -f`, 2000, snapshot, render);
}

/**
 * kill SLOT: end one worker's process; its pane falls back to a shell (worker shows dead)
 * and the session stays intact. The conversation survives on disk - `claude -c` resumes it.
 * @param {string[]} argv - CLI arguments for the worker kill command.
 */
export async function cmdWorkerKill(argv) {
  const { values, positionals } = parseCmd('kill', argv, argOptions('worker-kill'));
  const json = values.json;
  if (!positionals.length)
    die('kill: name a slot, e.g. sm worker kill h');
  const { name, label, exists } = slotRef(positionals[0]);
  if (!exists)
    die(`kill: no worktree ${name} in ${DOCS}`);
  const pane = slotPanes().get(label)?.pane;
  if (!pane)
    die(`kill: no pane for slot ${label} in any running session`);
  const panePid = (tmuxOut(['display-message', '-p', '-t', pane, '#{pane_pid}']) ?? '').trim();
  if (!panePid)
    die(`kill: could not resolve the pane process for slot ${label}`);
  // The worker runs as the pane shell's child (cmdBuild types the claude command into a
  // fresh shell), so ending the children leaves the pane at its shell.
  const pids = (await run('pgrep', ['-P', panePid]))
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (!pids.length) {
    if (json) {
      emitJson({ slot: label, killed: false, reason: 'no worker process (pane is at a shell)' });
      process.exit(1);
    }
    die(`kill: slot ${label} has no worker process (its pane is already at a shell)`);
  }
  killProcesses(pids.map(Number));
  if (json) {
    emitJson({ slot: label, killed: true, pids: pids.map(Number) });
    return;
  }
  console.log(`killed worker in slot ${clr.bold(label)} (pid ${pids.join(', ')}) - pane is back at a shell`);
}
