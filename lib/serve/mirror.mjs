// The mirror session manager: the ONE stateful streaming resource in sm serve.
// Lifecycle: registry-written-before-pipe (rollback on failure), refcounted viewers
// with a linger, a startup/shutdown sweep, and a worker thread for every mux-touching
// call so the HTTP loop never blocks. Concurrency laws: README.md.
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  MIRROR_LINGER_MS,
  MIRROR_PIPES_MAX,
  MIRROR_POLL_DUMP_MS,
  MIRROR_SPOOL_CAP_BYTES,
  MIRROR_STATUS_POLL_MS,
} from '../constants.mjs';
import { loadSchema, validate } from '../schema.mjs';
import { ownPidStart, pidIdentityLive } from '../slots/locks.mjs';
import { serveStateDir } from './auth.mjs';

const REGISTRY_SCHEMA = loadSchema('mirror-registry.schema.json');

const registryPath = () => join(serveStateDir(), 'mirror-registry.json');
const spoolDir = () => join(serveStateDir(), 'spools');
const keyOf = (repo, slot) => `${repo}\u001F${slot}`; // unit separator, escaped - a control byte in source reads as binary to git
// Spool filenames must satisfy the mux sink charset; unsafe repo/slot bytes are mapped
// with a short stable hash suffix so distinct names cannot collide after sanitizing.
function spoolName(repo, slot) {
  const raw = `${repo}.${slot}`;
  const safe = raw.replace(/[^\w.-]/g, '_');
  if (safe === raw)
    return `${raw}.spool`;
  let hash = 0;
  for (const ch of raw) hash = ((hash * 31) + ch.codePointAt(0)) >>> 0;
  return `${safe}.${hash.toString(16)}.spool`;
}

function readRegistry() {
  try {
    const doc = JSON.parse(readFileSync(registryPath(), 'utf8'));
    const problems = validate(doc, REGISTRY_SCHEMA);
    if (problems.length) {
      // Loud, not silent: substituting empty forgets tracked pipes; the sweep can only
      // reconcile what it can read.
      console.error(`sm serve: mirror registry failed validation (${problems[0]}); starting empty`);
      return { v: 1, sessions: [] };
    }
    return doc;
  }
  catch {
    return { v: 1, sessions: [] };
  }
}

// Atomic tmp+rename, NO cross-process mutex: the serve pidfile guarantees one instance,
// so the registry has one writer by construction; the sweep reconciles crash residue.
function writeRegistry(doc) {
  const problems = validate(doc, REGISTRY_SCHEMA);
  if (problems.length)
    throw new Error(`refusing to write invalid mirror registry: ${problems.join('; ')}`);
  mkdirSync(serveStateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${registryPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, registryPath());
}

/**
 * A refusal with a wire-visible reason ('server-cap' | 'slot-gone' | 'backend-lost' |
 * ...); the stream layer forwards it as a `closed {reason}` event.
 */
export class MirrorRefusal extends Error {
  constructor(reason, detail = null) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

/**
 * Create the mirror manager.
 * @param {object} [options] - Manager inputs (test seams for every cadence and cap).
 * @param {URL|string} [options.workerUrl] - The worker module (tests inject a fake).
 * @param {number} [options.pipesMax] - Server-wide session cap.
 * @param {number} [options.lingerMs] - Keep-warm window after the last viewer leaves.
 * @param {number} [options.statusPollMs] - pipe-lost detection cadence.
 * @param {number} [options.pollDumpMs] - Poll-fallback capture cadence.
 * @returns {object} {events, openMirror, closeMirror, rotate, reseed, sweep, shutdown, sessionCount}.
 */
export function createMirrorManager({
  workerUrl = new URL('./mirror-worker.mjs', import.meta.url),
  pipesMax = MIRROR_PIPES_MAX,
  lingerMs = MIRROR_LINGER_MS,
  statusPollMs = MIRROR_STATUS_POLL_MS,
  pollDumpMs = MIRROR_POLL_DUMP_MS,
} = {}) {
  const events = new EventEmitter();
  const sessions = new Map(); // key -> live session
  const opening = new Map(); // key -> in-flight open promise (admission serialization)
  let epochCounter = 0;
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function failAllPending(reason) {
    for (const [, waiter] of pending) waiter({ ok: false, err: reason });
    pending.clear();
  }

  function ensureWorker() {
    if (worker)
      return worker;
    worker = new Worker(workerUrl);
    worker.unref(); // the worker must never hold the process open by itself
    worker.on('message', (reply) => {
      const waiter = pending.get(reply.id);
      if (waiter) {
        pending.delete(reply.id);
        waiter(reply);
      }
    });
    // A crashed worker is a refusal, not a process death: reject everything in flight
    // and let the next ask respawn a fresh worker.
    worker.on('error', () => {
      failAllPending('backend-lost');
      worker = null;
    });
    worker.on('exit', () => {
      failAllPending('backend-lost');
      worker = null;
    });
    return worker;
  }

  function ask(op, args = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++;
      pending.set(id, reply => (reply.ok ? resolvePromise(reply.value) : rejectPromise(new Error(reply.err))));
      ensureWorker().postMessage({ id, op, ...args });
    });
  }

  function registryRemove(repo, slot) {
    const doc = readRegistry();
    doc.sessions = doc.sessions.filter(entry => !(entry.repo === repo && entry.slot === slot));
    writeRegistry(doc);
  }

  // Serialize per-session mutations (rotate, status tick, teardown) so none observes
  // another's intermediate state (e.g. rotate's stopped-pipe window read as pipe loss).
  // The chain never rejects (errors are absorbed per-op).
  function runOnChain(session, fn) {
    session.chain = session.chain.then(fn, fn);
    return session.chain;
  }

  const sessionInfo = session => ({
    sink: session.sink,
    cols: session.cols,
    rows: session.rows,
    mode: session.mode,
    epoch: session.epoch,
  });

  async function teardown(key, { unlink = true } = {}) {
    const session = sessions.get(key);
    if (!session)
      return;
    sessions.delete(key);
    clearTimeout(session.lingerTimer);
    clearInterval(session.statusTimer);
    try {
      await ask(session.mode === 'pipe' ? 'pipeStop' : 'pollStop', { paneId: session.paneId });
    }
    catch { /* backend gone: the sweep story covers residue */ }
    registryRemove(session.repo, session.slot);
    if (unlink)
      rmSync(session.sink, { force: true });
    events.emit('ended', { repo: session.repo, slot: session.slot, epoch: session.epoch });
  }

  async function doOpen(key, repo, repoDir, slot) {
    let resolved;
    try {
      resolved = await ask('resolve', { repoDir, slot });
    }
    catch (err) {
      throw new MirrorRefusal(err.message === 'slot-gone' ? 'slot-gone' : err.message === 'backend-lost' ? 'backend-lost' : 'resolve-failed', err.message);
    }
    const mode = resolved.streamSupported ? 'pipe' : 'poll';
    mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    const sink = join(spoolDir(), spoolName(repo, slot));
    writeFileSync(sink, '', { mode: 0o600 }); // pre-created, truncated, secret-at-rest
    chmodSync(sink, 0o600);

    // REGISTRY BEFORE PIPE: a crash between the two leaves a findable entry (the sweep
    // stops the pipe); the reverse order would leak an unfindable pipe forever.
    const doc = readRegistry();
    doc.sessions.push({
      repo,
      slot,
      paneId: resolved.paneId,
      sink,
      pid: process.pid,
      pidStart: ownPidStart(),
      openedAt: Date.now(),
      mode,
    });
    writeRegistry(doc);
    try {
      if (mode === 'pipe') {
        await ask('pipeStart', { paneId: resolved.paneId, sink, byteCap: MIRROR_SPOOL_CAP_BYTES });
        await ask('seed', { paneId: resolved.paneId, sink }); // current screen first, then forward bytes
      }
      else {
        await ask('pollStart', { paneId: resolved.paneId, sink, ms: pollDumpMs });
      }
    }
    catch (err) {
      registryRemove(repo, slot); // rollback: the pipe never started
      rmSync(sink, { force: true });
      throw new MirrorRefusal('pipe-failed', err.message);
    }

    const session = {
      repo,
      slot,
      epoch: ++epochCounter,
      refs: 1,
      paneId: resolved.paneId,
      sink,
      mode,
      cols: resolved.cols,
      rows: resolved.rows,
      lingerTimer: null,
      statusTimer: null,
      chain: Promise.resolve(),
    };
    if (mode === 'pipe') {
      const epoch = session.epoch;
      session.statusTimer = setInterval(() => runOnChain(session, async () => {
        // Epoch guard: a tick that straddled a teardown/reopen must not judge (or tear
        // down) whatever session now holds this key.
        if (sessions.get(key)?.epoch !== epoch)
          return;
        try {
          const status = await ask('status', { paneId: session.paneId });
          if (!status.piped && sessions.get(key)?.epoch === epoch) {
            events.emit('pipe-lost', { repo, slot, epoch });
            await teardown(key);
          }
        }
        catch { /* backend unreachable: cannot tell, do not tear down on doubt */ }
      }), statusPollMs);
      session.statusTimer.unref?.();
    }
    sessions.set(key, session);
    return sessionInfo(session);
  }

  /**
   * Open (or join) the mirror for a slot. Admission is serialized per key: concurrent
   * openers of the same slot join one session (refs each), never race it.
   * @param {string} repo - Registered repo name.
   * @param {string} repoDir - The repo's absolute dir (for pane resolution).
   * @param {string} slot - Slot label.
   * @returns {Promise<{sink: string, cols: number, rows: number, mode: string, epoch: number}>} session info.
   */
  async function openMirror(repo, repoDir, slot) {
    const key = keyOf(repo, slot);
    const existing = sessions.get(key);
    if (existing) {
      existing.refs += 1;
      clearTimeout(existing.lingerTimer);
      existing.lingerTimer = null;
      return sessionInfo(existing);
    }
    const inflight = opening.get(key);
    if (inflight) {
      await inflight.catch(() => {}); // the opener reports its own failure
      const joined = sessions.get(key);
      if (!joined)
        throw new MirrorRefusal('open-failed', 'the concurrent open this viewer joined failed');
      joined.refs += 1;
      return sessionInfo(joined);
    }
    // The cap reserves SYNCHRONOUSLY (live + in-flight), so concurrent opens cannot
    // stampede past it between here and the session landing in the map.
    if (sessions.size + opening.size >= pipesMax)
      throw new MirrorRefusal('server-cap', `mirror cap (${pipesMax}) reached`);
    const promise = doOpen(key, repo, repoDir, slot).finally(() => opening.delete(key));
    opening.set(key, promise);
    return promise;
  }

  /**
   * A viewer left. Epoch-checked: a viewer of a dead session can never debit its
   * successor. At zero viewers the session lingers, then tears down.
   * @param {string} repo - Registered repo name.
   * @param {string} slot - Slot label.
   * @param {number} epoch - The epoch openMirror handed this viewer.
   */
  function closeMirror(repo, slot, epoch) {
    const key = keyOf(repo, slot);
    const session = sessions.get(key);
    if (!session || session.epoch !== epoch)
      return;
    session.refs -= 1;
    if (session.refs > 0)
      return;
    session.lingerTimer = setTimeout(() => runOnChain(session, () => {
      if (sessions.get(key)?.epoch === epoch && session.refs <= 0)
        return teardown(key);
    }), lingerMs);
    session.lingerTimer.unref?.();
  }

  /**
   * Re-append the current screen to the spool (pipe mode) - after a rotate or a
   * backpressure shed, so `reset` is always followed by a fresh full frame.
   * @param {string} repo - Registered repo name.
   * @param {string} slot - Slot label.
   */
  async function reseed(repo, slot) {
    const session = sessions.get(keyOf(repo, slot));
    if (!session || session.mode !== 'pipe')
      return;
    try {
      await ask('seed', { paneId: session.paneId, sink: session.sink });
    }
    catch { /* forward bytes still flow */ }
  }

  /**
   * Rotate-by-restart, serialized on the session chain and epoch-guarded: stop, truncate,
   * restart, reseed, then announce `rotated` so EVERY viewer resets and re-reads from 0.
   * `ifOverBytes` makes co-viewer double-triggers no-ops (the second sees a small spool).
   * @param {string} repo - Registered repo name.
   * @param {string} slot - Slot label.
   * @param {object} [options] - Options.
   * @param {number} [options.ifOverBytes] - Only rotate when the spool is at/over this.
   */
  async function rotate(repo, slot, { ifOverBytes = 0 } = {}) {
    const key = keyOf(repo, slot);
    const session = sessions.get(key);
    if (!session)
      return;
    const epoch = session.epoch;
    await runOnChain(session, async () => {
      if (sessions.get(key)?.epoch !== epoch)
        return;
      try {
        if (ifOverBytes && statSync(session.sink).size < ifOverBytes)
          return; // a co-viewer already rotated
      }
      catch {
        return;
      }
      try {
        if (session.mode === 'pipe')
          await ask('pipeStop', { paneId: session.paneId });
        writeFileSync(session.sink, '', { mode: 0o600 });
        if (session.mode === 'pipe') {
          await ask('pipeStart', { paneId: session.paneId, sink: session.sink, byteCap: MIRROR_SPOOL_CAP_BYTES });
          await ask('seed', { paneId: session.paneId, sink: session.sink });
        }
        events.emit('rotated', { repo, slot, epoch });
      }
      catch { /* a failed rotate leaves the status poll to judge the pipe honestly */ }
    });
  }

  /**
   * Reconcile the durable registry against reality: entries whose holder fails
   * pid-identity (dead pid, or a recycled pid with a different start time) get their
   * pipe stopped best-effort, entry removed, spool unlinked. Entries held by our own
   * pid but absent from the live session map are pre-crash relics - swept the same way.
   * A live FOREIGN holder is left alone (fail toward alive). Documented residual: the
   * best-effort pipeStop may stop a pipe a human re-attached manually post-crash.
   */
  async function sweep() {
    const doc = readRegistry();
    const keep = [];
    for (const entry of doc.sessions) {
      const ours = entry.pid === process.pid;
      const live = !ours && pidIdentityLive({ pid: entry.pid, pidStart: entry.pidStart ?? null });
      const inMap = ours && sessions.has(keyOf(entry.repo, entry.slot));
      if (inMap || live) {
        keep.push(entry);
        continue;
      }
      try {
        await ask('pipeStop', { paneId: entry.paneId });
      }
      catch { /* backend gone; nothing to stop */ }
      rmSync(entry.sink, { force: true });
    }
    if (keep.length !== doc.sessions.length)
      writeRegistry({ v: 1, sessions: keep });
  }

  /** Shutdown: tear every live session down immediately (no linger), then the worker. */
  async function shutdown() {
    for (const key of [...sessions.keys()]) await teardown(key);
    if (worker) {
      const dying = worker;
      worker = null; // no respawn during termination
      await dying.terminate();
    }
    failAllPending('backend-lost');
  }

  return { events, openMirror, closeMirror, rotate, reseed, sweep, shutdown, sessionCount: () => sessions.size };
}
