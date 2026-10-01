# lib/commands

The CLI command layer. Each module implements one `sm` command namespace: the router
(lib/router.mjs) parses the route and calls a `cmd*` handler here, which parses its own
flags, gathers state through lib/slots, lib/mux, lib/agents, and lib/inbox, and prints
either a human rendering or `--json`. The repo README covers the dispatcher/worker model
and vocabulary; docs/architecture.md covers the layering; docs/http-api.md covers the
serve API.

## Modules

- `agents.mjs` - the global agent roster (plugins + instances); global scope, no repo.
- `lock.mjs` - slot worktree locks and named shared-resource locks (claim, release, ls, prune).
- `msg.mjs` - task dispatch to slot panes, worker reports, and the dispatcher inbox.
- `repo.mjs` - current-repo selection and the known-repo registry.
- `serve.mjs` - CLI wiring for the cockpit HTTP+SSE bridge (the server lives in lib/serve/).
- `session.mjs` - build/attach/reload/detach/kill the multiplexer sessions that lay out slots.
- `shared.mjs` - cross-namespace helpers: parseCmd, argOptions, watchLoop, worker/journal records, resolveSession.
- `slot.mjs` - slot inspection, freeness, focus, reset, and worktree create/rm.
- `top.mjs` - top-level commands: stats, version, floor, journal, doctor.
- `watch.mjs` - dispatcher supervision: one-shot `--check`, the hook shim, the blocking watch.
- `worker.mjs` - role/preflight, worker status (ps/wait/logs), dispatch alias, worker kill.

## Rules and invariants

**One arg source.** `argOptions` derives each command's parseArgs options from its arg-spec
in schema/commands/ - the same spec the MCP server exposes as inputSchema, so CLI parsing
cannot drift from the tool contract. Every command gets `--json`/`--help` for free;
handlers never see `--help` (the router prints route help first).

**Delivery honesty (msg.mjs).** A non-live pane (agent exited to a shell) is never typed
into - the task text would run as a shell command; it is marked dead and skipped. Only
targets whose composer verifiably submitted are claimed and journaled; `--until-idle`
re-submits but never re-types (re-typing duplicates pending composer text). A dispatch
that delivered nothing exits nonzero. `--first-free` claims conditionally inside the
serialized document mutation so racing dispatchers cannot double-book a slot.

**Record ordering.** Claim write, then worker record + journal fact, then the CLI report:
the journal records what verifiably happened, never what is about to be. Journal appends
degrade to a warning (history is an aid, not a ledger - a full disk must never block
delivery); worktree-document writes hard-fail (the document is load-bearing).

**Reset safety (slot.mjs).** `resetSlot` refuses a live lock, dirty tree, unmerged
commits, or a turn in flight unless forced, and throws rather than silently no-opping -
a caller can never dispatch onto an un-reset slot. The base is fetched first so a
just-merged slot reads 0 ahead and resets without force. sm's own artifacts are excluded
from destructive git operations (the worker identity must survive a reset). The lock is
removed only after a verified-successful reset. The automatic force-reset of "merged"
slots (needed because squash-merged commits are not ancestors of origin/base) first
requires landed-work proof: HEAD contained in the slot's remote branch or in a merged
PR's head commit - otherwise a straggler commit made after the merge would be destroyed.

**Locks (lock.mjs).** Single-char names are slot labels - a missing worktree there is a
typo, not a resource. A resource lock stands for a userland process launched after the
claim (so no pid is stored; the holder is identified by cwd), and release or steal must
terminate that backing process via the resourceProcessPids seam, not just drop the
lockfile - the orphan would block the next claimant. Steals happen only when the holder's
worker is demonstrably dead, or on an explicit `--force`.

**Watch is a pure observer (watch.mjs).** It never types into panes, claims nothing,
consumes nothing; its only writes are the surfaced watermark, journal facts, and its own
armed marker. Digest overflow re-fires on the next ack so capped digests drain batch by
batch; the first-ever ack baselines the backlog instead of deluging it. The hook shim
speaks the hook protocol exactly: exit 2 + stderr blocks a stop, exit 0 + hookSpecificOutput
adds context, no output means no action. A consecutive-block budget degrades to allow so a
broken check or noisy fleet can never wedge a session, and the SM_DESK=1 seat gate fails
closed because env inheritance into hook subprocesses is undocumented. Seat-marker
refinements (a registered desk session id, a marker file, pane-title introspection) are
logged ideas, not built.

**Mux addressing (session.mjs).** Groups and panes are addressed by the handles creation
ops return - never by index, so base-index settings cannot break layout.

**Serve stability (serve.mjs).** The spawn target must be version-stable: `sm` on PATH
(or $SM_SERVE_BIN), never an install-relative path, so a live serve survives upgrades.
The pairing token travels in a URL fragment - it never reaches a server or log, but it
does land in browser history, which is why rotation is cheap and surfaced.
