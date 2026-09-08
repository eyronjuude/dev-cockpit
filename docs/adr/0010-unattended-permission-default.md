# 0010 — Unattended runs skip permission checks

**Status:** accepted

Supersedes the default chosen in
[ADR 0009](0009-agent-works-blind-by-default.md).

## Context

ADR 0009 kept `acceptEdits` as the default and fixed the honesty problem around
it: the agent is told it cannot run commands, and refusals surface as run
notices. That was the right fix for the lie. It was the wrong default.

The reason is in the shape of a run. Nobody is watching one. There is no
terminal attached, no way to answer a prompt, and `--permission-prompts none` is
passed precisely so a run can never hang waiting for an answer that will never
come. So a permission check inside a Dev Cockpit run has two possible outcomes,
not three:

- bypassed, or
- refused.

"Ask the human" is not on the menu. Under `acceptEdits` every Bash and
PowerShell call lands on *refused* — including read-only ones. Observed on a
real run: five refused `git log` / `git status` / `git branch` calls, each
costing a turn to discover.

## Decision

`bypassPermissions` becomes the default, and it is expressed with the CLI's own
flag: `--dangerously-skip-permissions`.

1. **One resolution point.** `agents/permissions.ts` turns the project setting,
   the `DEV_COCKPIT_PERMISSION_MODE` machine override and the default into the
   mode a run will use, and into CLI flags. Nothing else builds those flags.
2. **`ProjectView.effectivePermissionMode`** carries that answer to the prompt
   builder, the orchestrator's notices and the UI, so all three describe the
   same run.
3. **Existing projects move too** (migration 0002). A project on `acceptEdits`
   is almost always there because that was the default the day it was
   registered, not because someone chose to work blind. Only that exact value is
   rewritten; `plan` and anything else is left alone.
4. **`--permission-prompts none` stays on every mode.** It is the anti-hang
   guarantee, and it is independent of which checks are skipped.
5. **`acceptEdits` remains one select away**, with everything ADR 0009 built to
   make it legible still in place.

Not changed:

- **Codex.** `codex-query.ts` is the reviewer and transformer path, not an
  implementer: `codex exec --sandbox read-only`, non-interactive, no approval
  prompt to stall on. Its sandbox is what makes "a reviewer cannot edit your
  code" structural rather than a promise. Loosening it would buy nothing for
  unattended execution and cost that guarantee. If Codex is ever added as an
  implementation agent, its unattended posture is a decision for that ADR.
- **The API providers** (`anthropic-api`, `openai-api`) and `claude-query.ts`.
  They have no tools at all — `--tools ""` on the Claude side, a plain
  completion on the API side — so there is no permission to grant or skip.
  Permissions are a CLI-agent concept and stop at the implementer.

## Why

The safety argument for `acceptEdits` was never that the agent is contained. It
is not: `bypassPermissions` runs commands as your user, with your credentials,
on your machine. What is contained is the *work* — a disposable worktree, on its
own branch, with the main checkout untouched, nothing merged and nothing pushed.
That containment is identical under either mode. The only thing `acceptEdits`
buys is that a bad command cannot be run at all, and it pays for that by making
every good command impossible too.

Meanwhile `IMPLEMENTER != APPROVER` is unchanged. Deterministic validation still
runs after the agent stops and still decides readiness. Letting the implementer
run the same checks first does not weaken that; it moves the discovery of a
broken build from iteration two to iteration one.

The trade is honestly stated rather than hidden: this is a tool that runs an
autonomous agent against your repository on your own machine. The default now
matches what it is for.

## Consequences

- The agent can run arbitrary commands during a run. On a repository you would
  not hand to a contractor, set the project to `acceptEdits`, or set
  `DEV_COCKPIT_PERMISSION_MODE=acceptEdits` for the whole machine.
- Runs cost more tokens per iteration and fewer iterations, because the agent
  now spends turns running checks instead of turns discovering it cannot.
- The `deniedTools` notice becomes rare rather than routine. It is kept: a
  project pinned to `acceptEdits` still needs it, and a mode that starts
  refusing calls unexpectedly should be visible.
- Migration 0002 rewrites configuration a user could have set deliberately. The
  window for that is narrow — `acceptEdits` was the default until now — but it
  is a real edit to their data, and it is one-way.
- A host-side allowlist (`--permission-prompts host` with a configured
  approve/deny policy) stays the principled middle ground and stays in the V2
  backlog. It is now the thing that would let a run be *both* unattended and
  restricted, rather than the thing that would rescue a bad default.
