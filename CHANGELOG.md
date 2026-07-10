# Changelog

All notable changes to slot-machine are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
