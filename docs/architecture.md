# Architecture

How `sm` (slot machine) is put together. Diagrams are Mermaid and render on GitHub.

## Runtime topology

One tmux session per repo: a **desk** window you dispatch from, and one pane per **slot** (a git
worktree) running a Claude **worker**. Work flows desk -> slot; results flow slot -> desk through a
per-repo inbox.

```mermaid
flowchart LR
  desk["desk window (dispatcher: you or an agent)"]
  subgraph session["tmux session"]
    desk
    wa["worker a"]
    wb["worker b"]
    wc["worker c"]
  end
  wa --- ga["worktree acme-slot-a"]
  wb --- gb["worktree acme-slot-b"]
  wc --- gc["worktree acme-slot-c"]
  desk -->|"worker run / msg send"| wa
  desk --> wb
  desk --> wc
  wa -->|"msg report -> inbox"| desk
```

## Module layers

Dependencies point one way (no cycles, no barrel files - each module imports from the specific file
it needs). Both entry surfaces - the CLI router and the MCP server - sit on top of the same `lib/`.

```mermaid
flowchart TD
  bin["bin/sm, bin/slot-machine"] --> router["router.mjs"]
  mcp["bin/slot-machine-mcp"] --> argspec["argspec.mjs"]
  router --> commands["commands/ (repo, session, slot, worker, msg, lock, top, shared)"]
  commands --> slots["slots/ (pure, locks, gather)"]
  commands --> exec["exec.mjs (tmux/git/gh)"]
  commands --> context["context.mjs (repo config)"]
  commands --> help["help.mjs (usage text)"]
  commands --> constants["constants.mjs (config/data)"]
  argspec --> schema["schema.mjs (validate, loadSchema)"]
  slots --> schema
  slots --> elevators["elevators.mjs (elevate)"]
  context --> schema
  context --> elevators
  schema -. reads .-> files["schema/*.json + schema/commands/*.json"]
  argspec -. reads .-> files
```

Within `slots/`, `pure.mjs` is a leaf (classification/parsing, no I/O); `locks.mjs` depends on it;
`gather.mjs` (tmux/git state) depends on both. Within `commands/`, `shared.mjs` is a leaf; the only
cross-namespace edges are `worker -> msg` (`worker run` is `msg send --first-free`) and `msg -> slot`.

## One arg-spec, no CLI/MCP drift

Each command's arguments are defined once in `schema/commands/<cmd>.json` (a JSON-Schema `inputSchema`
plus an `x-cli` block and an `x-mcp` flag). `lib/argspec.mjs` adapts that single file into all three
consumers, so they cannot disagree; a conformance test proves the round-trip.

```mermaid
flowchart LR
  spec["schema/commands/&lt;cmd&gt;.json"]
  spec -->|toParseArgs| cli["CLI parseArgs options"]
  spec -->|"mcpInputSchema (x-mcp:true)"| tool["MCP tool inputSchema"]
  spec -->|buildArgv| argv["MCP -> CLI argv"]
  test["conformance test"] -. build then parse round-trips .-> spec
```

## Versioned data models

Every persisted document is a versioned JSON model described by a schema in `schema/` and validated
by the zero-dep `validate()`. Old data is upgraded on read by an elevator ladder (`elevate()`), so a
schema bump is seamless.

- **worktree lock** (`.worktree-lock`, one per slot) - the single lockfile; shared resources (the
  authenticated browser, a port) are embedded in its `resources` array, each described by the
  resource-lock schema the worktree schema references by `$ref`.
- **config** (`~/.config/slot/config.json`) - repos + current; validated loud on load.
- **inbox** and **usage** records - JSONL; inbox is strict, usage is lenient.

```mermaid
flowchart LR
  raw["raw JSON on disk"] -->|"elevate(ladder)"| current["current-version doc"]
  current -->|"validate(schema)"| ok["used"]
  current -->|problems| loud["fail loud (config/inbox) or skip (usage)"]
```

## Slot lifecycle

`sm slot ls` classifies every slot along this cycle from its git branch + GitHub PR state; `sm slot
reset` closes the loop.

```mermaid
stateDiagram-v2
  [*] --> free
  free --> wip: dispatch (locked)
  wip --> waiting_merge: PR opened
  waiting_merge --> merged: PR merged
  merged --> free: slot reset
  wip --> free: reset / abandon
```
