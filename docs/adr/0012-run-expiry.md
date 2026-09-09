# ADR 0012 — Runs expire on two windows, and expiry never forces

**Status:** accepted

## Context

A run leaves two kinds of storage behind. Its worktrees are a full checkout of
the project plus whatever `linkPaths` brought in — with `node_modules` that is
routinely hundreds of megabytes — and there are two of them once landing has
been attempted. Its artifacts are logs, diffs and reports, usually a few
megabytes.

Only one path reclaimed any of that. `cleanUpWorktreeOnFinish` (ADR 0004)
removes a run's worktrees the moment it lands or is rejected, and deliberately
stops there: `FAILED` and `CANCELLED` runs can be reworked, so taking their
checkout away the instant they stop would break the rework. The result is that
every failed or cancelled run keeps a checkout forever, and a week of debugging
a flaky setup command can fill a disk. `artifactRetentionDays` existed from the
first migration, was configurable, and was never enforced by anything.

So the storage that accumulates without bound is exactly the storage no
lifecycle event is entitled to reclaim. What is missing is not another
lifecycle hook but a clock.

## Decision

**Runs expire on elapsed time, on two separate windows per project.**

`worktree_retention_days` defaults to 7, `artifact_retention_days` to 30. Both
count from `finishedAt`. Zero on either keeps that target forever.

Two windows rather than one because the two facts pull in opposite directions.
A worktree costs two orders of magnitude more disk than the logs describing it,
and is worthless the moment nobody will open the diff again. An artifact is the
evidence for what the run claimed — the thing that makes a green scorecard
checkable — and deserves to outlive the checkout. A single window would have to
pick which of those to ignore.

**Eligibility is `FINISHED_STATUSES`, including `FAILED` and `CANCELLED`.** That
is the difference between a window and a hook: a rework happens within days, so
a run nobody returned to in a week is a checkout that is pure cost. A run
waiting on the user (`READY`, `NEEDS_CHANGES`, `PAUSED`) or with landing still
ahead of it (`APPROVED`, `MERGE_CONFLICT`, `LANDING_FAILED`) is never expired at
any age.

**Expiry never forces.** Worktree removal is the same non-forcing path the
user's own **Remove worktrees** button takes, so a checkout holding uncommitted
changes and a branch holding unmerged commits both survive, and the refusal is
recorded as a `notice`. Overdue does not mean expendable, and this is what makes
a 7-day default payable: the worst case of a window that is too short is a
directory that survives and an event saying why.

**Expiry never removes history.** The run row, its events, iterations,
validation results, findings and diff statistics all stay. Artifact rows are
*marked* rather than deleted — `expired_at` is set and the bytes removed — so
the browser can say "expired under the 30-day policy, 4.2 MB" instead of
implying a file went missing. Request attachments are never touched at all; they
live under a separate root precisely so no cleanup path has to remember the
difference (ADR 0011).

**The policy is pure and the sweep is separate.** `domain/expiry.ts` decides
from a status, a timestamp and two numbers. `services/expiry.ts` acts on the
decision, and the run screen calls the same `planExpiry` to tell the user when
storage goes — so the screen and the sweep cannot disagree about a date.

**Scheduling is spread three ways:** once at startup, every six hours from an
unref'd interval, and on demand from `/api/maintenance/expiry`. A local app's
process lifetime is unpredictable — a startup-only sweep never fires on the
machine that leaves the server running for a fortnight, and a timer-only sweep
never fires on the one that restarts it hourly. `GET` on that route always
previews and `POST` acts, so the destructive verb is the only one that removes
anything.

## Consequences

- The unbounded growth is bounded. A failed run's checkout goes after a week
  without anyone deciding to let it go.
- A developer who wants a worktree for longer than a week has to say so, per
  project. Seven days is a guess at a habit, and the wrong guess for someone who
  returns to old runs monthly.
- The sweep reports artifact bytes exactly and worktree *counts* only. A
  recursive stat over a checkout costs more than the number is worth, so the
  reported figure under-reports the disk actually freed, usually by a lot. It
  says so rather than estimating.
- A run swept once is skipped by every later pass, so the event log gets one
  `run.expired` per run rather than one per sweep for the rest of its life.
- Nothing yet reports the total size of the data directory, so the user cannot
  see the problem the windows solve — only its absence.
