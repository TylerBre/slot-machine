# Changelog

All notable changes to slot-machine are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The web-cockpit bridge: sm gains an HTTP+SSE surface for the dispatcher cockpit
(sm-cockpit, a separate repo). The core stays zero-dep; the web app never touches sm
internals - everything rides the argspec-derived contract in docs/http-api.md.

### Added

- **`sm serve`** - a zero-dep node:http bridge on 127.0.0.1: the x-web command allowlist
  over one generic POST (the third registration of the argspec surface, after CLI and
  MCP), the ONE multiplexed SSE stream per tab (inbox/journal deltas resumable by
  monotonic ts cursor with delivered-through id stamping; floor/watch as complete
  conflated snapshots; real ka heartbeats; honest gap/cursor-reset advisories), pairing
  token -> stateless HttpOnly HMAC sessions, Host allowlist, strict-CSP static hosting,
  partitioned spawn pools, per-repo worker-run serialization, a version-skew gate on
  mutations, a single-instance pidfile, ordered teardown, and doctor checks.
- **`x-web` exposure layer**: every command spec carries an explicit boolean; webHidden
  args (consumption verbs, blocking flags) stay off the web schema; x-exit maps defined
  non-zero exits to named ok outcomes.
- **Standing subscriptions** over inbox/journal (persistent debounced fs.watch nudges)
  and **mux streaming ops** (tmux pipe-pane capture behind the contract) for the coming
  pane mirror.
- **Conditional dispatch claim**: worker-run/msg -f now claim inside the serialized
  document mutation and re-pick on a lost race - two dispatchers can never double-book a
  slot (fixes a long-standing TOCTOU).
- **The pane mirror**: `mirror:<slot>` channels on the stream - a live read-only view of
  a worker's terminal in the browser. tmux pipe-pane capture (seeded with the current
  screen on open) behind a worker thread so the HTTP loop never blocks on the mux; a
  durable session registry written before the pipe with a startup sweep; refcounted
  viewers with a linger; per-tab (4) and server-wide (8) budgets; pipe-lost and rotate
  surfaced honestly as events; poll-dump fallback for backends without pipe support.
- **docs/http-api.md** - the committed wire contract sm-cockpit builds against.

## [1.4.0] - 2026-08-04

Multiplexer plugins: slot machine is no longer hardwired to tmux. The session/pane layer
sits behind the same plugin-contract pattern the agent system uses; tmux stays the built-in
default and an untouched config behaves exactly as before. Zellij (>= 0.44) ships as the
second backend.

### Added

- **Multiplexer plugin system.** A backend contract over a session > group > pane model -
  create/list/kill sessions, spawn groups and panes (creation ops return the handles callers
  address by), structured pane records, literal-type/submit/capture IO primitives, focus and
  attach - dispatched through the same guarded call path as agent plugins. The send
  reliability loop (settle, verify the composer cleared, retry) lives once in core, on top of
  the primitives.
- **Zellij backend (experimental), `settings.mux: zellij`.** Built on zellij 0.44's CLI
  automation surface and version-gated against older zellij. Pane labels are zellij pane
  names (rendered natively on the frame - no config block needed). Known v1 limits: `sm
  worker kill` cannot resolve a pane pid (end the worker from inside its pane), and worker
  liveness for shell panes uses a prompt-scan heuristic because zellij does not report a
  pane's foreground command.
- **Pane labels.** Worker panes are stamped with their slot label at spawn (tmux: the
  sm-owned `@smslot` pane option; zellij: the pane name), and slot correlation is
  label-first - it now survives a worker `cd`-ing away from its worktree. Panes from
  sessions built before labels existed still correlate by directory.

- **The worker is persisted: `.worktree-lock` becomes the worktree document.** The flat lock
  grows into nullable sections - `claim` (the lock, embedded resources included), `worker`
  (the conversation bound to the slot: agent instance, transport, session id), and `turn`
  (an in-flight session turn) - versioned, schema-validated, elevated on read like every sm
  document. `readLock` keeps its exact historical contract, so claim consumers are untouched;
  legacy flat locks elevate transparently and absent sections mean "legacy slot".
- **Serialized, atomic document writes.** Every mutation flows through one protocol: an
  exclusive-create `.worktree-lock.tmp` that is simultaneously the write mutex and the
  atomic-write vehicle (write, fsync, rename). Stale mutexes are broken by rename with
  pid-identity staleness; owned-field merges mean a re-spawn never nulls a session id it
  did not mint.
- **The turn section: one session turn per worker, structurally.** Serialized read-check-write
  claim, verify-before-clear release, pid-identity liveness that fails toward alive. `slot
  reset` and `slot rm` refuse while a turn is pid-live (`--force` breaks it through the
  protocol). Ships ahead of its first consumer (the headless transport).
- **The turn journal.** `~/.config/slot/journal/<repo>.jsonl`: append-only, fsync'd facts
  about the fleet (worker-created, task-dispatched, turn-*, worker-replaced) - history the
  future watcher reads; the inbox stays the mailbox. Rotation by rename only, failing closed.
  Journal failure on the dispatch hot path degrades to a warning - history never blocks
  delivery.
- **`slot reset --hard-worker`** - also clear the worker record (fresh conversation on the
  next dispatch), journaling `worker-replaced` before the mutation. A plain reset now keeps
  the conversation: `git clean` excludes sm's artifacts (which also fixes a latent bug where
  a dirty force-reset silently deleted the lock itself).
- **Surfaces:** `slot inspect` shows the worker record, `sm floor` gains per-slot transport,
  `sm doctor` checks document health, abandoned write mutexes, and journal size.

Supervision: reports reach the dispatcher deterministically - no recurring AI duty, no
agent lock-in. One pure classifier decides absorb vs surface; all supervision state is
durable (monotonic inbox timestamps, two cursor files, journal facts); delivery is an
optional agent-plugin capability.

- **Report verbs.** Reports lead with `done:` / `blocked:` / `needs-decision:` / `failed:`
  / `working:` / `paused:`. Parsed on READ, never persisted (no inbox schema bump - a
  version-skewed reader can never drop new reports); a verb-less report always surfaces.
  `msg inbox --json` gains a computed `verb`; the human render verb-tags by severity;
  `msg report` tips on verb-less messages; `--brief` and the role briefings teach the
  contract to workers.
- **`sm watch`** - the supervision core. `--check` peeks (gather -> classify -> capped
  digest; exit 0/3; changes nothing); `--check --ack` surfaces durably (journal facts +
  surfaced watermark, advanced only through emitted events so digests drain batch by
  batch; the first ack baselines past the existing backlog instead of deluging it); bare
  `watch [--loop] [--timeout]` blocks - wakes on reports, re-checks on a cadence for
  report-less events, arms a floor-visible marker. Surfaced: attention/verb-less reports,
  stale `paused:` (hourly re-fire), stalled `working:`, crashed workers (claim held,
  worker gone in two samples - a killed session counts, a mux blip cannot), merged PRs on
  claimed slots (state-based: an overnight merge surfaces on the next run).
- **`sm msg inbox --unread`** - non-destructive read cursor: only reports since your last
  read, then the cursor advances. Reading (`--unread`) and surfacing (`--ack`) are
  separate cursors; the watch never marks anything read. `--clear` also drops both
  cursors. `sm floor` shows `unread of total` + oldest-unread age (starvation signal) and
  the watch armed/NOT-armed line.
- **Hook delivery for Claude Code desks (optional plugin capability).** `sm doctor --fix`
  in the desk project installs seat-gated Stop + UserPromptSubmit hooks (project settings,
  never user-level; idempotent; refuses to rewrite unparseable JSON). Active only under
  `SM_DESK=1`, so extra desk agents and workers are silent no-ops; a consecutive-block
  budget (degraded-allow after 3) guarantees a broken check can never wedge a session.
  Agents without the capability simply have no delivery layer - conformance pins the ops
  as optional.
- **Evidence integrity.** Monotonic per-repo inbox timestamps (same-millisecond reports
  stay distinct); ts-based `--watch` baselines (fixes a latent loss bug where a concurrent
  `--clear` blinded the watch); checked gh polls (`prMapChecked` - failure distinguishable
  from "no PRs"); mux-envelope-aware worker samples (a backend error can never fabricate
  crash alarms); journal record schema v2 (write-side only) adds `pr-merged` / `surfaced`
  / `delivered` / `watch-degraded` facts.

### Changed

- **The whole core is multiplexer-agnostic.** Session build/reload/attach/kill, message
  delivery, worker status/logs/kill, and slot focus all speak the backend contract;
  `exec.mjs` is git/gh/OS-process plumbing only. Session windows are addressed by returned
  handles - the tmux `base-index` arithmetic is gone.
- `sm doctor` reports the active multiplexer backend by name, and skips backend-specific
  checks (pane-title config) on backends that do not need them.

## [1.3.0] - 2026-07-29

Dispatcher quick wins, ported from a design comparison against firstmate
(kunchenguid/firstmate): a one-call fleet snapshot, a landed-work proof before destructive
resets, and a ghost-text-aware delivery check.

### Added

- **`sm floor`** (+ MCP tool `sm_floor`) - one-shot fleet snapshot for the dispatcher:
  running sessions, one row per slot (worker, activity, lock + task), held resource locks,
  and the unread inbox count, in a single command instead of four. Cheap - tmux + lockfiles
  only; `sm slot ls` stays the authority on reusability.
- **Landed-work proof before automatic reset.** `msg send --first-free` / `worker run` now
  refuse to force-reset a "merged" slot whose HEAD is not contained in its remote branch or
  any merged PR's head commit - a straggler committed after the merge is no longer silently
  destroyed; the dispatcher is pointed at `sm slot inspect` instead.
- **Ghost-text-aware delivery verification.** The composer-cleared check now captures with
  ANSI and strips faint/dim spans first, so Claude's dim autocomplete suggestions after the
  prompt no longer read as unsent input (false "typed but did NOT submit" warnings and
  pointless `--until-idle` retries).

## [1.2.0] - 2026-07-14

Agent plugins: slot machine is no longer hardwired to Claude. A repo or an individual
slot can run any configured coding agent, selected through a plugin contract and a config
roster. Fully backward compatible - an untouched config keeps running Claude unchanged.

### Added

- **Agent plugin system.** A standard plugin contract - launch, resume, activity,
  last-message, transcript-age, doctor/setup - behind which each agent's specifics live;
  the core only ever talks to the contract, through one guarded call path. Claude ships as
  the built-in plugin and reproduces the prior behavior exactly.
- **Config roster (schema v2).** `~/.config/slot/config.json` gains a `settings` section and
  an `agents` roster. A repo has a default agent + model; a slot can override both; named
  instances reuse a base plugin with their own env, models, and MCP servers - e.g. a personal
  and an enterprise Claude, each with its own `CLAUDE_CONFIG_DIR`. v1 configs elevate on read;
  every new field is optional.
- `sm agents ls | dir [PATH] | add NAME [--use PLUGIN | --plugin FILE] [--env K=V ...]
  [--models a,b] [--mcp FILE] | rm NAME` - manage the agent roster.
- `sm repo config [--agent NAME] [--model M]` - set the repo's default agent instance/model.
- `sm slot config LABEL [--agent NAME] [--model M]`, and `--agent`/`--model` on `sm slot create` -
  per-slot agent/model overrides.
- Per-instance MCP servers: an instance can declare extra MCP servers, wired into its agent
  by `sm doctor --fix`.

### Changed

- **A "worker" is now whichever agent its slot resolves to** (Claude by default), not always
  Claude. Launch, resume, activity detection, and transcript reading all route through the
  resolved plugin.
- **MCP wiring is gated behind `sm doctor --fix`.** `sm top`/`sm doctor` no longer auto-register
  the slot MCP server; `doctor` reports each in-use agent's version and per-server wiring status,
  and `--fix` wires any missing server under that instance's config dir. The standard server
  keeps the name `slot-machine`.

## [1.1.4] - 2026-07-10

### Added

- `sm version` - the full build + runtime readout: version, node, install path + source (a git
  sha when run from a checkout, else `packaged`), the MCP entry point, and the current repo.
  `sm --version` / `-V` stays the bare-number shortcut. `--json` for machine output; exposed over
  MCP and config-tolerant (runs like `doctor` even when the config is broken) so it can identify a
  build mid-diagnosis.

## [1.1.3] - 2026-07-09

### Fixed

- **Dispatch can reclaim merged slots again.** The unmerged-commit guard added to `slot reset`
  in 1.1.2 also refused squash-merged slots (their pre-squash commits are not ancestors of
  origin/base), so `sm worker run` / `sm msg send -f` could no longer auto-reset and reuse a
  merged slot - the core dispatch-to-reusable-slot path. `pickReusable` now force-resets a slot
  it has already classified `merged` (those commits are merged via squash, safe to discard).
  Manual `sm slot reset` keeps the conservative guard (still requires `--force`).

## [1.1.2] - 2026-07-09

Round-3 review: data-safety fixes, a wait primitive, and CLI/MCP interface polish.

### Fixed

- **Committed work is no longer clobbered by dispatch.** `slotGit` now returns `ahead=null`
  when the commit count cannot be computed (an unresolvable `origin/<base>`), and `classifySlot`
  treats unknown-ahead as busy (`unknown`) instead of `free` - so a slot sitting on
  committed-but-unpushed work is never handed out for reuse.
- **`slot reset` no longer silently discards unmerged commits.** It fetches before measuring,
  refuses to reset a slot with commits not on `origin/<base>` unless `--force`, and throws on a
  failed reset rather than dropping the lock and reporting success.
- **`msg send` no longer types a task into a dead pane.** A pane whose worker has exited to a
  bare shell is skipped (and reported), instead of having the message run as a shell command.
- Inbox reports can no longer be lost: `appendReport` and the consume/clear rewrites are
  serialized by a cross-process lock.
- Dispatch selection is no longer a race: `--first-free` / `worker run` claims the chosen slot at
  selection time, so two concurrent dispatches cannot double-book one slot.
- `--repo` is honored only before a `--` terminator, so it can be sent as literal message text.
- MCP `serverInfo.version` reports the real build, and MCP calls have a timeout so a blocking
  call cannot wedge the server.

### Added

- `sm worker wait [-s SPEC] [--timeout SEC]` - block until the targeted workers finish working.
- `sm --version` / `-V`.
- `--watch` and `--follow` are accepted interchangeably across `slot ls`, `worker ps`, and
  `worker logs`.
- `worker kill` refuses a worker that is actively working unless `--force`.

### Changed

- Numeric MCP parameters are typed `integer`, so a JSON number is accepted uniformly.
- Missing MCP parameter descriptions filled in; the `issue` column is documented in help.

## [1.1.1] - 2026-07-08

### Fixed

- `session reload` now preserves the session's chosen pane packing. It had floored
  panes-per-window at 3, so growing a 2-pane session fattened its 2-pane windows to 3
  instead of appending new 2-pane tabs; it now infers the width from the densest
  existing slot window.

## [1.1.0] - 2026-07-08

### Added

- Zero-dependency JSON Schema validation (`validate`, `loadSchema`) plus a
  shared version-migration runner (`elevate`). Every persisted document -
  worktree lock, config, inbox, usage - is now a versioned model upgraded on
  read, so a schema bump never breaks old data.
- Single source of truth for command arguments: each command is defined once
  in `schema/commands/<cmd>.json`, and `lib/argspec.mjs` derives the CLI
  `parseArgs` options, the MCP tool `inputSchema`, and the MCP-to-CLI argv
  from that one file. An `x-mcp` flag gates whether a command is exposed over
  MCP; a conformance test proves the two surfaces cannot drift.
- Homebrew install through a dedicated tap: `brew install tylerbre/tap/slot-machine`.
- Resource locks terminate their backing process on release - freeing the
  browser lock closes the browser it owned.
- Tracker issue id stored on a lock.
- `docs/architecture.md` with Mermaid diagrams (runtime topology, module
  layers, the arg-spec flow, the slot lifecycle), linked from the README.
- `npm run pack` - a shareable tarball of tracked files at HEAD.
- `sm msg send --until-idle` retries a pending submit until the worker goes idle.
- `sm msg inbox -n N` and `--newest-first` for reading back a bounded, ordered
  slice of reports.
- `sm slot ls` shows each slot's PR state in a dedicated column.

### Changed

- Relicensed to GPL-3.0-or-later.
- Adopted `@antfu/eslint-config` as the single opinionated preset; it owns
  formatting, so Prettier is gone.
- One lockfile per slot. Shared resources (the authenticated browser, a port)
  are embedded in the worktree lock's `resources` array; the worktree schema
  references the resource-lock schema by `$ref`; `cwd` is the lock identity.
- Restructured `lib/` for focus and no cycles: `commands.mjs` split into
  `lib/commands/<namespace>.mjs` (+ `shared.mjs`), `slots.mjs` split into
  `lib/slots/{pure,locks,gather}.mjs`, and `elevate`/help text extracted into
  `lib/elevators.mjs` and `lib/help.mjs`. No barrel files - import from the
  specific module.
- Config load fails loud on a corrupt or schema-invalid config; `sm doctor`
  and `sm help` still run so the tool can diagnose itself.

### Fixed

- `msg` no longer claims a slot whose composer never submitted; delivery waits
  for a verified submit.
- `validate()` rejects a top-level array instead of treating it as an object.
- `buildArgv` spreads array positionals, drops only trailing positionals, and
  throws on a positional gap.
- `sm msg inbox --watch --clear` clears only the reports it displayed, not any
  that arrived mid-render.
- `sm lock steal` terminates the stolen resource's backing process; a resource
  claim resolves correctly from a slot subdirectory.
- Resource resolver matches `node`/`npm` by basename and uses own-property
  lookup, so a resource named like an inherited object property resolves right.
- The usage log's v0->v1 elevator stamps an authoritative version instead of
  trusting a legacy field.

## [1.0.0] - 2026-07-08

- Initial release: tmux + git-worktree orchestration for Claude agent fleets,
  as a CLI (`sm`) and an MCP server.
