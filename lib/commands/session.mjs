// session namespace: build/attach/reload/detach/kill the tmux sessions that lay out slots.
import {
  DOCS,
  PREFIX,
  SESSION_PREFIX,
} from '../constants.mjs';
import {
  die,
  emitJson,
  formatSessions,
} from '../format.mjs';
import {
  attachOrSwitch,
  hasSession,
  listSlots,
  req,
  sendLine,
  tmux,
  tmuxOut,
} from '../exec.mjs';
import { selectPanes } from '../slots/pure.mjs';
import { sessionRows, slotSessions } from '../slots/gather.mjs';
import { argOptions, parseCmd, projectDir, resolveSession } from './shared.mjs';

// Shell command a fresh slot pane runs: resume this dir's most recent Claude conversation
// if a transcript exists, else start fresh (so quitting/Ctrl-C never relaunches).
function claudeCmd(dir) {
  return `if ls ${projectDir(dir)}/*.jsonl >/dev/null 2>&1; then claude -c; else claude; fi`;
}

/**
 * ls: list the running slot-machine tmux sessions.
 * @param {string[]} argv - CLI arguments for the ls command.
 */
export function cmdLs(argv = []) {
  const { values } = parseCmd('ls', argv, argOptions('session-ls'));
  if (values.json) {
    emitJson(sessionRows());
    return;
  }
  console.log(formatSessions(sessionRows(), SESSION_PREFIX));
}

/**
 * attach [NAME]: attach/switch the client to a running session - the most recently
 * active one by default, so a bare `sm session attach` continues where you left off.
 * @param {string[]} argv - CLI arguments for the attach command.
 */
export function cmdAttach(argv) {
  const { values, positionals } = parseCmd('attach', argv, argOptions('session-attach'));
  let sess = positionals[0] ?? null;
  if (sess && !hasSession(sess))
    die(`attach: no tmux session '${sess}'`);
  if (!sess) {
    const out = tmuxOut(['list-sessions', '-F', '#{session_activity}\t#{session_name}']) ?? '';
    sess
      = out
        .split('\n')
        .filter(Boolean)
        .map(line => line.split('\t'))
        .filter(cols => cols[1] && cols[1].startsWith(SESSION_PREFIX))
        .sort((left, right) => Number(right[0]) - Number(left[0]))[0]?.[1] ?? null;
    if (!sess)
      die(`attach: no running ${SESSION_PREFIX}* session - build one: sm session create`);
  }
  if (values.json) {
    emitJson({ session: sess }); // resolve-only: report what would be attached
    return;
  }
  attachOrSwitch(sess);
}

/**
 * reload [NAME]: append panes for slots created after the session was built, leaving
 * every existing pane untouched. Packing (panes per window) is inferred from the densest
 * existing slot window. Changing the packing itself is a rebuild: sm session create N -k.
 * @param {string[]} argv - CLI arguments for the reload command.
 */
export function cmdReload(argv) {
  const { values, positionals } = parseCmd('reload', argv, argOptions('session-reload'));
  const sess = resolveSession(positionals[0] ?? null, 'reload');
  const labels = listSlots().map(name => name.slice(PREFIX.length));
  const paneLines = (
    tmuxOut(['list-panes', '-s', '-t', sess, '-F', '#{pane_id} #{pane_start_path}']) ?? ''
  ).split('\n');
  const present = new Set(selectPanes(paneLines, DOCS, PREFIX, null).map(target => target.lbl));
  const missing = labels.filter(label => !present.has(label));
  if (!missing.length) {
    if (values.json) {
      emitJson({ session: sess, added: [] });
      return;
    }
    console.log(`'${sess}' already shows all ${labels.length} slot(s) - nothing to add`);
    return;
  }

  // slot windows and their pane counts; the densest one defines the packing
  const wins = (
    tmuxOut(['list-windows', '-t', sess, '-F', '#{window_id}\t#{window_name}\t#{window_panes}']) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(cols => cols[1].startsWith('slot-'))
    .map(([id, name, panes]) => ({ id, name, panes: Number(panes) }));
  const perN = Math.max(3, ...wins.map(win => win.panes));

  const windowLabels = id =>
    selectPanes(
      (tmuxOut(['list-panes', '-t', id, '-F', '#{pane_id} #{pane_start_path}']) ?? '').split('\n'),
      DOCS,
      PREFIX,
      null,
    ).map(target => target.lbl);

  const touched = new Set();
  for (const lbl of missing) {
    const dir = `${DOCS}/${PREFIX}${lbl}`;
    let win = wins.find(candidate => candidate.panes < perN);
    let pane;
    if (win) {
      pane = req(
        tmuxOut(['split-window', '-P', '-F', '#{pane_id}', '-h', '-t', win.id, '-c', dir]),
        'split-window',
      ).trim();
      win.panes++;
    }
    else {
      pane = req(
        tmuxOut(['new-window', '-P', '-F', '#{pane_id}', '-t', sess, '-n', `slot-${lbl}`, '-c', dir]),
        'new-window',
      ).trim();
      const id = (tmuxOut(['display-message', '-p', '-t', pane, '#{window_id}']) ?? '').trim();
      win = { id, name: `slot-${lbl}`, panes: 1 };
      wins.push(win);
    }
    sendLine(pane, claudeCmd(dir));
    touched.add(win.id);
  }
  // window names list their member slots; refresh the ones we grew
  for (const id of touched) {
    tmux(['rename-window', '-t', id, `slot-${windowLabels(id).join(',')}`]);
    tmux(['select-layout', '-t', id, 'even-horizontal']);
  }
  if (values.json) {
    emitJson({ session: sess, added: missing });
    return;
  }
  console.log(`added ${missing.length} slot pane(s) to '${sess}': ${missing.join(' ')}`);
}

/**
 * detach [NAME]: detach your own client when run inside tmux with no NAME, else every
 * client attached to the named (or sole running) session.
 * @param {string[]} argv - CLI arguments for the detach command.
 */
export function cmdDetach(argv) {
  const { values, positionals } = parseCmd('detach', argv, argOptions('session-detach'));
  if (!positionals.length && process.env.TMUX) {
    if (values.json)
      emitJson({ detached: 'self' });
    tmux(['detach-client']);
    return;
  }
  const sess = resolveSession(positionals[0] ?? null, 'detach');
  tmux(['detach-client', '-s', sess]);
  if (values.json) {
    emitJson({ session: sess, detached: true });
    return;
  }
  console.log(`detached clients from '${sess}'`);
}

/**
 * kill NAME...: end whole tmux sessions (or --all slot-machine sessions).
 * @param {string[]} argv - CLI arguments for the session kill command.
 */
export function cmdKill(argv) {
  const { values, positionals } = parseCmd('kill', argv, argOptions('session-kill'));

  let names = positionals;
  if (values.all) {
    names = slotSessions().map(session => session.name);
    if (!names.length) {
      if (values.json)
        emitJson([]);
      else console.log(`no running ${SESSION_PREFIX}* tmux sessions`);
      return;
    }
  }
  else if (names.length === 0) {
    if (values.json)
      die('kill: name a session, or --all');
    console.error(`kill: name a session, or --all for every ${SESSION_PREFIX}* session:`);
    console.error(formatSessions(sessionRows(), SESSION_PREFIX));
    process.exit(1);
  }

  const results = [];
  for (const name of names) {
    if (!hasSession(name)) {
      results.push({ session: name, killed: false, reason: 'no such session' });
      continue;
    }
    tmux(['kill-session', '-t', name]);
    results.push({ session: name, killed: true });
  }
  if (values.json) {
    emitJson(results);
    if (!results.some(result => result.killed))
      process.exitCode = 1;
    return;
  }
  for (const result of results)
    console.log(result.killed ? `killed '${result.session}'` : `kill: no session '${result.session}'`);
  if (!results.some(result => result.killed))
    process.exit(1);
}

/**
 * create [N] [NAME]: build a tmux session laying out every slot worktree, N panes per window.
 * @param {string[]} argv - CLI arguments for the session create command.
 */
export function cmdBuild(argv) {
  const { values, positionals } = parseCmd('create', argv, argOptions('session-create'));

  const per = positionals[0] ?? '3';
  if (!['2', '3', '4'].includes(per))
    die(`create: panes per window must be 2, 3, or 4 (got '${per}'); try --help`);
  const perN = Number(per);
  const session = positionals[1] ?? `${SESSION_PREFIX}${per}`;

  if (values.kill)
    tmux(['kill-session', '-t', session]); // ignore errors
  if (hasSession(session)) {
    attachOrSwitch(session);
    return;
  }

  const slots = listSlots(); // full names: acme-slot-a ...
  if (slots.length === 0)
    die(`create: no ${PREFIX}* worktrees in ${DOCS} - create one: sm slot create a`);

  // Honor the user's tmux base-index so window numbering matches their config.
  let bidx = parseInt((tmuxOut(['show-options', '-gv', 'base-index']) ?? '0').trim(), 10);
  if (!Number.isFinite(bidx))
    bidx = 0;

  tmux(['new-session', '-d', '-s', session, '-n', 'desk', '-c', DOCS]); // window <bidx>: desk shell

  let win = bidx + 1;
  for (let index = 0; index < slots.length; index += perN) {
    const group = slots.slice(index, index + perN);
    const label = group.map(name => name.slice(PREFIX.length)).join(',');
    const target = `${session}:${win}`;
    let pane = req(
      tmuxOut([
        'new-window',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        target,
        '-n',
        `slot-${label}`,
        '-c',
        `${DOCS}/${group[0]}`,
      ]),
      'new-window',
    ).trim();
    sendLine(pane, claudeCmd(`${DOCS}/${group[0]}`));
    for (let paneIndex = 1; paneIndex < group.length; paneIndex++) {
      pane = req(
        tmuxOut(['split-window', '-P', '-F', '#{pane_id}', '-h', '-t', target, '-c', `${DOCS}/${group[paneIndex]}`]),
        'split-window',
      ).trim();
      sendLine(pane, claudeCmd(`${DOCS}/${group[paneIndex]}`));
    }
    tmux(['select-layout', '-t', target, 'even-horizontal']);
    win++;
  }

  tmux(['select-window', '-t', `${session}:${bidx}`]);
  attachOrSwitch(session);
}
