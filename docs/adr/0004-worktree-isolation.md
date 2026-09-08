# 0004 — Isolate every run in its own worktree and branch

**Status:** accepted

## Context

An agent editing files needs somewhere to work that is not the developer's
checkout, which may hold uncommitted work.

## Decision

Each run gets `git worktree add <data>/worktrees/<projectId>/<runId> -b cockpit/<runId> <baseCommit>`.
Protected branches are never checked out; the default branch is always
protected. Approval optionally commits to the run branch. Nothing merges,
nothing pushes.

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

## Consequences

- Worktrees accumulate under the data directory and are removed only on reject
  with cleanup, or by hand. Retention is recorded but not yet enforced.
- Junction creation can fail on unusual filesystems. Failures are reported per
  path in a `worktree.setup` event rather than failing the run.
- Landing the work is manual. Deliberate.
