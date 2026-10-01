# lib/slots

The slot domain. A slot is a git worktree plus (usually) a multiplexer pane running a
worker. This directory owns everything about slot state: gathering it, classifying it,
claiming it, journaling fleet facts about it, and triaging what workers report back.
The dispatcher (desk) consumes these primitives via lib/commands and the MCP/HTTP
surfaces (see docs/http-api.md and docs/architecture.md).

## Modules

- `pure.mjs` - pure, zero-IO logic: `--slots` spec resolution, pane-to-label mapping,
  freeness classification, lock staleness, dispatch slot picking, role detection,
  issue-id parsing, kill-target and reload-packing decisions. Unit-tested without
  tmux, git, or processes.
- `gather.mjs` - state gatherers: mux/git/gh/filesystem state about slots, and the
  composite freeness scan (`slotFreenessRows`). All pane state comes through the mux
  backend as structured records; no multiplexer format strings here.
- `locks.mjs` - the worktree document (`.worktree-lock`) lifecycle: claim, worker, and
  turn sections, the serialized write protocol, pid identity, and embedded resource
  locks.
- `journal.mjs` - the per-repo turn journal: append-only JSONL of fleet facts with
  durable appends, rename-based rotation, and an fs.watch subscription.
- `verbs.mjs` - the worker-to-dispatcher report vocabulary (`done:`, `blocked:`, ...)
  and the pure absorb/surface policy (`classify`) behind watch/loop supervision.

## The worktree document (locks.mjs)

- `.worktree-lock` is the slot's single state-of-record file, in sections: `claim`
  (the lock: dispatch claims, reset/unlock release), `worker` (the conversation bound
  to the slot), `turn` (an in-flight session turn). The filename is grandfathered
  legacy naming. `readLock` keeps its historical contract: the flat claim, or null
  when unclaimed.
- Every mutation flows through `mutateDoc`: an O_EXCL tmp file is simultaneously the
  write mutex and the atomic-write vehicle (fsync, then rename over the document).
  There is no unserialized write path. A crash at any step leaves the old document or
  the new one, never a torn file.
- Stale mutexes and rotation locks are broken by rename, never by unlink: exactly one
  breaker wins, and two unlinking waiters cannot destroy a third's fresh mutex.
- The document and its embedded resource-lock records are versioned with elevator
  ladders: reads normalize any older on-disk version to the current schema. Append a
  new elevator step when the schema changes; never edit a shipped step.
- Holder liveness is pid identity (pid plus process start-time token). Probes fail
  toward ALIVE: misjudging safe-ward refuses a turn, misjudging unsafe-ward corrupts
  a session.
- Resource locks (shared browser, ports, proxies) live in the claim's `resources`
  array; there is no second lockfile. Mutual exclusion is a scan across all slot
  documents - a deliberate single-user-scale tradeoff (TOCTOU possible under two
  simultaneous claims).

## The journal (journal.mjs)

- Append-only history, never a mailbox: the inbox (lib/inbox.mjs) stays the
  consumption channel.
- Appends validate against the record schema, are single O_APPEND writes (atomic at
  these sizes, so no lock), and are fsync'd before being reported: a record reported
  durable is on disk. The caller owns the degrade policy on failure.
- Rotation is the only rewrite-shaped operation: rename the live file to `.1` under
  an O_EXCL rotation lock, keeping one generation. It fails closed - a live holder or
  any doubt means skip; the next append retries.
- An append racing a rotation re-appends to the fresh live file; the possible
  duplicate is absorbed by readers' identity dedup (ts+type+slot).

## Classification and supervision (pure.mjs, gather.mjs, verbs.mjs)

- The lock is authoritative over any git-state guess: a live claim beats "looks
  free", and a reusable-looking slot with a live, actively working worker is not free.
- Unknown evidence fails safe: an uncomputable ahead-count never reads as zero, and a
  failed mux snapshot reads as ok:false, never as "every worker vanished".
- Report verbs are parsed at read time and never persisted, so the inbox schema stays
  unbumped and a version-skewed reader can never drop new reports as malformed.
- `classify` is pure and stateless: same evidence in, same classification out. Its
  only cross-run memory is journal facts and the surfaced watermark passed in. A
  report with no verb SURFACES - unknown demands attention.
