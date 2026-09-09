# 0004 — Isolate every run in its own worktree and branch

**Status:** accepted

## Context

An agent editing files needs somewhere to work that is not the developer's
checkout, which may hold uncommitted work.

## Decision

Each run gets `git worktree add <data>/worktrees/<projectId>/<runId> -b cockpit/<runId> <baseCommit>`.
Protected branches are never checked out; the default branch is always
protected. Approval commits to the run branch by default. Landing uses a second
worktree under `<data>/landings/<projectId>/<runId>` to merge, validate, and
then fast-forward the local target branch. Nothing pushes.

Configured paths are linked into the worktree: directories as junctions on
Windows (no elevation required) or symlinks elsewhere, files copied.

## Why

- Worktrees are a native Git feature, cheap, and share the object database.
- A fresh worktree has no `node_modules` and no untracked env files, so most
  validation commands would fail immediately. Linking is what makes automatic
  validation actually work in practice, and it was the single most important
  practical detail in getting a real run to pass.
- Files are copied rather than linked so an agent editing `.env.local` cannot
  reach the original.

Once a run reaches LANDED or REJECTED, both of its worktrees are reclaimed if
the project's `cleanUpWorktreeOnFinish` policy is on, which it is by default.
That pass never forces: a worktree holding uncommitted changes stays, and a
branch Git considers unmerged is kept. Every other finished status offers the
same cleanup as an explicit action instead. APPROVED is deliberately excluded —
landing still needs the run worktree.

## Consequences

- Worktrees no longer accumulate without bound. What survives a cleanup is what
  would have been lost by it: uncommitted changes and unmerged branches, each
  with its reason recorded in a `worktree.removed` event.
- Removal is scoped by the run that owns it. Each target is re-checked against
  the branch actually checked out there, so a stale recorded path cannot reach
  another run's worktree.
- Junctions are unlinked before the directory is deleted, so a delete cannot
  reach through into the developer's own `node_modules`.
- Artifact retention is recorded but still not enforced.
- Junction creation can fail on unusual filesystems. Failures are reported per
  path in a `worktree.setup` event rather than failing the run.
- Publishing the work is manual. Deliberate.
