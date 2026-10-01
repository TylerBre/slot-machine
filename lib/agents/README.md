# lib/agents

The agent domain: pluggable coding agents that run in slot panes. In the sm model a
repo has slots, each slot's pane runs a worker, and the worker is an *agent
instance* — a plugin (Claude Code is the built-in) plus an optional model and env.
This directory owns which agent/model a slot launches with, how a pane's activity is
read, and how the watch's hook delivery gets wired. See docs/architecture.md for the
surrounding slot/desk/watch model.

## Modules

- `contract.mjs` — re-exports the standard plugin contract
  (`lib/plugin/contract.mjs`) under its original path so agent plugins and callers
  keep one stable import. The ok/err envelope, the fixed `ERR` vocabulary, and the
  guarded `callOp` path are shared with every other plugin system (multiplexers).
- `claude.mjs` — the built-in Claude Code plugin: launch string, resume check,
  pane-activity regexes, transcript parsing, doctor/setup (MCP wiring), and the
  optional delivery op pair (watch hooks).
- `index.mjs` — the agent registry: loads built-ins + user plugins into a roster of
  instances, resolves a slot to a concrete `{ plugin, model, env }`, validates
  models, and provides the pure roster mutators behind the `sm agents` commands plus
  the launch/activity entry points the rest of the core calls.

## Rules and invariants

**Contract boundary.** Plugin code is only ever invoked through `callOp`; it is the
one place plugin code is trusted. Every op returns the ok/err envelope; a missing op
is `unsupported`, and a throw or malformed return becomes `agent-error`. Ops are
synchronous by design (drive ops are sync; doctor/setup use `spawnSync`).

**Pure/IO split.** Decision logic (entry/model resolution, dependents, the roster
mutators) is pure over a plain cfg object and unit-tested; `loadRoster` /
`resolveInstance` wrap it with config and dynamic-import IO. Consequence: the pure
resolvers cannot see `models`/`defaultModel` declared only in a user plugin's code —
they treat such plugins as open (`'*'`)/null. Declaring models in the roster entry
(`sm agents add --models`) is what enforces a closed set.

**Roster snapshot.** `loadRoster` memoizes the instances together with the cfg they
were built from, and `resolveInstance` resolves against that same snapshot — no
re-read, so watch loops cannot drift between roster and config. Broken user plugins
are recorded in `problems` and omitted, never fatal.

**Resolution chain.** Agent: `slot.agent -> repo.agent -> 'claude'`. A model is
inherited across a level only if that level resolves to the same instance; when the
agent is overridden, model resolution restarts at the instance's `defaultModel`. The
final model is validated against the instance's exposed models; open models accept
any string (Claude Code validates its own `--model`).

**Failure direction on the read path.** An unresolvable or dead instance yields
`'error'` activity — a settled, non-`'working'` label — and `safeLaunchLine` warns
and returns null so the pane is left at a shell. Reading activity or building a
session never crashes on a broken plugin.

**Delivery (Claude).** The watch's hooks (Stop + UserPromptSubmit) are installed in
the desk project's `.claude/settings.json`, never user-level. The installed command
is repo-pinned (`--repo <repoDir>`): an unpinned command gates against the globally
mutable current-repo pointer, so `sm repo use` in any terminal would silently
repoint every desk's hooks at another repo's state. Dedup is by exact command
string — the same rule Claude Code uses when merging hook levels — and setup
upgrades a bare (unpinned) command to the pinned form in place rather than
duplicating it. `deliverySetup` refuses to rewrite a settings file it cannot parse:
clobbering it would eat the user's own hooks and permissions.

**Roster protection.** `claude` is a reserved built-in — its code cannot be shadowed
with `--plugin`. Removing an instance that other instances `use` is refused until
the dependents are repointed.

**Env handling.** Roster env values are `~`-expanded once by the registry; plugins
receive pre-expanded env and prefix it onto the launch line with single-quote shell
escaping (safe for spaces and metacharacters).

**MCP wiring.** `mcpServersFor` always includes the standard `slot-machine` MCP
server; extras declared on the instance are added, and a name collision means the
declared server wins.
