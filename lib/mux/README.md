# lib/mux — the multiplexer layer

Everything sm knows about terminal multiplexers lives here. Slots run their workers in
panes; this domain defines the backend-neutral op vocabulary for driving those panes
(the contract), the reliability logic built on top of it (core), and the two built-in
backends. The model is **session > group > pane** — "group" is the middle container
(a tmux window, a zellij tab). See docs/architecture.md for where this sits in the
overall system.

## Modules

- **contract.mjs** — the op catalog (`MUX_OPS`) every backend implements, the `Pane`
  record typedef, and re-exports of the shared plugin envelope (`ok`/`err`/`ERR`/`callOp`
  from lib/plugin/contract.mjs). Conformance tests iterate `REQUIRED_OPS`.
- **index.mjs** — the backend registry (`activeMux()`, resolved once from
  `settings.mux`, default tmux) plus the core IO helpers: `sendLine`, `sendMessage`,
  `resubmitMessage`, `stripGhostText`, `attachOrSwitch`.
- **tmux.mjs** — the built-in tmux backend. Every tmux format string and CLI quirk in
  slot-machine lives in this file. Groups are tmux windows.
- **zellij.mjs** — the zellij backend, built on the CLI-automation surface added in
  zellij 0.44.0 (per-pane targeting, `list-panes --json`, id-returning creation ops,
  background sessions). Groups are zellij tabs.

## Contract design rules

- Creation ops return every id the caller needs (`{groupId, paneId}`); callers address
  by returned handle, never by numeric index (no base-index math, no follow-up probes).
- `listPanes` returns structured `Pane` records; backends own their output parsing, and
  core logic never sees a backend format string.
- IO ops are true primitives (`typeText`/`submitKey`/`capture`). Reliability loops
  (settle, verify, retry) live once in core (index.mjs), never per backend.
- Ops marked `req: true` must exist on every backend (conformance-tested). The rest are
  capabilities: a missing one returns `UNSUPPORTED` through the guarded call path and
  the caller degrades gracefully. A backend gap is an envelope, never a crash.

## Slot correlation is label-first

`spawnPane`/`setLabel` stamp the slot label on the pane and gatherers match on it,
falling back to deriving from cwd only for panes created before labels existed.
Backend storage differs:

- tmux: the sm-owned `@smslot` pane option — deliberately NOT `@cclabel`, which is a
  display slot users' own tooling writes (e.g. a zsh precmd stamping dir:branch).
  Correlation must never read user display text as a slot label.
- zellij: the pane name (`--name` at spawn / rename-pane), which renders on the pane
  frame natively. Default titles ("Pane #3") are filtered out so unlabeled panes never
  read as slots.

## Message delivery protocol (core)

`sendMessage` exists because typing key-by-key into a Claude composer fails two ways:
an embedded newline is an Enter that submits the task half-typed, and a long
paste-detected line is ingested asynchronously, so an immediate Enter lands
mid-ingestion and is dropped. The protocol: flatten to one line, settle, Enter, verify
the composer actually cleared (via an ANSI capture with dim "ghost text" stripped, so
autocomplete suggestions never read as unsent input), retry the Enter once. It returns
true only on verified submit, so callers report "delivered", not "typed".
`resubmitMessage` retries the Enter alone — never re-typing, which would duplicate the
still-pending composer text. Bracketed paste is deliberately not used: it would leak
escape markers into non-TUI targets.

## The one shell-string exception

`streamStart` (the pane mirror's substrate, see docs/http-api.md) is THE named
shell-string exception in the codebase: tmux `pipe-pane` executes its argument via a
shell. Its inputs are validated in the backend regardless of caller (plain-path sink
charset, positive-integer byteCap), and nothing request-derived may ever reach it —
callers pass only their own spool paths. It opens with `-o` so it never clobbers a
pipe someone else owns; replacement of our pipe by another tool is undetectable
(pane_pipe is a boolean) and the mirror then freezes silently — a known limitation.

## Zellij limits vs tmux (v1)

No pane pid (`sm worker kill` degrades with a clear message), no `arrangeLayout`
(zellij tiles on its own), and no foreground-command report — shell-pane liveness
falls back to a last-line prompt heuristic on a screen capture. Every entry-point op
is gated on zellij >= 0.44.0. Backends are built-in only; user mux plugins can come
when a third multiplexer actually exists.
