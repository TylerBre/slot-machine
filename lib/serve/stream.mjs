// The ONE multiplexed SSE stream: every channel a tab needs rides a single EventSource
// connection (browsers cap ~6 HTTP/1.1 connections per origin and localhost has no
// HTTP/2 - the budget is spent deliberately).
//
// Three consistency contracts, kept separate on purpose:
// - LOG channels (inbox, journal): deltas resumed by durable ts cursor. The journal file
//   is its own buffer (append-only, rotation-spanning reads); the inbox file can be
//   CONSUMED underneath us (msg inbox --clear), so a bounded per-connection pending ring
//   buffers stalls and honest `gap` advisories surface what could not be replayed.
// - SNAPSHOT channels (floor, watch): complete replacements, conflated under stall to
//   the latest only - the client never merges deltas into world state.
// - ka: a real event (EventSource cannot see comments or half-open TCP; the client's
//   watchdog needs an observable heartbeat).
//
// The id-stamping law: the vector on EVERY event equals this connection's
// DELIVERED-THROUGH position per log channel - never the file tip. A snapshot stamped
// with the tip while the inbox is stalled would make the next Last-Event-ID skip records
// the client never received.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { SSE_KA_MS, SSE_PENDING_RING } from '../constants.mjs';
import { readInbox, subscribeReports } from '../inbox.mjs';
import { readJournal, subscribeJournal } from '../slots/journal.mjs';
import { parseVerb } from '../slots/verbs.mjs';

const INBOX_TAIL_DEFAULT = 50;
const JOURNAL_TAIL_DEFAULT = 100;
const FLOOR_POLL_MS = 5_000;
const WATCH_POLL_MS = 15_000;

const KNOWN_CHANNELS = new Set(['meta', 'inbox', 'journal', 'floor', 'watch']);

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
 * @param {object} [options.intervals] - Test seams: {floorMs, watchMs, kaMs}.
 * @returns {object} the hub: {handle, closeAll}.
 */
export function createStreamHub({ spawnTarget, repos, intervals = {} }) {
  const floorMs = intervals.floorMs ?? FLOOR_POLL_MS;
  const watchMs = intervals.watchMs ?? WATCH_POLL_MS;
  const kaMs = intervals.kaMs ?? SSE_KA_MS;
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
    const requested = String(url.searchParams.get('channels') ?? 'meta,inbox,journal,floor,watch')
      .split(',')
      .map(channel => channel.trim())
      .filter(channel => KNOWN_CHANNELS.has(channel));
    const channels = new Set(requested);

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
