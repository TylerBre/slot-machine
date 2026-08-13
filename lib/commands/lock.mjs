// lock namespace: slot worktree locks and named shared-resource locks.
import { join } from 'node:path';
import {
  CLAIM_POLL_MS,
  CLAIM_WAIT_MS,
  DOCS,
  PREFIX,
  PRUNE_DEFAULT_MIN,
} from '../constants.mjs';
import {
  agoStr,
  clr,
  die,
  emitJson,
  fmtAge,
} from '../format.mjs';
import {
  killProcesses,
  listSlots,
  resourceProcessPids,
} from '../exec.mjs';
import { loadRoster } from '../agents/index.mjs';
import { detectRole, labelFromDir } from '../slots/pure.mjs';
import {
  claimResource,
  listResourceLocks,
  lockIsLive,
  lockTranscriptAge,
  readLock,
  releaseResource,
  removeLock,
  writeLock,
} from '../slots/locks.mjs';
import {
  slotRef,
  slotWorkerMap,
} from '../slots/gather.mjs';
import { argOptions, parseCmd } from './shared.mjs';

/**
 * claim NAME [task]: mark a slot OR a named shared resource busy. A slot name writes its
 * .worktree-lock; any other multi-char name is a machine-level resource lock (e.g. "browser"),
 * acquired atomically so racing claimants lose cleanly instead of colliding on the resource.
 * @param {string[]} argv - CLI arguments for the claim command.
 */
export async function cmdClaim(argv) {
  const { values, positionals } = parseCmd('claim', argv, argOptions('lock-claim'));
  if (!positionals.length)
    die('claim: name a slot or resource, e.g. sm lock claim f "ABC-123" / sm lock claim browser');
  const name = positionals[0];
  const { label, dir, exists } = slotRef(name);

  if (exists) {
    // slot worktree lock (original behavior; panes are resolved live by label, never stored)
    const lock = writeLock(dir, { session: values.session || null, task: positionals[1] || null });
    if (values.json) {
      emitJson({ slot: label, claimed: true, ...lock });
      return;
    }
    console.log(`claimed slot ${clr.bold(label)}${lock.task ? ` for ${lock.task}` : ''}`);
    return;
  }
  // Single-char names are slot labels; a missing worktree there is a typo, not a resource.
  if (name.length === 1)
    die(`claim: no worktree ${PREFIX}${name} in ${DOCS}`);

  // Named resource lock. Holder cwd = -s SLOT's worktree, else this worker's slot root, else null.
  // Reconstruct the slot root (not raw cwd) so claiming from a slot subdir still resolves the lock.
  const det = detectRole(process.cwd(), DOCS, PREFIX);
  const holderCwd = values.slot
    ? join(DOCS, PREFIX + values.slot)
    : det.role === 'worker'
      ? join(DOCS, PREFIX + det.slot)
      : null;
  const holderSlot = labelFromDir(holderCwd);
  if (!holderCwd)
    die('claim: claim a shared resource from within a slot, or pass -s SLOT');
  // No pid recorded: the resource's backing process is launched AFTER the claim and resolved
  // live at release (resourceProcessPids); the holder is identified by cwd.
  const meta = { cwd: holderCwd, task: positionals[1] || null };
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    let result = claimResource(name, meta);
    if (result.reason === 'slot-not-locked')
      die(`claim: slot ${holderSlot} has no lock - claim the slot first (sm lock claim ${holderSlot})`);
    if (!result.ok && result.holder) {
      // Steal only when the holder's worker is demonstrably dead, or on --force. 'none'
      // (no pane info at all) is NOT auto-stolen - that needs an explicit --force.
      const hl = labelFromDir(result.holder.cwd);
      const holderDead = hl ? slotWorkerMap().get(hl) === 'dead' : false;
      if (holderDead || values.force) {
        // Stealing is a release + re-claim: it must terminate the resource's backing
        // process (e.g. the orphaned browser), not just drop the lockfile.
        killProcesses(resourceProcessPids(name));
        releaseResource(name);
        result = claimResource(name, meta);
      }
    }
    if (result.ok) {
      if (values.json) {
        emitJson({ resource: name, claimed: true, ...result.lock });
        return;
      }
      console.log(
        `claimed ${clr.bold(name)}${holderSlot ? ` for slot ${holderSlot}` : ''}${meta.task ? ` (${meta.task})` : ''}`,
      );
      return;
    }
    if (!values.wait || Date.now() > deadline) {
      const holder = result.holder;
      const hl = labelFromDir(holder?.cwd);
      const held = holder
        ? `held by ${hl ? `slot ${hl}` : 'unknown'}${holder.task ? ` (${holder.task})` : ''} since ${agoStr(holder.ts)}`
        : 'held';
      if (values.json) {
        emitJson({ resource: name, claimed: false, holder });
        process.exit(1);
      }
      die(
        `claim: ${name} is ${held}${values.wait ? ' - wait timed out' : ' (use --wait to queue, --force to steal)'}`,
      );
    }
    await new Promise(res => setTimeout(res, CLAIM_POLL_MS));
  }
}

/**
 * release NAME: free a slot's .worktree-lock or a named resource lock. Inverse of claim.
 * @param {string[]} argv - CLI arguments for the release command.
 */
export function cmdRelease(argv) {
  const { values, positionals } = parseCmd('release', argv, argOptions('lock-release'));
  if (!positionals.length)
    die('release: name a slot or resource, e.g. sm lock release f / sm lock release browser');
  const name = positionals[0];
  const { label, dir, exists: isSlot } = slotRef(name);
  if (!isSlot && name.length === 1)
    die(`release: no worktree ${PREFIX}${name} in ${DOCS}`);
  // A resource stands for a userland process; releasing it terminates that process, not just
  // the lockfile (the orphan would block the next claimant, e.g. Chromium single-locks its
  // profile). resourceProcessPids is the generic resource->process seam; slots have no process.
  const killed = isSlot ? [] : killProcesses(resourceProcessPids(name));
  const removed = isSlot ? removeLock(dir) : releaseResource(name);
  if (values.json) {
    emitJson({
      [isSlot ? 'slot' : 'resource']: isSlot ? label : name,
      released: removed,
      ...(isSlot ? {} : { processesTerminated: killed.length }),
    });
    return;
  }
  console.log(
    removed
      ? `released ${clr.bold(isSlot ? `slot ${label}` : name)}`
      : `${isSlot ? `slot ${label}` : name} was not locked`,
  );
  if (killed.length)
    console.log(clr.dim(`  terminated ${killed.length} process(es) backing ${name}`));
}

/**
 * locks: list held resource locks (slot worktree locks show in `sm slot ls`).
 * @param {string[]} argv - CLI arguments for the locks command.
 */
export function cmdLocks(argv = []) {
  const { values } = parseCmd('ls', argv, argOptions('lock-ls'));
  const locks = listResourceLocks();
  if (values.json) {
    emitJson(locks);
    return;
  }
  if (!locks.length) {
    console.log('no resource locks held');
    return;
  }
  const workers = slotWorkerMap();
  for (const lock of locks) {
    const hl = labelFromDir(lock.cwd);
    const holder = hl
      ? `slot ${hl} (${workers.get(hl) === 'live' ? clr.green('live') : clr.red('dead')})`
      : 'unknown';
    console.log(
      `${clr.bold(lock.resource)}  ${holder}  ${clr.dim(agoStr(lock.ts))}${lock.task ? `  ${lock.task}` : ''}`,
    );
  }
}

/**
 * unlock: deterministically remove stale worktree locks (owner session dead). Live locks
 * are kept unless --force. --stale scans all slots; --dry-run previews.
 * @param {string[]} argv - CLI arguments for the unlock command.
 */
export async function cmdUnlock(argv) {
  await loadRoster();
  const { values, positionals } = parseCmd('prune', argv, argOptions('lock-prune'));
  const thresholdSec = (Number.parseInt(values['older-than'], 10) || PRUNE_DEFAULT_MIN) * 60;

  let names;
  if (values.stale)
    names = listSlots();
  else if (positionals.length)
    names = positionals.map(arg => slotRef(arg).name);
  else die('prune: name a slot, or --stale to clear every dead lock (add --dry-run to preview)');

  const results = [];
  const workers = slotWorkerMap();
  for (const name of names) {
    const { label: short, dir, exists } = slotRef(name);
    if (!exists) {
      results.push({ slot: short, action: 'error', reason: 'no worktree' });
      continue;
    }
    const lock = readLock(dir);
    if (!lock) {
      results.push({ slot: short, action: 'not-locked' });
      continue;
    }
    const age = lockTranscriptAge(lock);
    const live = workers.get(short) === 'live';
    const stale = !lockIsLive(lock, live, thresholdSec);
    if (!stale && !values.force) {
      results.push({ slot: short, action: 'kept', reason: 'live', ageSec: age, live });
      continue;
    }
    if (values['dry-run']) {
      results.push({
        slot: short,
        action: 'would-unlock',
        reason: stale ? 'stale' : 'forced',
        ageSec: age,
        live,
      });
      continue;
    }
    try {
      removeLock(dir);
      results.push({
        slot: short,
        action: 'unlocked',
        reason: stale ? 'stale' : 'forced',
        ageSec: age,
        live,
      });
    }
    catch (err) {
      results.push({ slot: short, action: 'error', reason: err.message });
    }
  }

  const failed = results.some(result => result.action === 'error');
  if (values.json) {
    emitJson(results);
    if (failed)
      process.exitCode = 1;
    return;
  }
  for (const result of results) {
    const activity
      = result.ageSec != null
        ? `active ${fmtAge(result.ageSec)} ago`
        : result.live
          ? 'worker live, no transcript'
          : 'worker dead';
    if (result.action === 'not-locked') {
      if (!values.stale)
        console.log(`${result.slot}: not locked`);
    }
    else if (result.action === 'kept') {
      console.log(
        `${result.slot}: ${clr.green('LIVE')} lock (${activity}) - kept${values.stale ? '' : ' (use --force to override)'}`,
      );
    }
    else if (result.action === 'would-unlock') {
      console.log(`${result.slot}: would unlock (${result.reason === 'stale' ? `owner dead, ${activity}` : 'forced'})`);
    }
    else if (result.action === 'unlocked') {
      console.log(
        `${result.slot}: ${clr.green('unlocked')} (${result.reason === 'stale' ? `owner dead, ${activity}` : 'forced'})`,
      );
    }
    else {
      console.error(`${result.slot}: ${result.reason}`);
    }
  }
  if (values.stale && !values['dry-run'])
    console.log(clr.dim(`\n${results.filter(result => result.action === 'unlocked').length} lock(s) removed`));
  if (failed)
    process.exitCode = 1;
}
