// session namespace: build/attach/reload/detach/kill the multiplexer sessions that lay out
// slots. All session/pane operations go through the active mux backend (lib/mux); windows
// ("groups") and panes are addressed by the handles creation ops return - never by index.
import {
  DOCS,
  PREFIX,
  REPO_DIR,
  SESSION_PREFIX,
} from '../constants.mjs';
import {
  die,
  emitJson,
  formatSessions,
} from '../format.mjs';
import { listSlots } from '../exec.mjs';
import { attachOrSwitch, mux, muxReq, sendLine } from '../mux/index.mjs';
import { reloadPaneWidth, reloadTargetWindow, selectPanes } from '../slots/pure.mjs';
import { sessionRows, slotSessions } from '../slots/gather.mjs';
import { loadRoster, resolveInstance, safeLaunchLine } from '../agents/index.mjs';
import { argOptions, parseCmd, recordWorker, resolveSession } from './shared.mjs';

// Record the spawned worker on its slot's document (agent instance, transport). Resolution
// failure means safeLaunchLine already warned and the pane sits at a shell - nothing to record.
function recordSpawn(dir, lbl) {
  try {
    const { name, model } = resolveInstance(REPO_DIR, lbl);
    recordWorker(dir, lbl, { agent: name, model, transport: 'pane' });
  }
  catch { /* unresolved instance */ }
}

/**
 * ls: list the running slot-machine sessions.
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
  if (sess && !muxReq('sessionExists', { name: sess }))
    die(`attach: no session '${sess}'`);
  if (!sess) {
    sess
      = muxReq('listSessions')
        .filter(row => row.name.startsWith(SESSION_PREFIX))
        .sort((left, right) => right.lastActivity - left.lastActivity)[0]
        ?.name ?? null;
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
export async function cmdReload(argv) {
  const { values, positionals } = parseCmd('reload', argv, argOptions('session-reload'));
  await loadRoster();
  const sess = resolveSession(positionals[0] ?? null, 'reload');
  const labels = listSlots().map(name => name.slice(PREFIX.length));
  const panes = muxReq('listPanes', { scope: { session: sess } });
  const present = new Set(selectPanes(panes, DOCS, PREFIX, null).map(target => target.lbl));
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
  const wins = muxReq('listGroups', { session: sess })
    .filter(group => group.label.startsWith('slot-'))
    .map(group => ({ id: group.id, name: group.label, panes: group.paneCount }));
  const perN = reloadPaneWidth(wins.map(win => win.panes));

  const windowLabels = id =>
    selectPanes(muxReq('listPanes', { scope: { group: id } }), DOCS, PREFIX, null).map(target => target.lbl);

  const touched = new Set();
  for (const lbl of missing) {
    const dir = `${DOCS}/${PREFIX}${lbl}`;
    let win = reloadTargetWindow(wins, perN);
    let pane;
    if (win) {
      ({ paneId: pane } = muxReq('spawnPane', { group: win.id, cwd: dir, label: lbl }));
      win.panes++;
    }
    else {
      const made = muxReq('createGroup', { session: sess, label: `slot-${lbl}`, cwd: dir });
      pane = made.paneId;
      mux('setLabel', { paneId: pane, label: lbl });
      win = { id: made.groupId, name: `slot-${lbl}`, panes: 1 };
      wins.push(win);
    }
    const line = safeLaunchLine(REPO_DIR, lbl, dir);
    if (line) {
      sendLine(pane, line);
      recordSpawn(dir, lbl);
    }
    // else: safeLaunchLine already warned; the pane stays at its shell
    touched.add(win.id);
  }
  // window names list their member slots; refresh the ones we grew
  for (const id of touched) {
    mux('setGroupLabel', { groupId: id, label: `slot-${windowLabels(id).join(',')}` });
    mux('arrangeLayout', { group: id, layout: 'tile-horizontal' });
  }
  if (values.json) {
    emitJson({ session: sess, added: missing });
    return;
  }
  console.log(`added ${missing.length} slot pane(s) to '${sess}': ${missing.join(' ')}`);
}

/**
 * detach [NAME]: detach your own client when run inside the multiplexer with no NAME, else
 * every client attached to the named (or sole running) session.
 * @param {string[]} argv - CLI arguments for the detach command.
 */
export function cmdDetach(argv) {
  const { values, positionals } = parseCmd('detach', argv, argOptions('session-detach'));
  if (!positionals.length && muxReq('insideMux')) {
    if (values.json)
      emitJson({ detached: 'self' });
    mux('detach', {});
    return;
  }
  const sess = resolveSession(positionals[0] ?? null, 'detach');
  mux('detach', { name: sess });
  if (values.json) {
    emitJson({ session: sess, detached: true });
    return;
  }
  console.log(`detached clients from '${sess}'`);
}

/**
 * kill NAME...: end whole sessions (or --all slot-machine sessions).
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
      else console.log(`no running ${SESSION_PREFIX}* sessions`);
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
    if (!muxReq('sessionExists', { name })) {
      results.push({ session: name, killed: false, reason: 'no such session' });
      continue;
    }
    mux('killSession', { name });
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
 * create [N] [NAME]: build a session laying out every slot worktree, N panes per window.
 * @param {string[]} argv - CLI arguments for the session create command.
 */
export async function cmdBuild(argv) {
  const { values, positionals } = parseCmd('create', argv, argOptions('session-create'));
  await loadRoster();

  const per = positionals[0] ?? '3';
  if (!['2', '3', '4'].includes(per))
    die(`create: panes per window must be 2, 3, or 4 (got '${per}'); try --help`);
  const perN = Number(per);
  const session = positionals[1] ?? `${SESSION_PREFIX}${per}`;

  if (values.kill)
    mux('killSession', { name: session }); // idempotent: a missing session is fine
  if (muxReq('sessionExists', { name: session })) {
    attachOrSwitch(session);
    return;
  }

  const slots = listSlots(); // full names: acme-slot-a ...
  if (slots.length === 0)
    die(`create: no ${PREFIX}* worktrees in ${DOCS} - create one: sm slot create a`);

  // Detached create; the desk window is the dispatcher shell. Groups and panes are addressed
  // by the handles the ops return - never by window index (no base-index coupling).
  const { firstPaneId: deskPane } = muxReq('createSession', { name: session, cwd: DOCS, firstGroupLabel: 'desk' });

  for (let index = 0; index < slots.length; index += perN) {
    const group = slots.slice(index, index + perN);
    const label = group.map(name => name.slice(PREFIX.length)).join(',');
    const dir0 = `${DOCS}/${group[0]}`;
    const lbl0 = group[0].slice(PREFIX.length);
    const { groupId, paneId } = muxReq('createGroup', { session, label: `slot-${label}`, cwd: dir0 });
    mux('setLabel', { paneId, label: lbl0 });
    const line0 = safeLaunchLine(REPO_DIR, lbl0, dir0);
    if (line0) {
      sendLine(paneId, line0);
      recordSpawn(dir0, lbl0);
    }
    for (let paneIndex = 1; paneIndex < group.length; paneIndex++) {
      const dirN = `${DOCS}/${group[paneIndex]}`;
      const lblN = group[paneIndex].slice(PREFIX.length);
      const { paneId: pane } = muxReq('spawnPane', { group: groupId, cwd: dirN, label: lblN });
      const lineN = safeLaunchLine(REPO_DIR, lblN, dirN);
      if (lineN) {
        sendLine(pane, lineN);
        recordSpawn(dirN, lblN);
      }
    }
    mux('arrangeLayout', { group: groupId, layout: 'tile-horizontal' });
  }

  mux('focus', { paneId: deskPane }); // land the user on the dispatcher shell
  attachOrSwitch(session);
}
