// top-level namespace: environment health check (doctor) and usage stats.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_BRANCH,
  configReport,
  DOCS,
  LOCK_TMP_FILENAME,
  PREFIX,
  REPO_DIR,
  REPO_NAME,
  VERSION,
} from '../constants.mjs';
import { CONFIG_ERROR, loadConfig } from '../context.mjs';
import {
  agoStr,
  clr,
  emitJson,
  oneLine,
  startSpinner,
} from '../format.mjs';
import {
  listSlots,
  pexec,
  repoSlug,
  run,
} from '../exec.mjs';
import { activeMux, mux } from '../mux/index.mjs';
import { sessionRows, slotPanes, slotWorkerMap } from '../slots/gather.mjs';
import { listResourceLocks, readDoc, readLock, readWorker } from '../slots/locks.mjs';
import { journalSize, readJournal } from '../slots/journal.mjs';
import { inboxCounts } from '../inbox.mjs';
import { readArmed } from './watch.mjs';
import { fixServePerms, serveChecks } from '../serve/doctor.mjs';
import { activityOf, inUseInstances, loadRoster, mcpServersFor } from '../agents/index.mjs';

import { clearUsage, readUsage, summarizeUsage } from '../usage.mjs';
import { BIN_DIR, binDirOnPath, BINS, fixLink, linkStatus, PKG_ROOT } from '../setup.mjs';
import { callOp } from '../agents/contract.mjs';
import { argOptions, parseCmd, watchLoop } from './shared.mjs';

/**
 * stats: per-command usage from the local usage log - what gets used, what fails, what's slow.
 * @param {string[]} argv - CLI arguments for the stats command.
 */
export function cmdStats(argv) {
  const { values } = parseCmd('stats', argv, argOptions('stats'));
  let entries = readUsage();
  const total = entries.length;
  if (values.days) {
    const cutoff = Date.now() - (parseInt(values.days, 10) || 0) * 86_400_000;
    entries = entries.filter(entry => (entry.ts || 0) >= cutoff);
  }
  const rows = summarizeUsage(entries);
  if (values.json) {
    emitJson(rows);
  }
  else if (!rows.length) {
    console.log('stats: no usage recorded yet');
  }
  else {
    const width = Math.max(8, ...rows.map(row => row.cmd.length));
    console.log(
      clr.dim(
        `${'command'.padEnd(width)}  ${'count'.padStart(5)}  ${'errs'.padStart(4)}  ${'tty'.padStart(4)}  ${'avg ms'.padStart(7)}  ${'max ms'.padStart(7)}  last used`,
      ),
    );
    for (const row of rows) {
      const last = row.lastTs ? agoStr(row.lastTs) : '-';
      const errs = row.errors ? clr.red(String(row.errors).padStart(4)) : '   0';
      console.log(
        `${clr.bold(row.cmd.padEnd(width))}  ${String(row.count).padStart(5)}  ${errs}  ${String(row.tty).padStart(4)}  ${String(row.avgMs).padStart(7)}  ${String(row.maxMs).padStart(7)}  ${clr.dim(last)}`,
      );
    }
    console.log(
      clr.dim(
        `\n${entries.length} invocation(s)${values.days ? ` in the last ${values.days}d (of ${total} total)` : ''}`,
      ),
    );
  }
  if (values.clear)
    clearUsage();
}

/**
 * version: the build + runtime identity of this install (version, node, install source, MCP
 * entry, current repo). `sm --version` / `-V` stays the bare-number shortcut.
 * @param {string[]} argv - CLI arguments for the version command.
 */
export async function cmdVersion(argv) {
  const { values } = parseCmd('version', argv, argOptions('version'));
  const shortSha = existsSync(join(PKG_ROOT, '.git'))
    ? (await run('git', ['-C', PKG_ROOT, 'rev-parse', '--short', 'HEAD'])).trim()
    : '';
  const source = shortSha ? `git ${shortSha}` : 'packaged';
  const mcpEntry = join(BIN_DIR, 'slot-machine-mcp');
  if (values.json) {
    emitJson({
      version: VERSION,
      node: process.version,
      install: PKG_ROOT,
      source,
      mcp: mcpEntry,
      repo: REPO_DIR ? { name: REPO_NAME, dir: REPO_DIR } : null,
    });
    return;
  }
  const rows = [
    ['slot-machine', clr.bold(VERSION)],
    ['node', process.version],
    ['install', `${PKG_ROOT}  ${clr.dim(source)}`],
    ['mcp', mcpEntry],
    ['repo', REPO_DIR ? `${REPO_NAME}  ${clr.dim(REPO_DIR)}` : clr.dim('none set - sm repo use <repo>')],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows)
    console.log(`  ${label.padEnd(labelWidth)}  ${value}`);
}

/**
 * floor: one-shot fleet snapshot - sessions, slots (worker/activity/task/lock), resource
 * locks, unread inbox count. The dispatcher's single situational-awareness call; cheap
 * (multiplexer + lockfiles only, no git/gh). `sm slot ls` stays the reusability authority.
 * @param {string[]} argv - CLI arguments for the floor command.
 */
export async function cmdFloor(argv) {
  const { values } = parseCmd('floor', argv, argOptions('floor'));
  await loadRoster();

  const snapshot = () => {
    const labels = listSlots().map(name => name.slice(PREFIX.length));
    const workers = slotWorkerMap();
    const panes = slotPanes();
    const slots = labels.map((lbl) => {
      const worker = workers.get(lbl) || 'none';
      const pane = panes.get(lbl)?.pane ?? null;
      const cap = pane ? mux('capture', { paneId: pane }) : null;
      const activity = worker === 'live' ? activityOf(REPO_DIR, lbl, cap?.ok ? cap.value : '', !!pane) : '-';
      const lock = readLock(join(DOCS, PREFIX + lbl));
      const record = readWorker(join(DOCS, PREFIX + lbl));
      return {
        slot: lbl,
        worker,
        activity,
        transport: record?.transport ?? null, // how the worker is driven (null = legacy slot, no record)
        locked: !!lock,
        task: lock?.task ?? null,
        issue: lock?.issue ?? null,
        session: panes.get(lbl)?.session ?? null,
      };
    });
    return {
      repo: REPO_NAME,
      sessions: sessionRows(),
      slots,
      resources: listResourceLocks(),
      inbox: inboxCounts(REPO_NAME), // {unread, total, oldestUnreadTs} - unread is cursor-based
      watch: readArmed(REPO_NAME), // {pid, startedAt} | null - is anything watching the inbox?
    };
  };

  const render = (snap) => {
    const sess = snap.sessions.map(row => `${row.name} (${row.slots} slots${row.attached ? ', attached' : ''})`).join('  ');
    console.log(`${clr.bold(REPO_NAME)}  ${sess || clr.dim('no running session')}`);
    const lw = Math.max(4, ...snap.slots.map(row => row.slot.length));
    console.log(clr.dim(`  ${'slot'.padEnd(lw)} ${'worker'.padEnd(6)} ${'activity'.padEnd(8)} ${'via'.padEnd(8)} ${'lock'.padEnd(4)} task`));
    for (const row of snap.slots) {
      const worker = (row.worker === 'live' ? clr.green : row.worker === 'dead' ? clr.red : clr.dim)(row.worker.padEnd(6));
      const via = row.transport ? row.transport.padEnd(8) : clr.dim('-'.padEnd(8));
      const lock = row.locked ? clr.red('lock') : clr.dim('-   ');
      console.log(`  ${clr.bold(row.slot.padEnd(lw))} ${worker} ${row.activity.padEnd(8)} ${via} ${lock} ${row.task ? oneLine(row.task, 60) : clr.dim('-')}`);
    }
    for (const res of snap.resources)
      console.log(`  ${clr.bold(res.resource)}  held${res.task ? `  ${res.task}` : ''}`);
    // Starvation signal: an unread report aging out means nothing is reading the inbox.
    const oldest = snap.inbox.unread > 0 ? `, oldest unread ${agoStr(snap.inbox.oldestUnreadTs)}` : '';
    console.log(clr.dim(`  inbox: ${snap.inbox.unread} unread of ${snap.inbox.total}${oldest}`));
    console.log(clr.dim(`  watch: ${snap.watch ? `armed (pid ${snap.watch.pid}, ${agoStr(snap.watch.startedAt)})` : 'NOT armed'}`));
  };

  if (values.json) {
    emitJson(snapshot());
    return;
  }
  if (values.watch || values.follow)
    return watchLoop('sm floor', 5000, async () => snapshot(), render);
  render(snapshot());
}

/**
 * journal: read the repo's turn journal - append-only facts about the fleet (worker-created,
 * task-dispatched, turn-*, worker-replaced), newest last. History; the inbox is the mailbox.
 * @param {string[]} argv - CLI arguments for the journal command.
 */
export function cmdJournal(argv) {
  const { values } = parseCmd('journal', argv, argOptions('journal'));
  const tail = values.tail === undefined ? 20 : Math.max(0, Number.parseInt(values.tail, 10) || 0);
  let records = readJournal(REPO_NAME, {});
  if (values.slot)
    records = records.filter(rec => rec.slot === values.slot);
  if (tail)
    records = records.slice(-tail);
  if (values.json) {
    emitJson(records);
    return;
  }
  if (!records.length) {
    console.log(`journal: empty${values.slot ? ` for slot ${values.slot}` : ''}`);
    return;
  }
  for (const rec of records) {
    const what
      = rec.type === 'task-dispatched'
        ? oneLine(rec.task ?? '', 70)
        : rec.type === 'worker-created'
          ? `${rec.agent ?? '?'} (${rec.transport ?? '?'})`
          : rec.type === 'worker-replaced'
            ? `${rec.reason ?? ''}${rec.prevSessionId ? ` (was ${rec.prevSessionId})` : ''}`
            : rec.type === 'turn-completed'
              ? `${rec.ok ? 'ok' : 'FAILED'}${rec.ms != null ? ` ${rec.ms}ms` : ''}`
              : rec.type === 'pr-merged'
                ? `PR #${rec.pr}`
                : rec.type === 'delivered'
                  ? `${rec.count} event(s)${rec.slots?.length ? ` (${rec.slots.join(' ')})` : ''}`
                  : rec.reason ?? rec.task ?? '';
    // v2 facts (delivered, watch-degraded) are fleet-scoped and carry no slot.
    console.log(`${clr.dim(agoStr(rec.ts).padEnd(8))} ${clr.bold((rec.slot ?? '-').padEnd(4))} ${rec.type.padEnd(16)} ${what}`);
  }
}

/**
 * doctor: check that the environment + config are healthy for slot to work.
 * @param {string[]} argv - CLI arguments for the doctor command.
 */
export async function cmdDoctor(argv) {
  const { values } = parseCmd('doctor', argv, argOptions('doctor'));
  const fix = values.fix;
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const ver = async (cmd, args) => (await run(cmd, args)).trim().split('\n')[0];
  const stopSpin = values.json ? () => {} : startSpinner('running checks...');

  const backend = activeMux().name;
  const probe = mux('probe');
  add(backend, probe.ok ? 'ok' : 'fail', probe.ok ? probe.value.version : probe.detail || 'not found on PATH');

  // --fix / --fix-tmux: apply the backend's label-display config (tmux: upsert the pane-title
  // block into tmux.conf + apply live), then fall through so the normal checks verify the result.
  if (fix || values['fix-tmux']) {
    const fixed = mux('ensureLabelsVisible');
    if (fixed.ok) {
      const { path, changed } = fixed.value ?? {};
      add(
        `${backend} config`,
        'ok',
        changed ? `wrote pane-title block to ${path}` : `block already present in ${path}`,
      );
    }
  }
  // Pane titles: with N worker panes, the border title is how you tell them apart. A backend
  // with no such knob (labelsVisible unsupported) skips the check rather than warning.
  const titles = mux('labelsVisible');
  if (titles.ok) {
    add(
      `${backend} pane titles`,
      titles.value.ok ? 'ok' : 'warn',
      titles.value.ok
        ? `pane-border-status ${titles.value.value} (${titles.value.source})`
        : 'off - worker panes are hard to tell apart; fix: sm doctor --fix',
    );
  }
  const gitV = await ver('git', ['--version']);
  add('git', gitV ? 'ok' : 'fail', gitV || 'not found on PATH');
  const ghV = await ver('gh', ['--version']);
  add('gh', ghV ? 'ok' : 'warn', ghV || 'not found - PR state unavailable, slots may misclassify');
  add('node', 'ok', process.version);
  if (ghV) {
    const authed = await pexec('gh', ['auth', 'status'])
      .then(() => true)
      .catch(() => false);
    add(
      'gh auth',
      authed ? 'ok' : 'warn',
      authed ? 'authenticated' : 'not logged in (gh auth login) - PR state unavailable',
    );
  }

  // Bin symlinks in ~/.local/bin (--fix creates/repairs; never clobbers a real file).
  const links = BINS.map(linkStatus);
  if (fix) {
    for (const link of links) {
      if (fixLink(link) === 'fixed') {
        link.status = 'ok';
        link.fixed = true;
      }
    }
  }
  const badLinks = links.filter(link => link.status !== 'ok');
  add(
    'bin links',
    badLinks.length ? 'warn' : 'ok',
    badLinks.length
      ? `${badLinks.map(link => `${link.name}: ${link.status}`).join(', ')} - fix: sm doctor --fix`
      : `${BINS.join(', ')} -> ${join(PKG_ROOT, 'bin')}${links.some(link => link.fixed) ? ' (installed)' : ''}`,
  );
  add(
    'PATH',
    binDirOnPath() ? 'ok' : 'warn',
    binDirOnPath() ? `${BIN_DIR} is on PATH` : `${BIN_DIR} is not on PATH - add it in your shell rc`,
  );

  // Per-instance agent health + MCP wiring (the in-use instances: repo default + slot
  // overrides + claude). --fix wires any server the instance reports as not-yet-wired.
  const roster = await loadRoster();
  const rosterCfg = loadConfig();
  for (const name of inUseInstances(rosterCfg, REPO_DIR)) {
    const inst = roster.instances.get(name); // roster is keyed by instance name
    if (!inst) {
      add(`agent ${name}`, 'warn', 'not loaded - see sm agents ls');
      continue;
    }
    const mcpServers = mcpServersFor(rosterCfg, roster, name);
    const doctorArgs = { env: inst.env, mcpServers, deskDir: DOCS, repoDir: REPO_DIR };
    const doctorResult = callOp(inst.plugin, 'doctor', doctorArgs);
    if (!doctorResult.ok) {
      add(`agent ${name}`, 'warn', doctorResult.detail || doctorResult.err);
      continue;
    }
    add(`agent ${name}`, 'ok', doctorResult.value.version);
    const missing = doctorResult.value.mcp.filter(entry => !entry.wired).map(entry => entry.name);
    if (missing.length && fix)
      callOp(inst.plugin, 'setup', { mcpServers: mcpServers.filter(server => missing.includes(server.name)), env: inst.env });
    const after = fix ? callOp(inst.plugin, 'doctor', doctorArgs) : doctorResult;
    const stillMissing = (after.ok ? after.value.mcp : doctorResult.value.mcp).filter(entry => !entry.wired).map(entry => entry.name);
    add(`  mcp (${name})`, stillMissing.length ? 'warn' : 'ok', stillMissing.length ? `missing: ${stillMissing.join(', ')} - fix: sm doctor --fix` : 'wired');
    // Watch-hook delivery (optional capability; absent op = agent has no delivery layer).
    let delivery = (after.ok ? after.value : doctorResult.value).delivery;
    const needsSetup = del => !(del.stop && del.promptSubmit) || del.unpinned?.length > 0;
    if (delivery && fix && needsSetup(delivery)) {
      const setup = callOp(inst.plugin, 'deliverySetup', { deskDir: DOCS, repoDir: REPO_DIR, env: inst.env });
      if (setup.ok) {
        const recheck = callOp(inst.plugin, 'doctor', doctorArgs);
        if (recheck.ok)
          delivery = recheck.value.delivery;
      }
      else {
        add(`  delivery (${name})`, 'warn', setup.detail || setup.err);
        delivery = null;
      }
    }
    if (delivery) {
      const wired = delivery.stop && delivery.promptSubmit;
      // Informational, not a warning: delivery is opt-in (the desk also needs SM_DESK=1).
      // Unpinned = pre-pin install still gating on the global current repo: flag with the fix.
      add(
        `  delivery (${name})`,
        delivery.unpinned?.length ? 'warn' : 'ok',
        !wired
          ? 'watch hooks not installed - opt in: sm doctor --fix, then launch the desk with SM_DESK=1'
          : delivery.unpinned?.length
            ? `watch hooks wired but NOT repo-pinned (${delivery.unpinned.join(', ')}) - 'sm repo use' elsewhere would repoint them; fix: sm doctor --fix`
            : `watch hooks wired in ${DOCS}/.claude/settings.json, pinned to ${REPO_NAME} (active only under SM_DESK=1)`,
      );
    }
  }

  // serve health: perms (the token is an execution credential), age, liveness, skew.
  if (fix)
    fixServePerms();
  for (const row of await serveChecks()) add(row.name, row.level, row.detail);

  const cfg = configReport();
  add('config file', cfg.fileOk ? 'ok' : 'ok', cfg.fileOk ? cfg.path : 'none yet');
  // doctor is config-tolerant (the router lets it run despite a bad config), so it is the place
  // that surfaces the problem: a set CONFIG_ERROR is a failed check, not a silent pass.
  if (CONFIG_ERROR)
    add('config', 'fail', CONFIG_ERROR);
  add(
    'repo',
    REPO_DIR ? 'ok' : 'warn',
    REPO_DIR ? `${REPO_NAME}  ${REPO_DIR}` : 'none set - run: sm repo use <repo>',
  );
  if (cfg.values) {
    for (const [key, val] of Object.entries(cfg.values)) add(`  ${key}`, 'ok', String(val));
  }

  if (REPO_DIR) {
    const rootOk = existsSync(DOCS);
    add('root dir', rootOk ? 'ok' : 'fail', rootOk ? DOCS : `${DOCS} missing`);
    const slots = rootOk ? listSlots() : [];
    add(
      'slots',
      slots.length ? 'ok' : 'warn',
      slots.length
        ? `${slots.length}: ${slots.map(name => name.slice(PREFIX.length)).join(',')}`
        : `no ${PREFIX}* worktrees in ${DOCS}`,
    );
    if (slots.length) {
      const dir = join(DOCS, slots[0]);
      const slug = await repoSlug(dir);
      add('origin remote', slug ? 'ok' : 'warn', slug || 'no origin remote - gh PR lookups will fail');
      const baseOk = await pexec('git', ['-C', dir, 'rev-parse', '--verify', `origin/${BASE_BRANCH}`])
        .then(() => true)
        .catch(() => false);
      add(
        `base origin/${BASE_BRANCH}`,
        baseOk ? 'ok' : 'warn',
        baseOk ? 'resolvable' : `not found - run: git -C <slot> fetch origin ${BASE_BRANCH}`,
      );
    }

    // Persistence health: worktree documents readable, no abandoned write mutexes, journal size.
    if (slots.length) {
      const docs = slots.map(name => readDoc(join(DOCS, name)));
      const unparseable = docs.filter(doc => doc?.unparseable).length;
      add(
        'worktree docs',
        unparseable ? 'warn' : 'ok',
        unparseable
          ? `${unparseable} unparseable - see sm slot inspect`
          : `${docs.filter(doc => doc && !doc.unparseable).length}/${slots.length} recorded`,
      );
      const staleTmps = slots.filter((name) => {
        try {
          return Date.now() - statSync(join(DOCS, name, LOCK_TMP_FILENAME)).mtimeMs > 60_000;
        }
        catch {
          return false;
        }
      });
      if (staleTmps.length)
        add('doc write mutex', 'warn', `stale ${LOCK_TMP_FILENAME} in: ${staleTmps.map(name => name.slice(PREFIX.length)).join(', ')} (crashed writer; safe to remove)`);
    }
    const journalBytes = journalSize(REPO_NAME);
    add('journal', 'ok', journalBytes ? `${Math.round(journalBytes / 1024)} KB` : 'empty');
  }

  stopSpin();
  const fails = checks.filter(check => check.level === 'fail').length;
  const warns = checks.filter(check => check.level === 'warn').length;
  if (values.json) {
    emitJson({ ok: fails === 0, fails, warns, checks });
    if (fails)
      process.exitCode = 1;
    return;
  }
  const mark = { ok: clr.green('ok  '), warn: clr.yellow('warn'), fail: clr.red('fail') };
  const width = Math.max(...checks.map(check => check.name.length));
  for (const check of checks) console.log(`  ${mark[check.level]}  ${check.name.padEnd(width)}  ${clr.dim(check.detail)}`);
  console.log(
    `\n${fails ? clr.red(`${fails} problem(s)`) : clr.green('healthy')}${warns ? clr.yellow(`, ${warns} warning(s)`) : ''}`,
  );
  if (fails)
    process.exit(1);
}
