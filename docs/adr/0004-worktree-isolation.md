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
Windows (no elevation required) or symlinks elsewhere, files copied. Both
worktree kinds are provisioned the same way, by one `provisionWorktree` helper:
a landing worktree is as bare as a run worktree and validation runs there too.

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
- Artifact retention is recorded but still not enforced. *(Closed by ADR 0012:
  both windows are enforced, and worktrees gained one of their own for the
  finished statuses this immediate cleanup deliberately leaves alone.)*
- Junction creation can fail on unusual filesystems. Failures are reported per
  path in a `worktree.setup` event rather than failing the run.
- **Linking does not work for every build tool.** Turbopack caps module
  resolution at its workspace root and rejects a link that leaves it —
  `Symlink [project]/node_modules is invalid, it points out of the filesystem
  root`, verified against Next 16.3.4. Per-entry junctions inside a real
  `node_modules` fail the same way: "files outside of the workspace root are
  not compiled." Such a project needs a setup command instead, and the disk
  cost is then real — 52 MB with pnpm hardlinking from a same-volume store,
  422 MB with npm copying. `collectRepoEvidence` detects the case and
  `proposeProjectSetup` proposes an install for it (ADR 0013).
- A worktree whose dependencies never arrived is reported as such in a
  `worktree.setup` notice, and landing skips its AI repair pass for that
  reason. An agent cannot edit its way out of a missing dependency tree, so
  attempting it burned a full iteration and failed identically. The check is
  structural — are the ecosystem's dependency directories present — so it is
  reliable when it says no and makes no promise when it says yes.
- Publishing the work is manual. Deliberate.
