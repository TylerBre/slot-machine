# lib/serve

`sm serve` is the localhost HTTP+SSE surface for the dispatcher cockpit and local
scripting: the third registration of the argspec surface, after CLI `parseArgs` and the
MCP `inputSchema`. All three derive from the same `schema/commands/*.json`, so the web
surface cannot drift by hand. The wire contract clients build against is
[docs/http-api.md](../../docs/http-api.md).

## Modules

- `server.mjs` - the zero-dep `node:http` server: routing, auth gate, host allowlist,
  the single-instance pidfile, the startup skew probe, and teardown order.
- `auth.mjs` - the pairing token and stateless HMAC cookie sessions.
- `commands.mjs` - the command runner: schema validation, `buildArgv`, spawn policy,
  pools, per-repo dispatch serialization, and the versioned response envelope.
- `stream.mjs` - the one multiplexed SSE stream per tab: per-connection pumps, cursor
  resume, refcounted snapshot pollers, and mirror channel plumbing.
- `mirror.mjs` - the mirror session manager: the ONE stateful streaming resource, with
  registry, spools, refcounted viewers, and a sweep.
- `mirror-worker.mjs` - the worker thread that owns every blocking mux call, plus the
  poll-dump fallback for backends without pipe streaming.
- `doctor.mjs` - doctor's serve health checks, as data rows cmdDoctor renders.

## Load-bearing rules

**The token is an arbitrary-code-execution credential.** The surface it guards
dispatches tasks to agents holding shell, git, and gh. Everything in `auth.mjs` is sized
against that: 32 random bytes, 0600 in a 0700 dir, constant-time compares everywhere.
Sessions are HMAC derivatives of the token - stateless, so a restarted serve honors
cookies minted by a dead one, and after pairing no JS-readable credential exists.

**The serve law.** Nothing claimed to be "on disk now" may resolve relative to
`import.meta.url`: under Homebrew, module realpaths land in a versioned Cellar directory
that goes stale (or vanishes) when `brew upgrade` runs beneath a long-lived server.
Spawns go through the caller-provided, PATH-stable target. Loading `mirror-worker.mjs`
via `import.meta.url` is module resolution of the running code, not an on-disk claim,
so it is exempt. The command catalog deliberately reads serve's OWN schema snapshot: it
must describe what serve's loaded argspec code can validate; skew against the spawn
target is surfaced separately.

**Version skew fails toward observation.** A stale serve may still OBSERVE the fleet
(the read-tool allowlist in `commands.mjs`) but must not MUTATE through a newer binary
whose semantics its loaded schemas cannot describe; mutations get a 503 until restart.

**Spawn policy.** Never a shell: argv arrays only, so no request-derived byte can be
interpreted. The repo pin (exact registered-name match, resolved serve-side to an
absolute dir, refused before any spawn) is the only backstop - `resolveActive` would
happily take an arbitrary path. Pool counters and per-repo dispatch queues are liveness
aids, not correctness state.

**API-only, one instance, one writer.** sm never serves HTML; the cockpit runs on its
own origin and proxies `/api` here, so the cookie model needs no CORS mode. Command
POSTs require same-origin proof (an explicit cross-site `Sec-Fetch-Site` always
refuses; absent the header, only bearer auth passes, since no legitimate Origin exists
for a cookie-authed browser request). The pidfile enforces one serve per state dir
(pid-identity liveness, failing toward alive), which is what justifies the mirror
registry's plain atomic tmp+rename with no cross-process mutex: one writer by
construction, and the startup sweep reconciles whatever a crashed predecessor left.

**Stream contracts.** LOG channels (inbox, journal) are deltas resumed by durable ts
cursor - the journal file is its own buffer, while the inbox can be consumed underneath
us, so a bounded pending ring absorbs stalls and honest `gap` advisories surface what
could not be replayed, never silence. SNAPSHOT channels (floor, watch) are complete
replacements conflated to the latest. `ka` is a real event because EventSource cannot
observe comments or half-open TCP. The id-stamping law: the vector on every event is
the connection's delivered-through position per log channel, never the file tip - a
tip-stamped id during a stall would make the next Last-Event-ID skip records the client
never received.

**Mirror concurrency laws.** Admission is serialized per key (an in-flight open is a
promise later openers join, never race); the cap counts live sessions plus in-flight
opens synchronously. Every session has an epoch, so a viewer of a dead session can
never debit its successor and a straddling status tick no-ops instead of tearing down
the wrong session. Per-session ops (rotate, status tick, teardown) serialize on a
chain. A crashed worker is a refusal ('backend-lost'), not a process death. The
registry is written BEFORE the pipe starts (rollback on failure): a crash between the
two leaves a findable entry for the sweep, where the reverse order would leak an
unfindable pipe forever. Resets are always followed by a fresh full frame - stale
terminal bytes are worse than a redraw.
