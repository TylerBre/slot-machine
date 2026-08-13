# lib/plugin

The shared plugin contract underlying every plugin system in sm. There are two plugin
domains today: agents (`lib/agents/`, the coding-agent CLI a worker runs, Claude built
in) and multiplexers (`lib/mux/`, tmux built in, zellij as an alternative). Both dispatch
their ops through this one contract so the core reacts to plugin success and failure
uniformly, whatever the domain.

## Modules

- `contract.mjs` - the OK/ERR envelope every plugin op returns, the closed err
  vocabulary, and `callOp`, the single guarded call path through which the core invokes
  plugin ops.

## The envelope

Every plugin op returns an envelope, built with the `ok`/`err` helpers:

- `ok(value)` -> `{ ok: true, value }`
- `err(kind, detail)` -> `{ ok: false, err: kind, detail }`

Core code branches on `ok` and on the `err` kind. `detail` is human-readable context for
messages and logs; nothing may branch on its text.

## The err vocabulary

The kinds are a closed set (`ERR`); the core knows how to react to each:

| kind | meaning |
| --- | --- |
| `not-installed` | the backing tool is missing (typically from PATH, at probe time) |
| `unsupported` | the plugin does not implement this op; it is an optional capability and the caller degrades gracefully |
| `unparseable` | the plugin found data it refuses to interpret (e.g. a config file that is not valid JSON) |
| `agent-error` | the plugin itself misbehaved: it threw, returned a non-envelope, or returned an unknown err kind |
| `crashed` | the backing tool ran and failed |
| `config` | bad or missing configuration or arguments |
| `timeout` | the op ran out of time |

The set being closed is load-bearing: `callOp` coerces any envelope carrying an unknown
kind to `agent-error`, so core code never meets a novel kind.

## Rules and invariants

- `callOp` is the only place plugin code is trusted. Core code never invokes a plugin op
  directly; everything goes through the guard.
- `callOp` never throws. The failure direction is always a well-formed err envelope:
  a missing op maps to `unsupported`; a throw, a non-envelope return, or an unknown err
  kind maps to `agent-error`.
- Ops are invoked as method calls (`plugin[op](args)`), so an op implementation may use
  `this`.
- The contract is synchronous by design: drive ops are sync, and doctor/setup paths use
  `spawnSync`.
- Op vocabularies (which ops exist, their signatures, which are required vs. optional
  capabilities) belong to the domain contracts, not here. `lib/agents/contract.mjs` and
  `lib/mux/contract.mjs` re-export this module under stable domain import paths so
  plugins and callers in each domain keep one import.

## Related

- `lib/agents/` - the agent plugin system: registry, instance resolution, the built-in
  claude plugin.
- `lib/mux/` - the multiplexer plugin system: the op catalog, reliability loops in core,
  the tmux and zellij backends.
- The top-level `README.md` (Agents section) describes the user-facing agent-instance
  model this contract serves.
