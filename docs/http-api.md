# The sm serve wire contract (v1)

The HTTP+SSE surface `sm serve` exposes on `127.0.0.1` for the dispatcher cockpit
(sm-cockpit) and local scripting. This document is the contract clients build against;
sm-cockpit's CI snapshots it. Semantic changes bump the envelope/stream version fields,
never silently.

## Surface

```
POST /api/v1/session                       pairing-token -> HttpOnly session cookie
GET  /api/v1/meta                          versions, skew, repos, token age
GET  /api/v1/commands                      the exposed-command catalog
POST /api/v1/commands/:tool                invoke a command
GET  /api/v1/repos/:repo/stream            THE multiplexed SSE stream (one per tab)
GET  /api/v1/healthz                       unauthenticated liveness
GET  /*                                    static hosting of a built cockpit (--ui)
```

There are deliberately no per-command GET routes: every read that has a CLI command goes
through the one generic POST, exactly like MCP - the HTTP surface derives from the same
`schema/commands/*.json` argspec as the CLI and MCP, so it cannot drift by hand.

## Auth

- **Pairing:** `sm serve` prints `http://127.0.0.1:<port>/#token=<hex>` once. The client
  reads the fragment, POSTs `{"token": "<hex>"}` (JSON) to `/api/v1/session`, and drops
  the fragment from history. The fragment never reaches a server or a log, but it DOES
  land in browser history - rotate with `sm serve --rotate-token` when in doubt.
- **Session:** the response sets `sm_session` - HttpOnly, SameSite=Strict, 30-day. The
  cookie value is `exp.HMAC-SHA256(token, exp)`: stateless, so sessions survive serve
  restarts. **After pairing, no credential exists anywhere client JavaScript can read** -
  the raw token MUST NOT be stored (localStorage, memory beyond the exchange, anywhere).
- **Scripting:** `Authorization: Bearer <token>` is accepted everywhere a cookie is.
- **CSRF:** command POSTs require same-origin proof. An explicit cross-site
  `Sec-Fetch-Site` always refuses; absent it, cookie-authed requests must carry an
  allowlisted `Origin`; bearer-authed requests pass (a browser cannot forge an
  Authorization header cross-site).
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` - anything else is
  `421` before routing (DNS-rebinding defense). No CORS headers are ever emitted; there
  is no cross-origin mode. Dev mode is a same-origin proxy (see sm-cockpit).

## Commands

`POST /api/v1/commands/:tool` with body `{"repo": "<registered repo NAME>", "args": {...}}`.

- `:tool` is a catalog `tool` name (`floor`, `msg-send`, `worker-run`, ...). The catalog
  (`GET /api/v1/commands`) carries each tool's `inputSchema` (webHidden args are simply
  absent) and its named `outcomes`.
- `repo` must be a registered repo NAME, matched exactly - never a path. Unknown: `404`.
- Every response that reached the command is HTTP `200` with the envelope:

```json
{ "v": 1, "ok": true, "outcome": "ok", "data": { ... } }
{ "v": 1, "ok": true, "outcome": "nothing-to-report", "data": { ... } }
{ "v": 1, "ok": false, "outcome": "error", "error": "<stderr text>" }
```

  `outcome` names come from the command spec's exit-code map (e.g. `watch` exit 3 =
  `nothing-to-report`, still `ok: true` - a defined result, not a failure). Command
  failure is an envelope fact; HTTP status stays 200. **The envelope applies to command
  responses only** - meta/catalog return plain JSON.
- HTTP statuses are fixed policy: `400` args fail the schema, `401` no session, `403`
  unexposed tool or missing same-origin proof, `404` unknown tool/repo/route, `405`
  wrong method, `413` body over 256 KB, `415` not application/json, `421` bad Host,
  `429` a pool is full (`{"pool": "interactive"|"blocking"}` - retry shortly), `503`
  mutating tool while serve/binary versions are skewed (restart serve), `504` command
  exceeded the 15-minute ceiling.
- Concurrency: reads and quick mutations share an 8-slot pool; `msg-send` with
  `untilIdle: true` rides a separate 2-slot blocking pool. `worker-run` is serialized
  per repo (concurrent dispatches queue, they never race).

## The stream

`GET /api/v1/repos/:repo/stream?channels=meta,inbox,journal,floor,watch&inbox=<ts>&journal=<ts>`

**One EventSource per tab, total.** Browsers cap ~6 HTTP/1.1 connections per origin
across all tabs and localhost has no HTTP/2; everything multiplexes onto this one
connection. Command POSTs are short-lived; nothing else may hold a connection.

Channels and event shapes (`data:` is always one JSON object):

| event | data | contract |
|---|---|---|
| `inbox` | `{channel, record: {v, ts, slot, message}, verb}` | log channel: deltas, ts-cursor resumable; `verb` is parsed serve-side |
| `journal` | `{channel, record}` | log channel: deltas, ts-cursor resumable |
| `floor` | `{channel, rev, snapshot}` | COMPLETE replacement snapshot (the exact `sm floor --json` shape); `rev` increments monotonically per serve run; never merge - replace |
| `watch` | `{channel, rev, snapshot}` | complete digest snapshot (the exact `sm watch --check --json` shape) |
| `meta` | `{...}` | emitted on connect; the full document rides `GET /api/v1/meta` |
| `ka` | `{ts}` | heartbeat every 15s - a REAL event (see watchdog) |
| `gap` | `{channel: "inbox", from, to}` | records in (from, to) could not be replayed (consumed underneath, or a stalled connection overflowed its buffer) - the loss is surfaced, never silent |
| `cursor-reset` | `{channel, clampedTo}` | the presented cursor was ahead of the log; it was clamped |
| `serve-shutdown` | `{reason}` | serve is going down deliberately; reconnect with your cursor |

**Cursors and resume:**

- Every event's SSE `id:` is the vector `v1;inbox=<ts>;journal=<ts>` - this connection's
  **delivered-through** position per log channel, never the file tip. EventSource returns
  it as `Last-Event-ID` on native reconnect; serve resumes exactly. Reconnecting after a
  serve restart and after a network blip are the same path - the cursor is durable state.
- Explicit cursors ride the query (`inbox=<ts>`, `journal=<ts>`); `Last-Event-ID`
  outranks them when both are present.
- No cursor: log channels replay a tail (inbox 50, journal 100) and the vector is exact
  from the first frame.
- Clients MUST persist the cursor vector per repo in **sessionStorage (per-tab, never
  shared localStorage)** - two tabs sharing a cursor would skip each other's deliveries.
- Clients MUST dedup log events by ts + full-record equality: duplicates are possible
  (at-least-once around reconnects and rotation re-appends) and are always benign.
- Changing the channel set (opening a mirror, toggling a channel) is a reconnect with a
  new `channels=` list; log channels resume via the vector, snapshots re-snapshot.

**The ka watchdog (client MUST):** EventSource cannot observe half-open TCP. If no `ka`
event arrives within 2 intervals (30s), the client MUST `close()` and reopen with its
persisted vector. A `:ka` comment line may also appear; nothing depends on it.

**Inbox loss honesty:** the inbox file can be consumed by other surfaces (`sm msg inbox
--clear` on the tmux desk). Serve replays what survives and emits `gap` for what cannot
be replayed. Sub-millisecond edge, documented: a clear followed by an append in the same
millisecond re-stamps an equal ts and is indistinguishable from the consumed record.

## Rendering rules (client MUSTs)

- Worker-authored strings (inbox messages, journal text, task names) render as **text
  nodes only** - no innerHTML, no markdown-to-HTML, anywhere. These bytes come from
  autonomous, prompt-injectable agents.
- Terminal bytes (the pane mirror, when it ships) go only into xterm.js.
- The static UI is served under `Content-Security-Policy: default-src 'self'`; builds
  must not require inline script/eval.

## Mirror channels (reserved)

`mirror:<slot>` channels (live pane mirroring, at most 4 per connection) ship with the
mirror milestone; their protocol will be added here before any client depends on it.

## Versioning

- Envelope: `v` field (currently 1). Stream cursor vector: `v1;` prefix. Additive fields
  may appear without a bump; meaning changes bump.
- `GET /api/v1/meta` -> `{v, serveVersion, binaryVersion, skew, repos, tokenAgeDays,
  seat}`. `skew: true` means serve's loaded code and the binary it spawns disagree -
  reads keep working, mutations return `503` until serve restarts.
