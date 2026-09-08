# Architecture

## Shape

One Next.js process. The UI and the orchestrator run together, talking to SQLite
and the local filesystem. No queue, no worker, no broker — a single-user local
tool does not need a distributed system, and adding one would make every failure
harder to see.

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

The two optional layers are optional in the strict sense: with neither
configured, every other part of the application behaves identically. A
transformer that is unavailable or throws produces a `transform.skipped` event
and the run continues with the request as written. A reviewer that fails
produces `review.skipped`. Neither can fail a run.

## Directory map

```
src/
├── core/          ids, errors, data-directory paths, secret redaction
├── domain/        run lifecycle, event catalogue, validation vocabulary
├── db/            drizzle schema, client, generated SQL migrations
├── process/       command execution, process-tree kill, executable resolution
├── git/           git wrapper, diff collection, worktree lifecycle
├── agents/        ImplementationAgent + Claude Code adapter + stream parser
├── transformers/  TransformerProvider + implementations + registry
├── reviewers/     ReviewerAgent + implementations + registry
├── validation/    Validator + the engine that sequences them
├── orchestrator/  the state machine, prompts, execution profiles
├── services/      projects, runs, events, artifacts, event bus, bootstrap
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
a failed run does. `APPROVED` and `REJECTED` are terminal.

## Readiness

`assessReadiness(run, project)` is a pure function over stored state. It reads
the latest validation attempt, the latest review attempt, the changed-file list
and the project's policies. It never consults the agent's summary.

It blocks on:

- a blocking validation that failed or errored,
- a validation still running,
- validation never having run, when the project requires it,
- a UI-touching change with no E2E result, when the project requires it,
- a high or critical review finding, only when the project opts in,
- no files having changed.

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
strings, and why the feed can offer a "useful progress only" filter at all.

`events.seq` is a monotonic integer and doubles as the SSE resume cursor.

The same rows feed two views, ordered opposite ways because they answer
different questions. `components/event-feed.tsx` is the right-rail progress
panel: filtered, newest first, so the current state of the run needs no
scrolling. `components/log-stream.tsx` is the Logs tab: unfiltered by default,
oldest first, appended at the bottom and following the tail — a log, read the
way logs are read. Event *messages* are redacted when stored; the stream also
prints payload prose, so it runs the same patterns client-side through
`core/redact-patterns.ts`.

Above the feed, `domain/progress.ts` turns a run's status, the orchestrator's
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
       --permission-mode acceptEdits
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
- **`--permission-prompts none`** means anything that would block on a prompt is
  denied instead of hanging a headless run forever.
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

## Startup

`services/bootstrap.ts` runs once per process from the root layout. It ensures
the data directories, applies migrations, and reconciles runs that were active
when the process last stopped — marking them `FAILED` with an explicit
"interrupted by a restart" message. Child processes do not survive a restart, so
such a run really is dead; saying so is more useful than a spinner that never
resolves, and the session id and worktree are preserved so it can be continued.
