# Architecture

## Shape

One Next.js process. The UI and the orchestrator run together, talking to SQLite
and the local filesystem. No external queue, no worker, no broker — a
single-user local tool does not need a distributed system, and adding one would
make every failure harder to see. The exception is deliberately small: landing
uses an in-process FIFO per repository and target branch so two approved runs do
not race to fast-forward the same checkout.

```
┌──────────────────────────── Next.js (127.0.0.1:4317) ────────────────────────┐
│                                                                              │
│  Server components ──────── read ────────┐                                   │
│  Route handlers ─────────── write ───────┤                                   │
│  SSE /api/runs/:id/events ─── tail ──────┤                                   │
│                                          ▼                                   │
│                                    ┌───────────┐                             │
│                                    │  SQLite   │  projects, runs, iterations │
│                                    │ (better-  │  events, changed_files      │
│                                    │  sqlite3) │  validation_results         │
│                                    └───────────┘  artifacts, review_findings │
│                                          ▲                                   │
│  ┌────────────────── orchestrator ───────┴─────────────────────────────┐     │
│  │  transform → prepare → implement → summarise → collect →           │     │
│  │  validate → review → decide                                        │     │
│  └───┬──────────────┬──────────────┬──────────────┬───────────────┬────┘     │
└──────┼──────────────┼──────────────┼──────────────┼───────────────┼──────────┘
       │              │              │              │               │
  Transformer    Git worktree   Implementation  Validation      Reviewer
  (optional)                        agent         engine        (optional)
       │              │              │              │               │
  codex exec /     git worktree  claude -p       project's      codex exec /
  claude -p        add/remove    stream-json     own commands   claude -p
  read-only                                                     read-only
```

## Boundaries

Five seams, each an interface with a registry behind it. The orchestrator knows
only the interfaces.

| Boundary | Interface | V1 implementations |
| --- | --- | --- |
| Implementation agent | `ImplementationAgent` | `ClaudeCodeAgent` |
| Transformer | `TransformerProvider` | `NoopTransformer`, `CodexCliTransformer`, `ClaudeCliTransformer`, `OpenAiTransformer`, `AnthropicApiTransformer` |
| Reviewer | `ReviewerAgent` | `CodexCliReviewer`, `OpenAiReviewer`, `ClaudeCliReviewer`, `AnthropicApiReviewer` |
| Validator | `Validator` | `CommandValidator` |
| Artifact storage | `services/artifacts` | local filesystem + SQLite metadata |
| Attachment storage | `services/attachments` | local filesystem + SQLite metadata |

The two optional layers are optional in the strict sense: with neither
configured, every other part of the application behaves identically. A
transformer that is unavailable or throws produces a `transform.skipped` event
and the run continues with the request as written. A reviewer that fails
produces `review.skipped`. Neither can fail a run.

## Directory map

```
src/
├── core/          ids, errors, data-directory paths, secret redaction
├── domain/        run lifecycle, event catalogue, validation and mode vocabulary
├── db/            drizzle schema, client, generated SQL migrations
├── process/       command execution, process-tree kill, executable resolution
├── git/           git wrapper, diff collection, worktree lifecycle
├── agents/        ImplementationAgent + Claude Code adapter + stream parser
├── transformers/  TransformerProvider + implementations + registry
├── reviewers/     ReviewerAgent + implementations + registry
├── validation/    Validator + the engine that sequences them
├── visualisation/ the implementation map: stored run state → one SVG
├── orchestrator/  the state machine, prompts, working modes, execution profiles
├── services/      projects, runs, events, artifacts, previews, attachments, expiry, bus, bootstrap
├── components/    client components: run view, scorecard, diff, feed, forms
└── app/           routes and API handlers
```

Dependencies point inwards. `core` and `domain` import nothing from the app;
`orchestrator` composes the boundaries; `app` composes the orchestrator.

## Run lifecycle

```
DRAFT ──► PREPARING ──► IMPLEMENTING ──► VALIDATING ──► REVIEWING
                                                            │
                          ┌─────────────────────────────────┴────┐
                          ▼                                      ▼
                    NEEDS_CHANGES ◄──────────────────────────► READY
                          │                                      │
                          └──────────► APPROVED / REJECTED ◄──────┘
                                            │
                                            ▼
                                         LANDING
                                      ┌─────┴─────┐
                                      ▼           ▼
                               MERGE_CONFLICT  LANDED
                                      │
                                      ▼
                                LANDING_FAILED
```

The complete permitted transition table lives in `src/domain/types.ts` and is
enforced by `assertTransition`, which throws on anything not listed. `setStatus`
in `services/runs.ts` is the only write path, and it appends an event on every
change. That is what makes stored state — not a UI flag and not the agent's
opinion — the source of truth.

`DRAFT → READY` is not a legal transition. Nothing can reach `READY` without
passing through implementation and validation.

Statuses are recoverable by design: `NEEDS_CHANGES`, `READY`, `FAILED` and
`CANCELLED` can all re-enter `IMPLEMENTING`, which is what "request changes" on
a failed run does. `APPROVED` can too, and that edge exists for the read-only
modes: a plan has nothing to land, so approving one is a decision to build it
rather than the end of the run, and "Implement this plan" resumes the same
session from there. `APPROVED` can also proceed to `LANDING`. Clean landings reach
`LANDED`; if another run is already landing to the same repository and branch,
the run waits in that branch's landing queue. Stale landing branches are
refreshed from the current target branch in the isolated landing worktree before
validation and fast-forward apply. Conflicted or failed landings get one AI
repair attempt in the landing worktree before Dev Cockpit records manual repair
instructions for an explicit retry.
`LANDED` and `REJECTED` are terminal.

Every non-terminal status can also reach `DRAFT`, and that edge exists for one
caller: a forced restart. `PREPARING` is entered only from `DRAFT`, so a
restarted run walks through the same door a new one does rather than giving the
prepare phase a second set of preconditions to satisfy. Nothing else writes
`DRAFT` — `createRun` inserts it.

## Retry, restart, and the single work slot

Three actions pick a stopped run back up, and they differ in what they keep.
Where a retry resumes is *computed*, in `src/domain/retry.ts`, from the same
stored evidence readiness and the progress bar read — a worktree, an iteration
row, a disposition. Nothing the agent said is consulted, and the run screen
calls the same function to label the button, so the label cannot promise one
thing while the orchestrator does another.

```
planRetry(run) ─► land       when the run is landable (landing keeps its own worktree)
               ─► prepare    when there is no worktree — nothing was done yet
               ─► implement  when no implementation iteration finished
               ─► validate   when one did, so the failure was downstream
```

`retryIteration` is narrower: it re-issues the last implementation iteration's
prompt verbatim, resuming the recorded agent session. `restartRun` is the
forceful one — it stops in-flight work, waits for the process to exit, removes
the worktree, moves the run to the next free `-rN` branch and re-runs the
pipeline cold.

One run gets one work slot, claimed through `begin` in the orchestrator. Every
entry point goes through it, so "is something already running for this run" is
answered in one place. Each slot carries a `settled` promise: aborting a
controller only *asks* the agent to stop, and a restart has to know the process
is genuinely gone before it deletes the worktree that process was running in.

## Working modes

A run executes in one of three modes, chosen per run. The mode decides *what
the run produces*; the execution profile decides *how much effort it spends*.
They compose, and neither is a separate code path — both are tables the
orchestrator reads.

```
                     Ask                Plan               Build
  transform          yes                yes                yes
  prepare worktree   yes                yes                yes
  implement          permission `plan`  permission `plan`  project's permission
  collect diff       yes, empty         yes, empty         yes
  validate           skipped            skipped            project's commands
  review             skipped            skipped            configured reviewer
  decide             answer exists,     plan exists,       validation results,
                     nothing touched    nothing touched    findings, the diff
```

Ask and Plan differ only in the prompt and the deliverable. That is not a
reason to merge them: the prompt is the product. Ask is told to lead with the
answer, cite `file:line`, and not to propose a plan; Plan is told to produce
ordered steps and name its risks. One prompt for both would return every
question as a five-section implementation plan.

`WORK_MODE_BEHAVIOURS` in `orchestrator/modes.ts` holds the phase toggles and
where each deliverable is stored. `domain/modes.ts` holds the vocabulary, the
per-mode wording, and the Auto classifier — the last of which is pure, so the
New Task form can run it in the browser and show what Auto would pick before a
run exists. The wording lives in `domain` because readiness reasons, event
messages and UI copy all need the same nouns, and three copies would drift.

The read-only modes are enforced by the permission mode, not only by the
prompt, and a mode can take capability away but never add it:
`effectivePermissionMode` overrides `bypassPermissions` with `plan`, and never
the reverse.

`runs.mode` is what the user asked for and is never rewritten.
`runs.resolved_mode` is what is executing, and moves when a read-only run is
switched to Build — which resumes the same agent session rather than starting a
new run. The switch is recorded as `run.mode_switched`, which is the audit
trail, as it is for everything else here.

A follow-up iteration is short, because the resumed session still holds the
rules, the task and what it produced. With no session to resume that inverts,
and the prompt carries all three instead — feedback alone would ask a cold
agent to revise work it has never seen. See ADR 0010.

## Readiness

`assessReadiness(run, project)` is a pure function over stored state. It reads
the latest validation attempt, the latest review attempt, the changed-file list
and the project's policies. It never consults the agent's summary, in either
mode.

For a build run it blocks on:

- a blocking validation that failed or errored,
- a validation still running,
- validation never having run, when the project requires it,
- a UI-touching change with no E2E result, when the project requires it,
- a high or critical review finding, only when the project opts in,
- no files having changed.

An Ask or Plan run is judged on two things instead, because none of the above
can say anything about a document: the deliverable exists — from an iteration
that *completed*, since a failed one can still hold partial text — and no file
was changed. The second is the one worth having: both modes promise to change
nothing, so a read-only run with a diff has broken its promise, and that is
precisely what a person needs to see.

Reviewer findings are advisory by default. A model's opinion is not a test
result, and the two are stored in different tables and rendered differently so
they cannot be confused.

The user can still approve a run that is not ready. The dialog lists exactly
what is being overridden. The user is the approver; the point is that overriding
is deliberate rather than accidental.

## Events

Every visible thing that happens is an append-only row in `events`, typed by the
catalogue in `src/domain/events.ts`. Each carries a short human-facing message
and a typed payload.

The UI derives its progress display from these rows rather than from a terminal
transcript, which is why payloads are structured rather than pre-rendered
strings, and why the log can offer filters at all.

`events.seq` is a monotonic integer and doubles as the SSE resume cursor.

The same rows feed two views that answer different questions.
`components/log-stream.tsx` is the Logs tab: every line, oldest first, appended
at the bottom and following the tail — a log, read the way logs are read.
`components/progress-panel.tsx` is the right rail: the phase bar and the newest
line alone, because "what is happening right now" is one line, not a list.

Both draw their lines with `components/log-line.tsx`, which renders a row per
event — a glyph chosen by event type, and the event's own message coloured by
what it means. That row started life in the progress feed and the Logs tab now
uses it too, so a line reads the same in either place; the event type itself is
on hover, not in the row. Event *messages* are redacted when stored; the row
also prints payload prose under the line, so it runs the same patterns
client-side through `core/redact-patterns.ts`.

Above that line, `domain/progress.ts` turns a run's status, the orchestrator's
live phase and the run's own output into a phase bar. It is pure and folds no
events: a bar reconstructed from a replay would disagree with the run record the
moment the replay was truncated.

## Real-time

Two channels, deliberately separate:

- **`GET /api/runs/:id/events`** — SSE. Replays everything after the client's
  cursor in pages of 500, then tails the in-process bus. A reconnect resumes
  from the stored cursor rather than restarting, so a reload or a dropped
  connection loses nothing. Heartbeat comments every 20s keep the stream from
  being timed out.
- **`GET /api/runs/:id/snapshot`** — the current state, in full. Polled every 5s
  while a run is active, because not every phase transition writes an event.
- **`POST /api/runs/:id/preview/start` / `preview/stop`** — starts and stops the
  project's development command in the run worktree, with an allocated local
  port and a log artifact linked back to the preview URL.

Events say *what happened*; the snapshot says *what is now true*. Keeping them
apart means the client never rebuilds run state by folding events, which is
where a live view drifts from the database. Snapshot fetches are coalesced:
status and validation events refresh promptly, tool chatter waits.

The in-process bus is only a wake-up mechanism. Persistence is authoritative, so
a missed notification costs nothing.

## Claude Code integration

Through the supported programmatic interface, not a terminal:

```
claude --print
       --output-format stream-json --verbose
       --session-id <uuid> | --resume <session-id>
       --dangerously-skip-permissions        (default)
         | --permission-mode acceptEdits|plan  (restrictive projects)
       --permission-prompts none
       --model <model> --effort <level>
```

Key decisions, each of which was verified against Claude Code 2.1.263 rather
than assumed:

- **The prompt goes over stdin, never as an argument.** It is untrusted text and
  the largest injection surface; keeping it off every command line removes the
  problem rather than escaping it.
- **`--session-id` is pre-allocated** by the orchestrator, so a resumable id
  exists even if the process dies before emitting its init message.
- **`--resume` keeps the same session id** and its context. This is what makes
  "request changes" continue rather than restart — verified: a follow-up
  iteration referring to "that lookup table you added" resolved correctly and
  took 2 turns where the initial pass took 26.
- **Permission flags come from one place**, `agents/permissions.ts`, which is
  also where the project setting and the `DEV_COCKPIT_PERMISSION_MODE` override
  are reconciled. A mode Claude Code would not recognise is never forwarded.
- **`--dangerously-skip-permissions` is the default posture.** A run is
  unattended, so a permission check has two possible outcomes — bypassed or
  refused — and refusing costs an iteration. ADR 0010.
- **`--permission-prompts none`** is still passed on every mode: anything that
  would block on a prompt is denied instead of hanging a headless run forever.
- Unknown message types are ignored, not treated as errors. The CLI adds them
  over time and a run must not fail because of one.

The wire protocol is parsed by `agents/stream-parser.ts`, which is pure and
directly tested against fixtures captured from real CLI output.

## Process execution

Two different execution paths, for two different threat models:

- **Project-configured commands** run through the platform shell, because
  `npm test` needs `PATHEXT` resolution that bare `spawn` does not do. Only
  project configuration ever reaches here. `CommandSource` exists to record that
  distinction in the database; V1 never records `dynamic`.
- **The agent and the read-only providers** are spawned with an explicit
  argument array and no shell wherever possible. `process/exec.ts` resolves the
  executable, preferring something directly spawnable, and falls back to
  `cmd.exe` with a tested argument quoter only when the only thing on `PATH` is
  a shim.

That fallback exists because of a real Windows constraint: npm installs a CLI as
`claude.cmd`, and Node refuses to spawn a `.cmd` without a shell. `spawn('claude',
…)` fails with `ENOENT` or `EINVAL`. See ADR 0006.

Cancellation aborts an `AbortSignal` that reaches both the agent process and any
running validation command. Both kill their whole process tree — `taskkill /T`
on Windows, a negative-pid group signal elsewhere — because killing the shell
alone leaves the real command running.

## Persistence

SQLite via better-sqlite3, with drizzle-orm as a typed query builder. WAL mode,
foreign keys on, a 5s busy timeout so a long orchestrator write does not throw
`SQLITE_BUSY` at the UI.

Migrations are generated by drizzle-kit into `src/db/migrations` and applied on
first database open. The connection handle is parked on `globalThis` so Next's
dev-mode module reloading does not leak handles.

Timestamps are ISO-8601 text. SQLite has no date type, and text keeps the
database readable by hand.

## Request attachments

Files attached to a request are stored the same way artifacts are — metadata in
SQLite, bytes on disk — but under `data/attachments/<runId>/` rather than
inside `artifacts/`. The two are separated because they travel in opposite
directions: an artifact is output that retention may delete, an attachment is
input and the only copy the app holds. One table each keeps every cleanup path
from having to remember the difference.

They reach the agent as **paths, not contents, and from outside the worktree**.
`readableAttachments` in `orchestrator/prompt.ts` is the single source for
which files count, and two callers depend on agreeing: the prompt lists each
one by absolute path, and `phaseImplement` grants `--add-dir` over the
directory holding them. Outside the worktree because anything inside it lands
in the diff, and an attached log is not a change the developer asked for; paths
rather than contents because the agent should spend context on the part of a
40,000-line log it actually wants.

The transformer boundary is unchanged: it handles prose and never sees a file
path, so a specification is still built from the request text alone.

Mutability follows the run status. `ATTACHMENT_MUTABLE_STATUSES` in
`domain/attachments.ts` is exactly the set that can re-enter implementation, so
a file attached now is one some iteration will still read. The routes add a
direct `isRunActive` check on top, because a run whose prompt is already built
would accept a file that reaches nothing.

Dependency direction: `services/runs` imports `services/attachments` to hydrate
`RunView.attachments`, never the reverse. `services/attachments` reads run
status straight off the `runs` table for that reason.

## Expiry and retention

Storage is reclaimed by the passage of time, so nothing in the run lifecycle
triggers it. `domain/expiry.ts` holds the policy and is pure: given a run's
status and finish time plus the project's two windows, it says which of
`worktrees` and `artifacts` have been released and when the rest are due.
`services/expiry.ts` acts on that, and the run screen calls the same
`planExpiry` to say when a run's storage goes — so the screen and the sweep
cannot disagree.

Two windows rather than one, because the two costs differ by orders of
magnitude: `worktree_retention_days` defaults to 7 and `artifact_retention_days`
to 30. Zero on either keeps that target forever. Both are counted from
`finishedAt`, falling back to `updatedAt` so a window can never quietly become
infinite on an older row.

Eligibility is `FINISHED_STATUSES` exactly — the same set the manual cleanup
accepts. `FAILED` and `CANCELLED` are included even though both can be
reworked; that is what distinguishes a window from the immediate
`cleanUpWorktreeOnFinish` pass, which only fires on the two terminal statuses.

Two invariants hold across every path:

- **It never forces.** Worktree removal goes through `cleanUpRunWorktrees` with
  `force: false`, so a dirty checkout and an unmerged branch survive and the
  refusal is recorded as a `notice`.
- **It never removes history.** Run rows, events, iterations, validation
  results, findings and request attachments are untouched. Artifact rows are
  *marked* — `expired_at` is set and the file deleted — rather than deleted,
  because the row is the run's own account of what it produced. That is the one
  difference between `expireRunArtifacts` and `purgeRunArtifacts`, which still
  exists for the paths that discard a run outright.

A swept run is skipped on every later pass: both windows stay elapsed for the
rest of its life, so `expireOneRun` returns null when nothing is left rather
than appending a `run.expired` event per sweep forever. A worktree that keeps
being *refused* is the harder case — the refusal is correct every time, and the
sweep does keep retrying it, because the user may commit the work later. So the
event is written only when something was reclaimed, or when nothing has been
recorded for that run before: one notice, then silence, then a second event on
the sweep that finally succeeds.

Scheduling is spread three ways because a local app's process lifetime is
unpredictable: once from `bootstrap`, every six hours from an unref'd interval,
and on demand from `/api/maintenance/expiry` — where `GET` always previews and
`POST` acts. All callers pass the orchestrator's `isRunActive`, because a run
can hold a finished status while its process is still winding down.
`DEV_COCKPIT_DISABLE_EXPIRY` switches the sweep off.

## Startup

`services/bootstrap.ts` runs once per process from the root layout. It ensures
the data directories, applies migrations, and reconciles runs that were active
when the process last stopped — marking them `FAILED` with an explicit
"interrupted by a restart" message. Child processes do not survive a restart, so
such a run really is dead; saying so is more useful than a spinner that never
resolves, and the session id and worktree are preserved so it can be continued.

It then starts the retention sweep. Reconciliation runs first on purpose: a run
this restart has just marked `FAILED` needs its finish timestamp written before
retention judges how long ago it finished. The sweep itself is never awaited —
reclaiming disk must not delay the first page render.
