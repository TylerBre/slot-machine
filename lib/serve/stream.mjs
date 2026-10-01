// The ONE multiplexed SSE stream: every channel a tab needs rides a single EventSource
// connection (browsers cap ~6 HTTP/1.1 connections per origin; localhost has no HTTP/2).
// LOG channels (inbox, journal) are cursor-resumed deltas with honest `gap` advisories;
// SNAPSHOT channels (floor, watch) conflate to the latest; ka is a real event
// (EventSource cannot see comments or half-open TCP). Id-stamping law: the vector on
// EVERY event is this connection's DELIVERED-THROUGH position per log channel, never
// the file tip - a tip-stamped id under stall would make the next Last-Event-ID skip
// records the client never received. Contracts: README.md and docs/http-api.md.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync, watch } from 'node:fs';
import { MIRROR_PER_TAB, MIRROR_SPOOL_ROTATE_BYTES, SSE_KA_MS, SSE_PENDING_RING } from '../constants.mjs';
import { readInbox, subscribeReports } from '../inbox.mjs';
import { readJournal, subscribeJournal } from '../slots/journal.mjs';
import { parseVerb } from '../slots/verbs.mjs';

const INBOX_TAIL_DEFAULT = 50;
const JOURNAL_TAIL_DEFAULT = 100;
const FLOOR_POLL_MS = 5_000;
const WATCH_POLL_MS = 15_000;
const MIRROR_CHUNK_BYTES = 65_536; // spool read granularity
const MIRROR_QUEUE_MAX = 256; // pending chunks per mirror before a reset sheds them

const KNOWN_CHANNELS = new Set(['meta', 'inbox', 'journal', 'floor', 'watch']);
const MIRROR_CHANNEL = /^mirror:([\w][\w-]*)$/;

/**
 * Parse a vector cursor (`v1;inbox=<ts>;journal=<ts>`) from an SSE id or Last-Event-ID.
 * Unknown/garbled vectors read as empty (tail-N semantics) - never a crash.
 * @param {string|null} raw - the vector string.
 * @returns {{inbox?: number, journal?: number}} the parsed positions.
 */
export function parseVector(raw) {
  const out = {};
  if (typeof raw !== 'string' || !raw.startsWith('v1;'))
    return out;
  for (const part of raw.slice(3).split(';')) {
    const [key, value] = part.split('=');
    if ((key === 'inbox' || key === 'journal') && /^\d+$/.test(value ?? ''))
      out[key] = Number(value);
  }
  return out;
}

const vectorOf = conn => `v1;inbox=${conn.delivered.inbox};journal=${conn.delivered.journal}`;

/**
 * Create the stream hub: owns per-repo pollers (refcounted) and per-connection pumps.
 * @param {object} options - Hub inputs.
 * @param {string} options.spawnTarget - The sm binary snapshot pollers spawn.
 * @param {object} options.repos - Registered repos: name -> absolute repo dir.
 * @param {object} [options.intervals] - Test seams: {floorMs, watchMs, kaMs, mirrorRotateBytes}.
 * @param {object|null} [options.mirror] - The mirror session manager (null = mirrors refused).
 * @returns {object} the hub: {handle, closeAll}.
 */
export function createStreamHub({ spawnTarget, repos, intervals = {}, mirror = null }) {
  const floorMs = intervals.floorMs ?? FLOOR_POLL_MS;
  const watchMs = intervals.watchMs ?? WATCH_POLL_MS;
  const kaMs = intervals.kaMs ?? SSE_KA_MS;
  const mirrorRotateBytes = intervals.mirrorRotateBytes ?? MIRROR_SPOOL_ROTATE_BYTES;
  const connections = new Set();
  // repoName -> { floor: {timer, rev, refs}, watch: {...} } - demand-driven, refcounted
  const pollers = new Map();

  function pollOnce(repoName, kind) {
    const repoDir = repos[repoName];
    const argv = kind === 'floor'
      ? ['--repo', repoDir, 'floor', '--json']
      : ['--repo', repoDir, 'watch', '--check', '--json'];
    const child = spawn(spawnTarget, argv, { env: { ...process.env, NO_COLOR: '1' } });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', () => {
      let snapshot;
      try {
        snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      catch {
        return; // a failed poll updates nothing; the next tick tries again
      }
      const poller = pollers.get(repoName)?.[kind];
      if (!poller)
        return;
      poller.rev += 1;
      for (const conn of connections) {
        if (conn.repoName === repoName && conn.channels.has(kind)) {
          conn.snapshots.set(kind, { rev: poller.rev, snapshot }); // conflation: latest only
          pump(conn);
        }
      }
    });
  }

  function retain(repoName, kind) {
    let entry = pollers.get(repoName);
    if (!entry) {
      entry = {};
      pollers.set(repoName, entry);
    }
    if (!entry[kind]) {
      const ms = kind === 'floor' ? floorMs : watchMs;
      entry[kind] = { rev: 0, refs: 0, timer: setInterval(() => pollOnce(repoName, kind), ms) };
      pollOnce(repoName, kind); // an immediate first snapshot; the interval sustains it
    }
    entry[kind].refs += 1;
  }

  function release(repoName, kind) {
    const poller = pollers.get(repoName)?.[kind];
    if (!poller)
      return;
    poller.refs -= 1;
    if (poller.refs <= 0) {
      clearInterval(poller.timer);
      delete pollers.get(repoName)[kind];
    }
  }

  function writeEvent(conn, { channel, data, id = vectorOf(conn) }) {
    return conn.res.write(`event: ${channel}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // The serialized per-connection writer. Order: inbox ring, then journal (the file is
  // the buffer), then snapshots (latest each), then advisories/ka. Backpressure: a false
  // write pauses the pump until 'drain'.
  async function pump(conn) {
    if (conn.pumping || conn.closed)
      return;
    conn.pumping = true;
    try {
      for (;;) {
        if (conn.closed)
          return;
        let wrote;
        if (conn.advisories.length) {
          const advisory = conn.advisories.shift();
          wrote = writeEvent(conn, advisory);
        }
        else if (conn.inboxRing.length) {
          const record = conn.inboxRing.shift();
          conn.delivered.inbox = record.ts;
          wrote = writeEvent(conn, {
            channel: 'inbox',
            data: { channel: 'inbox', record, verb: parseVerb(record.message) },
          });
        }
        else if (conn.journalDirty) {
          const next = readJournal(conn.repoName, { sinceTs: conn.delivered.journal + 1 })[0];
          if (!next) {
            conn.journalDirty = false;
            continue;
          }
          conn.delivered.journal = next.ts;
          wrote = writeEvent(conn, { channel: 'journal', data: { channel: 'journal', record: next } });
        }
        else if (conn.snapshots.size) {
          const [channel, payload] = conn.snapshots.entries().next().value;
          conn.snapshots.delete(channel);
          wrote = writeEvent(conn, { channel, data: { channel, rev: payload.rev, snapshot: payload.snapshot } });
        }
        else if (nextMirrorEvent(conn)) {
          const { channel, data } = nextMirrorEvent(conn, true);
          wrote = writeEvent(conn, { channel, data });
        }
        else if (conn.kaPending) {
          conn.kaPending = false;
          wrote = writeEvent(conn, { channel: 'ka', data: { ts: Date.now() } });
        }
        else {
          return;
        }
        if (!wrote && !conn.closed)
          await new Promise(resolvePromise => conn.res.once('drain', resolvePromise));
      }
    }
    finally {
      conn.pumping = false;
    }
  }

  // The next queued mirror event across this connection's mirrors, FIFO per mirror.
  // peek by default; `take` dequeues.
  function nextMirrorEvent(conn, take = false) {
    for (const [slot, state] of conn.mirrors ?? []) {
      if (state.queue.length) {
        const event = take ? state.queue.shift() : state.queue[0];
        return { channel: `mirror:${slot}`, data: event };
      }
    }
    return null;
  }

  // Read newly-appended spool bytes into the mirror's queue (base64 chunks). Truncation
  // underneath (a rotate) resets the offset; queue overflow sheds everything for a
  // `reset` - stale terminal bytes are worse than a redraw.
  function pullSpool(conn, slot, state) {
    let size;
    try {
      size = statSync(state.sink).size;
    }
    catch {
      return; // sink momentarily absent (rotate window)
    }
    if (size < state.offset) {
      // truncated underneath (a rotate landed): rewinding silently would replay bytes
      // into an uncleared terminal, so a reset ALWAYS precedes re-reads from 0.
      state.offset = 0;
      if (state.queue.at(-1)?.t !== 'reset')
        state.queue.push({ channel: `mirror:${slot}`, t: 'reset' });
    }
    if (size > mirrorRotateBytes) {
      // fire-and-forget; ifOverBytes makes co-viewer double-triggers no-ops, and the
      // manager announces `rotated` to every viewer when it happens
      mirror.rotate(conn.repoName, slot, { ifOverBytes: mirrorRotateBytes }).catch(() => {});
      pump(conn);
      return;
    }
    const fd = openSync(state.sink, 'r');
    try {
      while (state.offset < size) {
        const want = Math.min(MIRROR_CHUNK_BYTES, size - state.offset);
        const buffer = Buffer.alloc(want);
        const got = readSync(fd, buffer, 0, want, state.offset);
        if (got <= 0)
          break;
        state.offset += got;
        state.queue.push({ channel: `mirror:${slot}`, t: 'data', b64: buffer.subarray(0, got).toString('base64') });
        if (state.queue.length > MIRROR_QUEUE_MAX) {
          // shed to a reset, skip the backlog, and ask for a fresh screen so the reset
          // is always followed by a full frame (stale terminal bytes are worse)
          state.queue.length = 0;
          state.queue.push({ channel: `mirror:${slot}`, t: 'reset' });
          state.offset = size;
          mirror.reseed(conn.repoName, slot).catch(() => {});
          break;
        }
      }
    }
    finally {
      closeSync(fd);
    }
    pump(conn);
  }

  // Open one mirror channel for a connection: budget, manager open, spool tail, events.
  async function attachMirror(conn, slot) {
    const channel = `mirror:${slot}`;
    const queueClosed = (reason) => {
      conn.advisories.push({ channel, data: { channel, t: 'closed', reason } });
      pump(conn);
    };
    if (!mirror)
      return queueClosed('unsupported');
    if ((conn.mirrors?.size ?? 0) >= MIRROR_PER_TAB)
      return queueClosed('budget');
    const state = { queue: [], offset: 0, sink: null, watcher: null, opened: false, epoch: null };
    conn.mirrors.set(slot, state);
    let info;
    try {
      info = await mirror.openMirror(conn.repoName, repos[conn.repoName], slot);
    }
    catch (err) {
      conn.mirrors.delete(slot);
      return queueClosed(err.reason ?? 'open-failed');
    }
    if (conn.closed) {
      mirror.closeMirror(conn.repoName, slot, info.epoch);
      return;
    }
    state.sink = info.sink;
    state.opened = true;
    state.epoch = info.epoch;
    state.queue.push({ channel, t: 'open', cols: info.cols, rows: info.rows, mode: info.mode });
    // Epoch-checked: events for a successor session of the same slot are not ours.
    const onLost = ({ repo, slot: lostSlot, epoch }) => {
      if (repo === conn.repoName && lostSlot === slot && epoch === state.epoch) {
        state.opened = false; // the session is gone; never debit a successor at cleanup
        state.queue.push({ channel, t: 'closed', reason: 'pipe-lost' });
        pump(conn);
      }
    };
    const onRotated = ({ repo, slot: rotatedSlot, epoch }) => {
      if (repo === conn.repoName && rotatedSlot === slot && epoch === state.epoch) {
        state.offset = 0;
        state.queue.length = 0;
        state.queue.push({ channel, t: 'reset' });
        pullSpool(conn, slot, state); // the reseeded screen follows the reset
      }
    };
    mirror.events.on('pipe-lost', onLost);
    mirror.events.on('rotated', onRotated);
    try {
      state.watcher = watch(info.sink, () => pullSpool(conn, slot, state));
    }
    catch { /* sink vanished instantly: pipe-lost will surface it */ }
    conn.cleanups.push(() => {
      mirror.events.off('pipe-lost', onLost);
      mirror.events.off('rotated', onRotated);
      state.watcher?.close();
      if (state.opened)
        mirror.closeMirror(conn.repoName, slot, state.epoch);
    });
    pullSpool(conn, slot, state); // whatever landed before the watcher armed
    pump(conn);
  }

  // Pull new inbox records into the ring. The ring is bounded: overflow drops oldest and
  // the drop is SURFACED as a gap advisory, never silent.
  function pullInbox(conn) {
    const newestSeen = conn.inboxRing.length ? conn.inboxRing[conn.inboxRing.length - 1].ts : conn.delivered.inbox;
    const fresh = readInbox(conn.repoName, { sinceTs: newestSeen });
    if (!fresh.length)
      return;
    conn.inboxRing.push(...fresh);
    while (conn.inboxRing.length > SSE_PENDING_RING) {
      const dropped = conn.inboxRing.shift();
      conn.gapFrom = conn.gapFrom ?? dropped.ts;
    }
    if (conn.gapFrom != null) {
      conn.advisories.push({
        channel: 'gap',
        data: { channel: 'inbox', from: conn.gapFrom, to: conn.inboxRing[0]?.ts ?? null },
      });
      conn.delivered.inbox = Math.max(conn.delivered.inbox, conn.gapFrom);
      conn.gapFrom = null;
    }
  }

  /**
   * Mount one SSE connection. The caller (http.mjs) has already authenticated and
   * resolved the repo name against the registry.
   * @param {import('node:http').IncomingMessage} req - the request (for Last-Event-ID + close).
   * @param {import('node:http').ServerResponse} res - the response socket.
   * @param {string} repoName - a REGISTERED repo name.
   * @param {URL} url - the parsed request url (channels + cursor params).
   */
  function handle(req, res, repoName, url) {
    const requestedRaw = String(url.searchParams.get('channels') ?? 'meta,inbox,journal,floor,watch')
      .split(',')
      .map(channel => channel.trim());
    const channels = new Set(requestedRaw.filter(channel => KNOWN_CHANNELS.has(channel)));
    // Deduped: channels=mirror:a,mirror:a must be ONE viewer, not a deterministic
    // same-key admission race.
    const mirrorSlots = [...new Set(requestedRaw
      .map(channel => MIRROR_CHANNEL.exec(channel)?.[1])
      .filter(Boolean))];

    // Last-Event-ID (native reconnect) outranks query cursors (the original connect).
    const header = parseVector(req.headers['last-event-id']);
    const query = {
      inbox: /^\d+$/.test(url.searchParams.get('inbox') ?? '') ? Number(url.searchParams.get('inbox')) : undefined,
      journal: /^\d+$/.test(url.searchParams.get('journal') ?? '') ? Number(url.searchParams.get('journal')) : undefined,
    };
    const wantInbox = header.inbox ?? query.inbox;
    const wantJournal = header.journal ?? query.journal;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });

    const conn = {
      res,
      repoName,
      channels,
      delivered: { inbox: 0, journal: 0 },
      inboxRing: [],
      journalDirty: false,
      snapshots: new Map(),
      advisories: [],
      kaPending: false,
      gapFrom: null,
      pumping: false,
      closed: false,
      cleanups: [],
      mirrors: new Map(),
    };

    // --- resume semantics per log channel ---
    if (channels.has('inbox')) {
      const all = readInbox(repoName);
      const tip = all.length ? all[all.length - 1].ts : 0;
      if (wantInbox == null) {
        // tail-N default: the last N replay, and the vector is exact from the first event
        const tail = all.slice(-INBOX_TAIL_DEFAULT);
        conn.delivered.inbox = tail.length ? tail[0].ts - 1 : tip;
        conn.inboxRing.push(...tail);
      }
      else if (wantInbox > tip) {
        conn.delivered.inbox = tip; // future cursor: clamp + say so
        conn.advisories.push({ channel: 'cursor-reset', data: { channel: 'inbox', clampedTo: tip } });
      }
      else {
        conn.delivered.inbox = wantInbox;
        const oldest = all[0]?.ts ?? null;
        if (wantInbox > 0 && oldest != null && oldest > wantInbox) {
          // the resume point precedes every SURVIVING record: consumption may have eaten
          // records we can no longer replay - advisory, never silence
          conn.advisories.push({ channel: 'gap', data: { channel: 'inbox', from: wantInbox, to: oldest } });
        }
        conn.inboxRing.push(...all.filter(record => record.ts > wantInbox));
      }
      conn.cleanups.push(subscribeReports(repoName, () => {
        pullInbox(conn);
        pump(conn);
      }));
    }
    if (channels.has('journal')) {
      if (wantJournal == null) {
        const tail = readJournal(repoName, { tail: JOURNAL_TAIL_DEFAULT });
        conn.delivered.journal = tail.length ? tail[0].ts - 1 : 0;
      }
      else {
        conn.delivered.journal = wantJournal;
      }
      conn.journalDirty = true;
      conn.cleanups.push(subscribeJournal(repoName, () => {
        conn.journalDirty = true;
        pump(conn);
      }));
    }
    if (channels.has('meta'))
      conn.snapshots.set('meta', { rev: 0, snapshot: { note: 'meta rides GET /api/v1/meta; emitted here on connect for convenience' } });
    for (const kind of ['floor', 'watch']) {
      if (channels.has(kind)) {
        retain(repoName, kind);
        conn.cleanups.push(() => release(repoName, kind));
      }
    }

    for (const slot of mirrorSlots)
      attachMirror(conn, slot); // async: open/closed events queue as they resolve

    const kaTimer = setInterval(() => {
      conn.kaPending = true;
      pump(conn);
    }, kaMs);
    conn.cleanups.push(() => clearInterval(kaTimer));

    const close = () => {
      if (conn.closed)
        return;
      conn.closed = true;
      for (const cleanup of conn.cleanups) cleanup();
      connections.delete(conn);
      try {
        res.end();
      }
      catch { /* socket already gone */ }
    };
    req.on('close', close);
    conn.close = close;

    connections.add(conn);
    pump(conn);
  }

  function closeAll(reason = 'serve-shutdown') {
    for (const conn of [...connections]) {
      try {
        writeEvent(conn, { channel: 'serve-shutdown', data: { reason } });
      }
      catch { /* best effort */ }
      conn.close();
    }
    for (const [, entry] of pollers) {
      for (const kind of Object.keys(entry)) {
        clearInterval(entry[kind].timer);
        delete entry[kind];
      }
    }
  }

  return { handle, closeAll };
}
