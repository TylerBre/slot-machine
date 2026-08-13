# lib/

Everything the `sm` CLI, MCP server, and HTTP serve execute lives here. The root
modules are cross-domain plumbing shared by every surface; each subdirectory is a
domain with its own README covering its modules and invariants. See
docs/architecture.md for how the layers stack.

## Root modules

- `argspec.mjs` - adapts each arg-spec in schema/commands/ into CLI parseArgs options, the MCP inputSchema, and the MCP-to-CLI argv, so the surfaces cannot drift.
- `constants.mjs` - config and raw text for the CLI, derived from the active repo's resolved context.
- `context.mjs` - repo resolution and persisted per-repo config (`~/.config/slot/config.json`); `sm repo use` sets the current repo.
- `elevators.mjs` - the version-migration runner: lifts a raw parsed document up an elevator ladder to the current schema version.
- `exec.mjs` - process plumbing: git, gh, and OS-process wrappers (nothing here talks to a multiplexer; that is lib/mux).
- `format.mjs` - output helpers: exit, JSON, color, spinner, and the human-facing renderers.
- `help.mjs` - the help/usage/vocabulary/role prose, one source per namespace.
- `inbox.mjs` - the worker-to-dispatcher back-channel: a per-repo append-only message inbox (`sm msg report` / `sm msg inbox`).
- `router.mjs` - the canonical command router; both bin entry points dispatch through its one table.
- `schema.mjs` - zero-dep JSON-Schema (draft-07 subset) validate/loadSchema for every model in schema/.
- `setup.mjs` - first-run setup: bin symlinks on PATH and (with tmuxconf) what `sm doctor --fix` applies.
- `tmuxconf.mjs` - the managed slot-machine block in the user's tmux.conf (per-pane titles), upserted idempotently.
- `usage.mjs` - local-only telemetry: one JSONL line per invocation, feeding `sm stats`.

## Domains

[agents/](agents/README.md) - the agent plugin domain: which coding agent (Claude
Code built in) and model a slot's worker launches with, how pane activity is read,
and how the watch's hook delivery is wired. Owns the registry and instance
resolution behind `sm agents`.

[commands/](commands/README.md) - the CLI command layer, one module per `sm`
namespace. The router calls a `cmd*` handler here, which gathers state through the
domain layers and prints a human rendering or `--json`. Home of the load-bearing
delivery, reset, lock, and watch policies.

[mux/](mux/README.md) - the multiplexer domain: a backend-neutral op contract for
driving panes (session > group > pane), reliability logic (verified message
delivery, label-first slot correlation) built once in core, and the tmux and zellij
backends.

[plugin/](plugin/README.md) - the shared plugin contract under both plugin systems
(agents and multiplexers): the ok/err envelope, the closed err vocabulary, and
`callOp`, the single guarded path through which core code invokes any plugin op.

[serve/](serve/README.md) - `sm serve`, the localhost HTTP+SSE surface for the
dispatcher cockpit: the third registration of the argspec surface after CLI and
MCP. Owns auth, the no-shell spawn policy, the SSE stream, and the pane mirror.

[slots/](slots/README.md) - the slot domain: gathering and classifying slot state,
the `.worktree-lock` worktree document and its serialized write protocol, the
append-only turn journal, and the report-verb policy behind watch supervision.
