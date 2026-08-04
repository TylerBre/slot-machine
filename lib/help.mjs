// Human-facing help/usage/vocabulary/role text (prose only - no config).

// Per-namespace overview blocks. Composed into USAGE below and printed individually by
// `sm help <namespace>` / `sm <namespace> --help` - one source, no drift.
export const SECTIONS = {
  repo: `repo - the git repos sm manages
  ls                      known repos (current marked with *)
  use REPO                select the current repo; root/prefix/session/base derive from it
  inspect [REPO]          one repo's resolved context (current by default)
  rm REPO                 forget a repo (config only; nothing on disk is touched)
  config [--agent A] [--model M]   set the current repo's default agent instance/model`,

  session: `session - the tmux session
  ls                      list the repo's running sessions
  create [N] [name]       build/attach the session
  attach [NAME]           attach/switch to a session (default: most recent; bare 'sm' too)
  detach [NAME]           detach your client (or every client of NAME)
  reload [NAME]           add panes for slots created after the session was built
  kill NAME|--all         kill session(s); conversations survive on disk`,

  slot: `slot - the worktree inventory
  ls [--free|--watch]     classify each slot: free/merged (reusable) vs busy
  inspect SLOT            one slot in depth: branch, worker, lock, PRs
  focus SLOT|-f           jump the tmux client to a slot's pane
  create LABEL [base]     create a slot worktree
  rm LABEL                remove a slot worktree
  reset SLOT              return a slot to a clean base branch
  config LABEL [--agent A] [--model M]   set a slot's agent-instance/model override`,

  worker: `worker - the coding-agent processes in the slots (Claude by default)
  ps                      every worker at a glance: live/dead, activity, current task
  run MESSAGE             hand a task to the first reusable slot
  wait [-s SPEC]          block until the targeted workers finish working (the fan-out barrier)
  logs SLOT [-n N] [-f]   one worker in depth: activity, last message, pane tail
  kill SLOT [--force]     end a worker's process; its pane falls back to a shell
  role                    the desk->slots operating model (your role + how to work)
  preflight               assert cwd is your slot worktree, not the main checkout (workers)`,

  msg: `msg - the back-channel, both directions
  send MESSAGE            type a line into slot panes (all, a subset, or -f first-free)
  report "MSG"            worker -> dispatcher: post to the repo inbox
  inbox                   dispatcher reads worker reports (alias: msg ls)`,

  lock: `lock - slot + shared-resource locks (one lockfile: resources live in the worktree lock)
  ls                      list held resource locks (holder, age, task)
  claim NAME [task]       lock a slot OR claim a shared resource (e.g. browser) for a slot
  release NAME            the inverse of claim
  prune SLOT...|--stale   remove stale worktree locks`,

  agents: `agents - the global agent roster (~/.config/slot/config.json)
  ls                      every instance: base plugin, exposed models, load status
  dir [PATH]              show/set the dir relative --plugin paths resolve against
  add NAME [opts]         add an instance (--use/--plugin), or augment a built-in
  rm NAME                 remove an instance (refused if another instance uses it)`,
};

// Top-level overview (sm --help). Deliberately scannable - per-command detail + examples
// live in HELP below, reachable via `sm <ns> <cmd> --help` or `sm help <ns> [cmd]`.
export const USAGE = `sm - slot machine: tmux + git-worktree orchestration for your coding-agent fleet

Point sm at a git repo; the repo's sibling worktrees are its "slots". sm builds a tmux
session with one worker pane per slot plus the "desk" window you dispatch from,
and gives you commands to see which slots are free, hand work to workers, and reclaim
slots - across repos. Rigid definitions: sm help vocab.

Usage: sm <namespace> <command> [args]     ('sm help <namespace> [command]' for detail;
                                            bare 'sm' re-attaches the most recent session)

Top level
  doctor                  check environment + repo health
  floor                   one-shot fleet snapshot: sessions, slots, locks, inbox
  journal                 the repo's turn journal: what happened, when, to which worker
  stats                   command usage: counts, error rates, timings (what to optimize)
  version                 build + runtime info: version, node, install, MCP entry, repo
  help [ns] [command]     this overview, a namespace, or one command in detail
  help vocab              the vocabulary: repo / slot / worker / desk / dispatcher

${SECTIONS.repo}

${SECTIONS.session}

${SECTIONS.slot}

${SECTIONS.worker}

${SECTIONS.msg}

${SECTIONS.lock}

${SECTIONS.agents}

Global flags: --repo DIR (one-off repo), --json (machine output on most commands), --help/-h.

Repos (multi-repo): everything derives from a repo's main-worktree dir -
  root = the parent (slots are siblings), prefix = <name>-slot-, session = <name>, base =
  the default branch. 'sm repo use <repo>' selects one; config at ~/.config/slot/config.json.

Layout (N = panes per window):
  N=3 -> desk | slot-a,b,c | slot-d,e,f | slot-g,h,i | slot-j,k
  N=4 -> desk | slot-a,b,c,d | slot-e,f,g,h | slot-i,j,k`;

// Detailed, example-rich help per command, keyed by canonical route. Printed by
// `sm <ns> <cmd> --help` / `sm help <ns> <cmd>`.
export const HELP = {
  'repo ls': `sm repo ls

The known repos, with the current one marked *. 'sm repo use' adds/selects; 'sm repo rm'
forgets.

Options
  --json   print { current, repos } as JSON

Examples
  sm repo ls`,

  'repo use': `sm repo use REPO [--prefix P] [--session S] [--base B]

Select the current repo - the git repo every other command acts on. A repo's context is
derived from its main-worktree dir:
  root         the repo's parent dir (slots are created as siblings)
  prefix       <name>-slot-   (repo 'acme' -> worktrees acme-slot-a, -b, ...)
  session      <name>         (tmux sessions <name>2 / <name>3 / <name>4)
  base branch  the repo's default branch (origin/HEAD), else 'main'

Options
  --prefix P    override the derived worktree/branch prefix
  --session S   override the derived tmux session prefix
  --base B      override the derived base branch
  --json        print the resolved repo as JSON

The selection persists in ~/.config/slot/config.json. For a one-off without switching, pass
--repo DIR on any command instead.

Examples
  sm repo use ~/Documents/acme                       select a repo
  sm repo use ~/code/foo --prefix wt- --base master  override derived values
  sm --repo ~/code/foo slot ls                       one-off, no switch`,

  'repo inspect': `sm repo inspect [REPO]

One repo's resolved context: name, dir, root, prefix, session prefix, base branch. Defaults
to the current repo; pass a path for another known one.

Options
  --json   print the record as JSON

Examples
  sm repo inspect
  sm repo inspect ~/code/foo`,

  'repo rm': `sm repo rm REPO

Forget a repo: removes it (by path or name) from ~/.config/slot/config.json. Config only -
worktrees, branches, and sessions are untouched. Clears the current selection if it pointed
here.

Options
  --json   print the result as JSON

Examples
  sm repo rm ~/code/foo
  sm repo rm foo`,

  'repo config': `sm repo config [--agent NAME] [--model M]

Set the current repo's default agent instance and/or model - the fallback every slot
resolves to unless it has its own override (see 'sm slot config'). NAME must be a built-in
(claude) or an instance declared in the roster ('sm agents ls'); M must be one of the
instance's exposed models (skipped when the instance's models are open).

Options
  --agent NAME   the repo's default agent instance
  --model M      the repo's default model
  --json         print { repo, agent, model } as JSON

Examples
  sm repo config --agent claude
  sm repo config --agent claude --model opus
  sm repo config --model sonnet`,

  'slot create': `sm slot create LABEL [base] [--agent NAME] [--model M]

Create a new slot: a git worktree at <root>/<prefix><LABEL> on a fresh branch <prefix><LABEL>,
forked from origin/<base> (default: the repo's base branch). Use it to bootstrap the first
slot on a new repo, then again per additional slot. App setup (ports, .env) is still yours.
Pass --agent/--model to pin this slot to an agent instance/model different from the repo's
default (equivalent to creating the slot, then 'sm slot config LABEL --agent ... --model ...').

Arguments
  LABEL    the slot's short name (a, b, ... or any label); a leading prefix is stripped
  base     branch to fork from (default: the repo's base branch)

Options
  --agent NAME   pin this slot to an agent instance (default: the repo's default)
  --model M      pin this slot to a model (default: the instance's default)
  --json         print the created slot as JSON

Examples
  sm slot create a                     first slot off the base branch
  sm slot create hotfix release        a slot forked from 'release'
  sm slot create a; sm slot create b; sm slot create c    bootstrap three, then: sm session create
  sm slot create a --agent enterprise-claude --model opus    pin a's instance + model`,

  'slot config': `sm slot config LABEL [--agent NAME] [--model M]

Set a slot's agent-instance and/or model override, taking precedence over the repo's default
('sm repo config') for that one slot. NAME must be a built-in (claude) or an instance declared
in the roster ('sm agents ls'); M must be one of the instance's exposed models (skipped when
the instance's models are open).

Options
  --agent NAME   the slot's agent instance override
  --model M      the slot's model override
  --json         print { repo, slot, agent, model } as JSON

Examples
  sm slot config a --agent claude --model opus
  sm slot config a --model sonnet`,

  'slot rm': `sm slot rm LABEL [--force]

Remove a slot's worktree (git worktree remove). The branch is kept - delete it yourself if
done with it. Refuses a slot held by a live session or with uncommitted changes unless --force.

Options
  --force   remove even if live-locked or dirty (discards uncommitted changes)
  --json    print the result as JSON

Examples
  sm slot rm a
  sm slot rm a --force`,

  'session create': `sm session create [N] [session-name] [--kill]

Build the repo's tmux session (or attach if it exists): the first window is the "desk"
shell you dispatch from; the rest run each slot's agent (Claude by default), N panes per window.
Needs at least one slot (see 'sm slot create').

Arguments
  N              panes per slot window: 2, 3, or 4 (default 3)
  session-name   tmux session name (default: <session-prefix><N>, e.g. acme3)

Options
  -k, --kill     kill this session first, then rebuild it clean

Each pane runs 'claude -c' (resume) or 'claude' (fresh). Killing tmux never touches the
conversations - they live on disk and resume on the next build.

Examples
  sm session create                 build/attach the default (3 panes/window)
  sm session create 4               4 panes per window
  sm session create 3 acme3 -k      rebuild 'acme3' clean`,

  'msg send': `sm msg send MESSAGE [-s SPEC | -f] [--brief] [--until-idle] [-t SESSION]

Type one line into slot panes with VERIFIED submission (the composer must clear; panes that
typed but never submitted are warned about and left unclaimed), then exit. By default it
goes to every slot; target a subset with -s, or the first reusable slot with -f. MESSAGE is sent
literally, so a leading '/' hits the agent's slash-command handling; a message starting with '-' needs a
guard: sm msg send -- "-oops".

Options
  -s, --slots SPEC   target a subset: comma list of exact labels (a, hotfix), 1-based
                     numbers (1 = first slot), or ranges (d-f, 3-6); mixable. Default: all.
  -f, --first-free   send to the first reusable slot with a live worker (resets a merged one
                     to a clean base first). Mutually exclusive with -s.
  --brief            with -f (or a single -s target), prepend a one-line 'run sm worker role'
                     pointer so a fresh worker orients itself first.
  --until-idle       for targets that typed but did not submit (worker busy), keep retrying the
                     submit on an interval until every composer accepts it, or a ~10m timeout.
  -t, --session S    target session (default: the sole running <name>*; if several run, msg
                     lists them and stops).
  --json             print { sent, unsubmitted, missing } as JSON (sent = verified submits)

Examples
  sm msg send "/clear"                     broadcast to every slot
  sm msg send "rebase on main" -s a,c,e    to slots a, c, e
  sm msg send "/compact" -s 1,3,5-6 -t acme4
  sm msg send -f "fix ABC-123"             hand to the first free slot
  sm msg send -f --brief "fix ABC-123"     same, but brief the worker first
  sm msg send -- "-n means dry run"        send a leading-dash message`,

  'worker run': `sm worker run MESSAGE [--brief] [-t SESSION]

The dispatcher's hand-off verb: send MESSAGE to the first reusable slot with a live worker,
resetting a merged one to a clean base first. Equivalent to 'sm msg send --first-free'; see
'sm msg send --help' for the full flag set.

Examples
  sm worker run "fix ABC-123"
  sm worker run --brief "start the auth refactor: <ticket link>"`,

  'worker wait': `sm worker wait [-s SPEC] [--timeout SEC]

Block until the targeted workers finish - the dispatcher's "wait for the fan-out to land" step.
Polls each targeted slot and returns once none is actively WORKING (idle, a waiting prompt, or a
dead worker all count as settled). Default: every slot; narrow with -s. Exits non-zero if the
timeout hits while any is still working, listing which. Pair it with 'sm worker run' to dispatch
a batch and then block for the results.

Options
  -s, --slots SPEC   only wait on a subset (same spec as msg send: a, 1,3, a-c); default all
  --timeout SEC      give up after SEC seconds (default 1800 = 30 min), exit 1
  --json             print { waited, done, busy, rows } as JSON

Examples
  sm worker wait                       block until every worker is idle
  sm worker wait -s a,c,e              only those three
  sm worker run "task A"; sm worker run "task B"; sm worker wait   dispatch a batch, then block`,

  'slot ls': `sm slot ls [--free | --watch]

Classify every slot from its git branch + GitHub PR state (not just the lock file), sorted by
slot. Columns: slot | status | [worker] | issue | pr | branch. The issue column shows the
tracker id (from the lock, else parsed from the branch); the pr column shows each PR with its
state (e.g. '#4487 merged'), so a merged PR is visible even on a locked slot. The worker column
shows only when a slot's agent has died (its pane fell back to a shell).

Status values
  free           reusable - idle on its base branch
  merged         reusable - all PRs for the branch are merged
  waiting-merge  busy - open PR
  wip            busy - commits ahead of the base branch, no PR yet
  unknown        busy - cannot resolve origin/<base> to count commits ahead (fails safe as busy)
  dirty          busy - uncommitted changes
  closed-pr      busy - PR closed without merging
  locked         busy - a live session holds the worktree
  stale          busy - locked, but the owner session is dead (reclaim: sm lock prune)
  active         busy - a live worker is actively working the slot (no branch/lock yet)

Options
  --free, -q       print just the free slot letters (space-separated), for scripting
  --watch/--follow live-refresh the table every 5s (Ctrl-C to stop)
  --json           print all rows as JSON

Examples
  sm slot ls
  sm slot ls --watch
  for s in $(sm slot ls --free); do echo "free: $s"; done
  sm slot ls --json | jq '.[] | select(.free) | .slot'`,

  'slot inspect': `sm slot inspect SLOT

Everything about one slot: branch, git state (dirty / commits ahead of the base), worker
(live/dead), lock owner with LIVE/STALE age (flags a cross-wired lock pointing at another
slot), and every PR for its branch.

Options
  --json   print the full record as JSON

Examples
  sm slot inspect c
  sm slot inspect c --json`,

  'worker ps': `sm worker ps [--watch]

Every worker at a glance - the dispatcher's cheap poll. One row per slot: worker (live /
dead / none), activity (working / idle / waiting, from the pane), and the task its lock
carries. Reads only tmux + lock files, so it is instant; use 'sm slot ls' when you need
reusability (git branch + PR state).

Options
  --watch/--follow   live-refresh every 5s (Ctrl-C to stop)
  --json             print the rows as JSON

Examples
  sm worker ps
  sm worker ps --watch
  sm worker ps --json | jq '.[] | select(.activity == "waiting")'`,

  'worker logs': `sm worker logs SLOT [-n LINES] [-f]

One worker in depth without switching to it: its working/idle/waiting state, its last
assistant message, and the tail of its pane.

Options
  -n, --lines N        pane lines to show (default 20)
  -f, --follow/--watch re-render every 2s (Ctrl-C to stop)
  --json               print state + tail as JSON

Examples
  sm worker logs h
  sm worker logs h -n 50
  sm worker logs h -f`,

  'worker kill': `sm worker kill SLOT

End one worker's process. The pane falls back to its shell (the worker shows dead in
'sm worker ps') and the session stays intact; the conversation survives on disk, so a
later 'claude -c' in that pane resumes it. Kill sessions with 'sm session kill'. Refuses a worker
that is actively working unless --force (killing one mid-task loses in-flight work).

Options
  --force   kill even a worker that is actively working (default: refuse a busy worker)
  --json    print the result as JSON

Examples
  sm worker kill h
  sm worker kill h --force`,

  'slot reset': `sm slot reset SLOT [--force] [--hard-worker]

Return a slot to a clean base branch at origin/<base> - how you reclaim a merged slot for new
work. Refuses a slot held by a live session, with uncommitted changes, or with a session turn
in flight, unless --force. The slot's worker (its conversation identity, recorded in the
worktree document) SURVIVES a reset - the agent resumes where it left off; --hard-worker
clears it too, so the next dispatch starts a fresh conversation.

Options
  --force        reset even if live-locked, dirty, or mid-turn (discards uncommitted changes)
  --hard-worker  also clear the worker record - fresh conversation on next dispatch
  --json         print the result as JSON

Examples
  sm slot reset f
  sm slot reset f --force
  sm slot reset f --hard-worker`,

  'lock claim': `sm lock claim NAME [task]

Lock a slot or claim a shared resource. A NAME matching a slot worktree writes its .worktree-lock
(mark busy - worker run / msg send do this automatically). Any other name is a MACHINE-LEVEL RESOURCE
(e.g. 'browser' for the shared authenticated Playwright browser): the claim is recorded IN the
holding slot's worktree lock - there is no second lockfile. A resource is held by one slot at a time;
the loser sees which slot holds it. Claim from within a slot (or pass -s SLOT); the slot must already
be locked. Workers: claim the resource BEFORE using it, release it right after.

Arguments
  NAME    a slot label, or a resource name (multi-char; single chars must be real slots)
  task    optional short label stored in the lock (shown by slot inspect / lock ls)

Options
  -s, --slot X      the slot that holds the resource (default: the current slot from cwd)
  -w, --wait        queue: retry until the resource frees (up to 10 min)
  --force           steal the lock (also auto-steals when the holder's worker is demonstrably dead)
  -t, --session S   record the tmux session on a slot lock (informational)
  --json            machine-readable result (exit 1 when not acquired)

Examples
  sm lock claim f "ABC-123"          mark slot f busy
  sm lock claim browser "ABC-9584 shot"    take the shared browser
  sm lock claim browser --wait      queue for the browser
  sm lock release browser           give it back`,

  'lock release': `sm lock release NAME

Free a slot's .worktree-lock, or release a shared resource the holding slot holds - the inverse of
claim. 'sm slot reset' also releases the slot lock as part of reclaiming a slot.

Options
  --json   print the result as JSON

Examples
  sm lock release f
  sm lock release browser`,

  'lock ls': `sm lock ls

List held resource locks: resource, holding slot (live/dead), age, task. Slot worktree locks
show in 'sm slot ls' instead. A dead holder is auto-stolen by the next 'sm lock claim'.

Options
  --json   machine-readable

Examples
  sm lock ls`,

  'slot focus': `sm slot focus SLOT | -f

Jump the tmux client to a slot's pane (selects its window + pane, prefers the attached
session, switches/attaches as needed). Alias: sm slot open.

Options
  -f, --first-free   focus the first free slot instead of a named one
  --json             print the resolved session/window/pane instead of switching

Examples
  sm slot focus h       jump to slot h
  sm slot focus -f      jump to the first free slot
  sm slot open h`,

  'lock prune': `sm lock prune SLOT... | --stale [--dry-run] [--older-than N] [--force]

Remove stale worktree locks - a lock is stale when its owner session is dead (transcript gone
or quiet past the threshold). Live locks are kept unless --force.

Selection
  SLOT...          unlock the named slot(s)
  --stale          clear every dead lock at once

Options
  --dry-run        show what would be unlocked, remove nothing
  --older-than N   staleness threshold in minutes (default 30)
  --force          remove even live locks (use with care)
  --json           print the result as JSON

Examples
  sm lock prune c
  sm lock prune --stale --dry-run        preview
  sm lock prune --stale                  drop every dead lock
  sm lock prune --stale --older-than 60`,

  'worker role': `sm worker role [dispatcher | worker]

Print the desk->slots operating model - your role and how to work within it. Auto-detects
which briefing to show: dispatcher when run from the desk window, slot worker when run
inside a slot worktree. Pass a role name to force one.

Options
  --json   print the role + briefing text as JSON

Examples
  sm worker role          auto-detected briefing
  sm worker role worker    force the slot-worker briefing`,

  'worker preflight': `sm worker preflight [--json]

A slot worker's guard: confirms the current directory is your own slot worktree before you do any
git work. Exits 0 when you are in a slot; exits 1 (with a loud message) when you are in the main
checkout or anywhere else. Chain it so a stray cwd stops the work instead of polluting the wrong
repo:  sm worker preflight && git switch -c my-branch

Options
  --json   print { ok, status, slot, cwd } as JSON

Examples
  sm worker preflight                        confirm you are safely in your slot
  sm worker preflight && git commit -am ...  gate a commit on being in the right worktree`,

  'msg report': `sm msg report "<message>"

A slot worker's back-channel to the dispatcher. Run it from inside a slot worktree; it detects
which slot you are and appends your message to the repo inbox, which the dispatcher reads with
'sm msg inbox'. Use it to report done (with the PR link + confidence), surface a blocker, or ask a
question - instead of relying on the dispatcher scraping your pane.

Options
  -s, --slot X   record a specific slot (default: auto-detected from cwd)
  --json         print the result as JSON

Examples
  sm msg report "done: ABC-123 -> PR #42, 96%"
  sm msg report "blocked: need a product decision on the Verified field semantics"`,

  'msg inbox': `sm msg inbox [-n N] [--newest-first] [--watch] [--clear]

The dispatcher reads the messages workers sent via 'sm msg report', oldest-first with slot + age.

Options
  -n, --number N   show only the most recent N reports
  --newest-first   newest report first (default: oldest first)
  --watch          subscribe: block until a new report lands (push via fs events, not polling),
                   print it, and exit - run it in the background to get re-invoked per report.
                   Combined with --clear, the delivered reports are consumed on exit
  --clear          print, then empty the inbox (consume)
  --json           machine-readable

Examples
  sm msg inbox
  sm msg inbox -n 5 --newest-first
  sm msg inbox --clear
  sm msg inbox --watch`,

  'doctor': `sm doctor [--fix]

Detect + verify the whole setup: tmux/git/gh/node/claude present, gh authenticated, tmux
pane titles configured (so worker panes are tellable-apart), the bin symlinks in
~/.local/bin, PATH, each in-use agent's MCP registration, the resolved repo config and where
each value came from, root dir, slots found, and whether the base branch resolves. Exit is
non-zero when something is broken; each warn line names its own fix.

Options
  --fix        install what is safely automatable, then re-verify: the ~/.local/bin
               symlinks (never clobbers a real file), the tmux pane-title block (a
               marked, idempotent block in your tmux.conf, applied live to a running
               server), and MCP registration (claude mcp add slot-machine)
  --fix-tmux   only the tmux pane-title block
  --json       print the full report as JSON

Examples
  sm doctor
  sm doctor --fix
  sm doctor --json`,

  'floor': `sm floor [--watch]

One-shot fleet snapshot - the dispatcher's situational-awareness call. Running sessions,
one row per slot (worker live/dead/none, activity, how it is driven (via), lock + task),
held resource locks, and the unread inbox count, in a single command instead of four
(session ls + worker ps + lock ls + msg inbox). Cheap: multiplexer + lockfiles only, no
git/gh - 'sm slot ls' stays the authority on which slots are reusable.

Options
  --watch    redraw the snapshot on an interval until Ctrl-C (alias: --follow)
  --json     print the snapshot as JSON

Examples
  sm floor
  sm floor --watch
  sm floor --json | jq '.slots[] | select(.worker == "dead")'`,

  'journal': `sm journal [--tail N] [-s SLOT]

Read the repo's turn journal: the append-only record of fleet facts - worker-created,
task-dispatched, turn-started/completed, worker-replaced - newest last. The journal is
history (never consumed); the inbox is the mailbox for messages that need reading. Lives
at ~/.config/slot/journal/<repo>.jsonl, fsync'd on every append, rotated by size.

Options
  --tail N   only the last N records (default 20; 0 = all)
  -s SLOT    only records about one slot
  --json     print the records as JSON

Examples
  sm journal
  sm journal -s a --tail 50
  sm journal --json | jq 'map(select(.type == "task-dispatched"))'`,

  'stats': `sm stats [--days N] [--clear]

Per-command usage from the local log (every invocation records command, duration, ok/error,
repo, and tty vs scripted - no args or message content). Shows what actually gets used, what
errors, and what's slow enough to be worth optimizing. Local-only; file at
~/.config/slot/usage.jsonl.

Options
  -d, --days N   only count the last N days
  --clear        print, then reset the log
  --json         machine-readable rows

Examples
  sm stats
  sm stats --days 7
  sm stats --json | jq 'map(select(.errors > 0))'`,

  'version': `sm version

The build + runtime identity of this install: slot-machine version, node version, the install
directory and where it came from (a git sha when run from a checkout, else 'packaged'), the MCP
entry point, and the current repo. 'sm --version' / '-V' stays the bare version number; this is
the full readout. Works even when the config is broken (like doctor), so you can identify the
build while diagnosing.

Options
  --json   print { version, node, install, source, mcp, repo } as JSON

Examples
  sm version
  sm version --json`,

  'session ls': `sm session ls

List the repo's running tmux sessions (name, windows, slot count, whether attached).
Alias: sm session list.

Options
  --json   print the sessions as JSON

Examples
  sm session ls`,

  'session attach': `sm session attach [NAME]

Attach the client to a running session - or switch to it when already inside tmux. With no
NAME, picks the most recently active session of this repo, so it continues where you left
off. Bare 'sm' is a shorthand for exactly this.

Options
  --json   print the session it would attach (resolve-only, does not attach)

Examples
  sm                         continue the most recently used session
  sm session attach acme4    attach a specific one`,

  'session reload': `sm session reload [NAME]

Bring a running session up to date with the slot inventory: every slot that has no pane
gets one appended (a fresh worker pane, resuming that slot's conversation if it has one),
packed like the existing windows. Existing panes are untouched. To change the packing
itself (2 -> 3 panes per window), rebuild instead: sm session create 3 -k - conversations
survive on disk and resume.

Options
  --json   print { session, added } as JSON

Examples
  sm slot create o && sm session reload    grow the fleet without a rebuild`,

  'session detach': `sm session detach [NAME]

Detach tmux clients. Inside tmux with no NAME, detaches your own client. With NAME (or when
exactly one session runs), detaches every client attached to it - useful for freeing a
session grabbed on another terminal.

Options
  --json   print the result as JSON

Examples
  sm session detach          let go of the current session
  sm session detach acme3    kick every client off acme3`,

  'session kill': `sm session kill SESSION... | --all

Kill tmux session(s). Ends the panes' agent processes; a resumable agent's conversation
survives on disk and resumes on the next 'sm session create' (Claude does).

Selection
  SESSION...   kill the named session(s)
  --all        kill every matching <name>* session

Options
  --json   print the result as JSON

Examples
  sm session kill acme3
  sm session kill --all`,

  'agents ls': `sm agents ls

The agent roster: built-in and user-added instances, each with its base plugin, exposed
models, and source (user vs built-in). A user plugin that fails to load is listed under
problems (with its name + reason) and skipped, rather than blocking the rest of the roster.

Options
  --json   print { agents, problems } as JSON

Examples
  sm agents ls`,

  'agents dir': `sm agents dir [PATH]

Show or set the global directory that relative --plugin paths resolve against (default:
~/.config/slot/agents). Persisted in ~/.config/slot/config.json.

Arguments
  PATH   the new agents dir; omit to just print the current one

Options
  --json   print { agentsDir } as JSON

Examples
  sm agents dir                show the current agents dir
  sm agents dir ~/my-agents    set it`,

  'agents add': `sm agents add NAME [--use PLUGIN | --plugin PATH] [--env K=V ...] [--models M1,M2]
             [--default-model M] [--mcp FILE]

Add a roster instance, or configure a built-in's defaults. For a new name, exactly one of:
  --use PLUGIN     alias another instance/built-in - inherits its plugin code
  --plugin PATH    a new user plugin module (relative to 'sm agents dir', or absolute)
is required. A built-in name (e.g. claude) with neither is an allowed augment - it sets
env/models/mcp on the built-in without replacing its code. A built-in name cannot take
--plugin (that would shadow its shipped code; use --use to fork a new name off it instead).

Options
  --use PLUGIN         base this instance on an existing instance/built-in's plugin code
  --plugin PATH        a new user plugin module
  --env K=V            an env var for this instance (repeatable)
  --models M1,M2       comma-separated models this instance exposes (default: any)
  --default-model M    the model used when a slot/repo does not pin one
  --mcp FILE           a JSON file of MCP server entries for this instance
  --json               print { added, entry } as JSON

Examples
  sm agents add enterprise-claude --use claude --env CLAUDE_CONFIG_DIR=~/.claude-work
  sm agents add claude --models sonnet,opus            configure the built-in's models
  sm agents add my-agent --plugin my-agent.mjs         a new user plugin`,

  'agents rm': `sm agents rm NAME

Remove a roster instance. Refused when another instance names it in --use - the error lists
the dependents; repoint or remove those first.

Options
  --json   print { removed } as JSON

Examples
  sm agents rm enterprise-claude`,
};

/**
 * Resolve help text by canonical key (the router resolves aliases first): '' -> the overview; a namespace -> its section; a route -> its detail.
 * @param {string} key - the canonical help key (aliases already resolved by the router).
 * @returns {string} the matching help text.
 */
export function helpFor(key) {
  if (!key)
    return USAGE;
  if (key === 'vocab')
    return VOCAB;
  if (SECTIONS[key])
    return `${SECTIONS[key]}\n\n('sm help ${key} <command>' for detail + examples)`;
  return HELP[key] || `sm: no help for '${key}'\n\n${USAGE}`;
}

// slot machine's rigid vocabulary, printed by `sm help vocab` and referenced from README.
export const VOCAB = `vocabulary - slot machine's definitions (rigid on purpose)

  repo        the git repo a session is built around; everything derives from it
  slot        one worktree of the repo; holds at most one worker and one track of work
  worker      the coding-agent process in a slot's pane (Claude by default); one slot's work
  desk        the session's first window; the seat the dispatcher runs the session from
  dispatcher  the role at the desk: finds capacity, hands off, checks in, reclaims -
              never edits a slot
  session     the tmux session laying out the desk + slot panes for one repo
  lock        a claim on a slot (.worktree-lock) or on a shared machine resource
              (e.g. the authenticated browser)

Roles in depth: sm worker role [dispatcher|worker]`;

// The desk -> slots operating model, printed by `sm worker role` (and the sm_worker_role MCP tool).
export const ROLE_DISPATCHER = `You are the DISPATCHER - you run this slot-machine session from the desk (its first window).
You supervise; you do not do feature work yourself. Each slot holds one worker (a coding-agent
process, Claude by default) doing one task in its own git worktree. Your job is to keep them fed and unblocked.

Your loop:
  1. Find capacity   sm slot ls              (free/merged = reusable; anything else is busy)
  2. Hand off        sm worker run "<task + ticket link>"   (auto-picks a free slot)
                     sm msg send "<task>" -s <slot>            (or target a specific slot)
  3. Check in        sm msg inbox --unread    (reports since you last read - non-destructive; entries
                                              are verb-tagged: done/blocked/needs-decision/failed = act,
                                              working/paused = note, no verb = look at it)
                     sm worker ps             (every worker: live/dead, activity, task)
                     sm worker logs <slot>    (one worker in depth: last message + pane tail)
                     sm slot inspect <slot>   (branch, lock, PRs)
  4. Reclaim         sm slot reset <slot>      (a merged slot -> clean base branch)
                     sm lock prune --stale    (drop locks whose owner session is dead)

Rules of the model:
  - NEVER edit files inside a slot's worktree. The slot's own worker owns it; respect the
    lock. You delegate and observe - you do not reach in.
  - Trust sm slot ls for "is this reusable" (branch + PR state), not a glance at lock files.
  - When a worker goes idle or waiting (sm worker ps), decide: answer it, or surface it to the
    human. Don't let a blocked slot sit silently.
  - Keep a human in the loop for consequential or outward-facing actions (pushes, merges,
    messaging teammates). Report outcomes honestly - failures included.`;

export const ROLE_WORKER = `You are a WORKER - the coding-agent process for one worktree slot. Do the assigned task here,
and here only.

  - Cut your own feature branch off the base; do the work; open a PR per the repo's
    conventions. One slot, one track of work at a time.
  - Stay in your slot. Do not touch other slots or the main checkout, and do not delete
    your own .worktree-lock. Before any git work (branch/commit/push) run  sm worker preflight
    to confirm cwd is your slot worktree - never branch or commit in the main repo.
  - Do NOT save the dispatcher's broadcast rules to memory - all slots share one memory
    dir, so per-worker copies just bloat it and cause edit conflicts. Follow the rules (they
    are in this briefing); reserve memory for genuine per-task technical learnings.
  - Stop and ASK when you hit a real decision - a contract/behavior change, a risky
    migration, an ambiguous requirement. Do not guess on consequential choices.
  - Report back with  sm msg report "<verb>: <msg>"  - it is part of DONE. Lead with a
    verb so the dispatcher's watch can triage it: done: / blocked: / needs-decision: /
    failed: / working: / paused: (e.g. "done: PR #123, 96%"). Report when you finish
    (PR link + confidence), when you are blocked, and when you find something adjacent
    worth a ticket. Do not leave results sitting in your pane.
  - Commit and push so your work is never stranded locally.
  - When your PR merges, your slot becomes reusable: the dispatcher may reset it and hand
    you fresh work. Leave it in a clean, reviewable state.`;
