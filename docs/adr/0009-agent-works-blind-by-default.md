# 0009 — The agent works blind by default, and is told so

**Status:** accepted

## Context

Found by reading a real run rather than the code.

Dev Cockpit launches Claude Code with `--permission-mode acceptEdits` and
`--permission-prompts none`. The second flag exists so a headless run can never
hang waiting for an approval nobody is present to give.

The consequence was not noticed until a run needed git introspection. Five
tool calls were refused, all of them read-only:

```
git log --oneline … && git status --porcelain && git branch -a
git stash list; git log origin/main..HEAD; git worktree list
git branch -a --sort=-committerdate --format="%(committerdate:short) …"
git stash list --date=short --format="%gd %ad %gs"
git merge-base --is-ancestor HEAD replit-dev
```

`acceptEdits` permits file edits. It does not permit Bash or PowerShell. With
prompts auto-denied, that means **the agent cannot run a single command** — it
cannot run the project's tests, inspect git, or check a build.

Meanwhile the prompt told it *"Running them yourself before you finish is
encouraged."* Which was impossible, and cost it turns discovering that.

## Decision

Keep the restriction. Fix the honesty.

1. **Tell the agent the truth.** The prompt now branches on
   `project.agentPermissionMode`. Where commands are refused it says so, names
   the tools it does have, and instructs it not to report results it could not
   obtain.
2. **Tell the user.** `permission_denials` is parsed off the result message and
   recorded as an `agent.notice` naming the refused tools, so a run that worked
   blind explains itself instead of reading as one that chose not to check.
3. **Document the trade** in the README limitations and on the permission-mode
   field itself, including that `bypassPermissions` lifts it.

Rejected: switching the default to `bypassPermissions`, and building a
host-side allowlist handler. Both were offered; the decision was to keep the
safe default and make it legible.

## Why

The architecture already covers the gap this leaves. Deterministic validation
runs after the agent stops and is the thing that decides readiness — an
implementer that cannot self-check produces a worse first draft, not a wrong
verdict. `IMPLEMENTER != APPROVER` means the orchestrator was never relying on
the agent's own checking.

So the cost is iterations, not correctness. Paying that to keep the default
posture tight, on a tool that runs arbitrary commands on a personal machine, is
a reasonable trade — as long as nobody is misled about it, which was the actual
defect.

## Consequences

- Runs on `acceptEdits` will more often hand over work the agent could not
  verify, and say so plainly rather than implying otherwise.
- `bypassPermissions` remains available per project. The worktree is disposable
  and on its own branch, so it is defensible for a repository you trust — but it
  is an explicit choice, not a default.
- A host-side allowlist (`--permission-prompts host` plus a configured
  approve/deny policy) stays the obvious future middle ground. It is in the V2
  backlog rather than built.
