// slot namespace: per-slot inspection, freeness, focus, reset, and worktree add/rm.
import { existsSync } from 'node:fs';
import {
  BASE_BRANCH,
  DOCS,
  PREFIX,
  REPO_DIR,
} from '../constants.mjs';
import {
  agoStr,
  clr,
  die,
  emitJson,
  fmtAge,
  oneLine,
  renderFree,
  startSpinner,
} from '../format.mjs';
import {
  pexec,
  repoSlug,
  run,
  slotGit,
  tmux,
} from '../exec.mjs';
import { issueFromText } from '../slots/pure.mjs';
import {
  lockIsLive,
  lockTranscriptAge,
  readLock,
  removeLock,
} from '../slots/locks.mjs';
import {
  slotFreenessRows,
  slotPanes,
  slotRef,
  slotWorkerMap,
} from '../slots/gather.mjs';
import { argOptions, freenessRows, parseCmd, watchLoop } from './shared.mjs';

/**
 * free: show slot reusability (git + gh state) as a table, or watch it refresh.
 * @param {string[]} argv - CLI arguments for the free command.
 */
export async function cmdFree(argv) {
  const { values } = parseCmd('ls', argv, argOptions('slot-ls'));
  if (values.json) {
    emitJson(await freenessRows(true));
    return;
  }
  if (values.watch || values.follow)
    return watchLoop('sm slot ls', 5000, slotFreenessRows, renderFree);
  const rows = await freenessRows(values.free);
  if (values.free) {
    console.log(
      rows
        .filter(row => row.free)
        .map(row => row.slot)
        .join(' '),
    );
    return;
  }
  renderFree(rows);
}

/**
 * inspect SLOT: a slot's branch, git state, live/dead worker, lock owner, and every PR.
 * @param {string[]} argv - CLI arguments for the inspect command.
 */
export async function cmdInfo(argv) {
  const { values, positionals } = parseCmd('inspect', argv, argOptions('slot-inspect'));
  const json = values.json;
  if (!positionals.length)
    die('inspect: name a slot, e.g. sm slot inspect c');
  const { name, label: short, dir, exists } = slotRef(positionals[0]);
  if (!exists)
    die(`inspect: no worktree ${name} in ${DOCS}`);

  const stop = json ? () => {} : startSpinner('inspecting slot (git + gh pr)...');
  const { branch, dirty, ahead } = await slotGit(dir);
  const worker = slotWorkerMap().get(short) || 'none';
  const raw = readLock(dir);
  const age = raw && !raw.unparseable ? lockTranscriptAge(raw) : null;
  const lock = !raw
    ? null
    : raw.unparseable
      ? { unparseable: true }
      : {
          session: raw.session,
          ts: raw.ts,
          task: raw.task,
          transcript: raw.transcript,
          owner: raw.owner,
          ageSec: age,
          live: lockIsLive(raw, worker === 'live'),
          crossWired: !!(raw.owner && raw.owner !== short),
        };
  const out = await run('gh', [
    'pr',
    'list',
    '--repo',
    await repoSlug(dir),
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,state,isDraft,title,url',
    '--jq',
    '.[] | [(.number|tostring), .state, (if .isDraft then "draft" else "-" end), .title, .url] | @tsv',
  ]);
  const prs = out.trim()
    ? out
        .trim()
        .split('\n')
        .map((line) => {
          const [number, state, draft, title, url] = line.split('\t');
          return { number: Number(number), state, draft: draft === 'draft', title, url };
        })
    : [];
  stop();

  const issue = (raw && !raw.unparseable ? raw.issue : null) ?? issueFromText(branch);
  if (json) {
    emitJson({ slot: short, branch, issue, dirty, ahead, worker, lock, prs });
    return;
  }

  console.log(`${clr.bold(short)}  ${branch}`);
  console.log(`  issue:  ${issue ? clr.bold(issue) : clr.dim('-')}`);
  console.log(
    `  git:    ${dirty ? clr.red('dirty') : 'clean'}${ahead ? `, ${ahead} commit(s) ahead of the base` : ''}`,
  );
  console.log(
    `  worker: ${worker === 'live' ? clr.green('live') : worker === 'dead' ? clr.red('dead (Claude exited)') : clr.dim('none (no pane)')}`,
  );
  if (!lock) {
    console.log(`  lock:   ${clr.green('unlocked')}`);
  }
  else if (lock.unparseable) {
    console.log(`  lock:   ${clr.red('present but unparseable')}`);
  }
  else {
    const life = lock.live ? clr.green('LIVE') : clr.yellow('STALE');
    const activity = lock.ageSec == null ? 'transcript gone' : `active ${fmtAge(lock.ageSec)} ago`;
    const cross = lock.crossWired ? clr.red(`  [transcript is in ${PREFIX}${lock.owner}, not ${short}]`) : '';
    const task = lock.task ? ` for ${oneLine(lock.task, 60)}` : '';
    console.log(
      `  lock:   ${clr.red('locked')} (${life}, ${activity}) by ${lock.session || '?'}${task}${lock.ts ? ` since ${agoStr(lock.ts)}` : ''}${cross}`,
    );
    if (lock.transcript)
      console.log(`          ${clr.dim(lock.transcript)}`);
    if (!lock.live)
      console.log(`          ${clr.dim(`reclaim: sm lock prune ${short}`)}`);
  }
  if (!prs.length) {
    console.log('  prs:    (none for this branch)');
    return;
  }
  console.log('  prs:');
  const SC = { OPEN: 'yellow', MERGED: 'green', CLOSED: 'red' };
  for (const pr of prs) {
    const st = (clr[SC[pr.state]] || clr.dim)(pr.state.toLowerCase() + (pr.draft ? ' (draft)' : ''));
    console.log(`    #${pr.number}  ${st}  ${pr.title}`);
    console.log(`        ${clr.dim(pr.url)}`);
  }
}

/**
 * Bring a slot worktree back to a clean base (its base branch @ origin/main). Refuses a
 * live-locked or dirty slot, or one with unmerged commits, unless force. Throws on refusal or
 * on a git failure (never silently no-ops), so a caller can't dispatch onto an un-reset slot.
 * @param {string} name - the slot's branch name.
 * @param {object} [opts] - options.
 * @param {boolean} [opts.force] - override a live lock, or discard dirty/unmerged changes.
 * @returns {Promise<{slot: string, branch: string}>} the reset slot's label and branch.
 */
export async function resetSlot(name, { force = false } = {}) {
  const { label: short, dir, exists } = slotRef(name);
  if (!exists)
    throw new Error(`no worktree ${name}`);
  const lock = readLock(dir);
  const workerLive = slotWorkerMap().get(short) === 'live';
  if (lockIsLive(lock, workerLive) && !force)
    throw new Error(`${short} is held by a live session (--force to override)`);
  // Freshen the base FIRST so `ahead` reflects the current origin/<base>: a just-merged slot
  // reads 0 ahead (its commits are now in base) and resets cleanly without --force, while a slot
  // with genuinely unmerged commits reads ahead>0 and is protected.
  await run('git', ['-C', dir, 'fetch', '-q', 'origin', BASE_BRANCH]);
  const { dirty, ahead } = await slotGit(dir);
  if (dirty && !force)
    throw new Error(`${short} has uncommitted changes (--force to discard)`);
  if (ahead !== 0 && !force) {
    throw new Error(
      ahead == null
        ? `${short}: cannot resolve origin/${BASE_BRANCH} to reset against (--force to reset anyway)`
        : `${short} has ${ahead} commit(s) not on origin/${BASE_BRANCH} (--force to discard)`,
    );
  }
  if (dirty) {
    await run('git', ['-C', dir, 'reset', '--hard']);
    await run('git', ['-C', dir, 'clean', '-fd']);
  }
  const switched = await pexec('git', ['-C', dir, 'switch', name])
    .then(() => true)
    .catch(() => false);
  // pexec (not run) so an unresolvable base / failed reset throws instead of silently no-opping
  // and dropping the lock on a slot that never actually reset.
  if (!switched)
    await pexec('git', ['-C', dir, 'switch', '-C', name, `origin/${BASE_BRANCH}`]);
  await pexec('git', ['-C', dir, 'reset', '--hard', `origin/${BASE_BRANCH}`]);
  removeLock(dir); // reclaim: only after a verified-successful reset
  return { slot: short, branch: name };
}

/**
 * reset SLOT: bring a slot worktree back to a clean base branch @ origin/main.
 * @param {string[]} argv - CLI arguments for the reset command.
 */
export async function cmdReset(argv) {
  const { values, positionals } = parseCmd('reset', argv, argOptions('slot-reset'));
  if (!positionals.length)
    die('reset: name a slot, e.g. sm slot reset f');
  const { name } = slotRef(positionals[0]);
  const stop = values.json ? () => {} : startSpinner('resetting slot (git fetch)...');
  let res;
  try {
    res = await resetSlot(name, { force: values.force });
  }
  catch (err) {
    die(`reset: ${err.message}`); // the spinner's exit hook restores the cursor
  }
  finally {
    stop();
  }
  if (values.json) {
    emitJson({ ...res, reset: true });
    return;
  }
  console.log(`${res.slot}: reset to ${res.branch} @ origin/${BASE_BRANCH} (clean)`);
}

/**
 * focus SLOT | -f: jump the tmux client to a slot's pane (prefers the attached session).
 * With -f/--first-free, target the first free slot instead of a named one.
 * @param {string[]} argv - CLI arguments for the focus command.
 */
export async function cmdFocus(argv) {
  const { values, positionals } = parseCmd('focus', argv, argOptions('slot-focus'));
  let arg = positionals[0];
  if (values['first-free'] && arg)
    die('focus: use either -f or a slot name, not both');
  if (values['first-free']) {
    const rows = await freenessRows(values.json, 'finding a free slot...');
    const pick = rows.find(row => row.free);
    if (!pick)
      die('focus: no free slot (see: sm slot ls)');
    arg = pick.slot;
  }
  if (!arg)
    die('focus: name a slot, e.g. sm slot focus h  (or -f for the first free)');
  const { label: short } = slotRef(arg);
  const hit = slotPanes().get(short);
  if (!hit)
    die(`focus: no pane for slot ${short} in any running session`);
  if (values.json) {
    emitJson({ slot: short, ...hit });
    return;
  }
  tmux(['select-window', '-t', hit.window]);
  tmux(['select-pane', '-t', hit.pane]);
  if (process.env.TMUX)
    tmux(['switch-client', '-t', hit.session], { stdio: 'inherit' });
  else process.exit(tmux(['attach', '-t', hit.session], { stdio: 'inherit' }).status ?? 0);
}

/**
 * add LABEL [base]: create a new slot worktree <root>/<prefix><label> on its base branch
 * <prefix><label> off origin/<base>. Uses an existing slot to locate the shared repo.
 * @param {string[]} argv - CLI arguments for the add command.
 */
export async function cmdAdd(argv) {
  const { values, positionals } = parseCmd('create', argv, argOptions('slot-create'));
  if (!positionals.length)
    die('create: name a slot, e.g. sm slot create l');
  const { name, label, dir, exists } = slotRef(positionals[0]);
  const base = positionals[1] || BASE_BRANCH;
  if (exists)
    die(`create: ${name} already exists`);
  // Any worktree of the repo can add another; the repo's main worktree is always present.
  const anchor = REPO_DIR;
  if (!anchor || !existsSync(anchor))
    die(`create: repo not found${REPO_DIR ? ` at ${REPO_DIR}` : ''}; run: sm repo use <repo>`);

  const stop = values.json ? () => {} : startSpinner('creating slot (git fetch + worktree add)...');
  await run('git', ['-C', anchor, 'fetch', '-q', 'origin', base]); // best-effort
  let from = null;
  let err = null;
  for (const start of [`origin/${base}`, base]) {
    // new base branch off origin, else local base
    err = await pexec('git', ['-C', anchor, 'worktree', 'add', dir, '-b', name, start])
      .then(() => null)
      .catch(error => error);
    if (!err) {
      from = start;
      break;
    }
  }
  if (err) {
    // branch already exists
    err = await pexec('git', ['-C', anchor, 'worktree', 'add', dir, name])
      .then(() => null)
      .catch(error => error);
    if (!err)
      from = `existing branch ${name}`;
  }
  stop();
  if (err)
    die(`create: git worktree add failed - ${(err.stderr || err.message || '').trim()}`);

  if (values.json) {
    emitJson({ slot: label, dir, branch: name, base, from });
    return;
  }
  console.log(`created slot ${clr.bold(label)}  ${dir}  (branch ${name} @ ${from})`);
  console.log(clr.dim('  next: sm session create to lay it out'));
}

/**
 * rm LABEL: remove a slot worktree. Refuses a live-locked or dirty worktree unless --force.
 * @param {string[]} argv - CLI arguments for the rm command.
 */
export async function cmdRm(argv) {
  const { values, positionals } = parseCmd('rm', argv, argOptions('slot-rm'));
  if (!positionals.length)
    die('rm: name a slot, e.g. sm slot rm l');
  const { name, label, dir, exists } = slotRef(positionals[0]);
  if (!exists)
    die(`rm: no worktree ${name} in ${DOCS}`);
  const lock = readLock(dir);
  const workerLive = slotWorkerMap().get(label) === 'live';
  if (lockIsLive(lock, workerLive) && !values.force)
    die(`rm: ${label} is held by a live session (--force to override)`);
  removeLock(dir); // the lock is sm's artifact; removing the worktree discards it
  // git worktree remove must run from a different worktree; the repo's main is always one.
  const anchor = REPO_DIR;
  if (!anchor || !existsSync(anchor))
    die(`rm: repo not found${REPO_DIR ? ` at ${REPO_DIR}` : ''}; run: sm repo use <repo>`);

  const err = await pexec('git', [
    '-C',
    anchor,
    'worktree',
    'remove',
    ...(values.force ? ['--force'] : []),
    dir,
  ])
    .then(() => null)
    .catch(error => error);
  if (err) {
    die(
      `rm: git worktree remove failed - ${(err.stderr || err.message || '').trim()} (try --force if it has changes)`,
    );
  }
  if (values.json) {
    emitJson({ slot: label, removed: true });
    return;
  }
  console.log(`removed slot ${clr.bold(label)}  ${dir}`);
}
