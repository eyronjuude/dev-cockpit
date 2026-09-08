# V2 backlog

What was deliberately left out of V1, roughly in the order it would earn its
place. Items marked **gap** are places where V1 has the structure but not the
behaviour — those are the honest incompleteness rather than future ideas.

## Finish what V1 started

**Automated screenshot and Playwright artifact capture** — *gap*
The `screenshot` and `playwright_report` artifact kinds exist, are stored, and
render correctly in the artifact browser. Nothing produces them. The work: after
a configured E2E command runs, scan the worktree for `playwright-report/`,
`test-results/` and screenshot output, register what is found as artifacts, and
honour the project's `captureScreenshots` policy. This is the largest gap
between what the UI implies and what the system does.

**Exercise the key-based and Codex providers** — *gap*
`codex-cli`, `openai-api` and `anthropic-api` are implemented against current
published interfaces and none has ever executed a success path — no keys, and
no installed Codex CLI. Each needs one real run before being described as
working. `codex-cli` is the cheapest to prove: `npm i -g @openai/codex` and an
interactive `codex login`.

**Artifact retention enforcement** — *gap*
`artifactRetentionDays` is configured per project and stored. No job prunes
anything. A run started at process boot could delete artifact directories older
than the window, and mark the rows so the UI shows "expired" rather than
"missing".

**Worktree reclamation** — *gap*
Worktrees accumulate until a run is rejected with cleanup. A `git worktree
prune` pass plus a "remove worktree" action on approved runs would stop the data
directory growing without bound.

**Preview URLs**
`developmentCommand` is recorded and never started; `previewUrl` on artifacts is
always null. Starting a dev server per run means port allocation, health
checking and lifecycle management — worth doing, but a subsystem rather than a
feature.

**Host-side permission allowlist**
ADR 0009 keeps the agent unable to run commands, documented rather than
changed. The middle ground is `--permission-prompts host` plus a per-project
approve/deny policy: read-only git and the project's own test commands
approved, everything else denied without hanging. Would let the implementer
verify its own work and cut wasted iterations.

**Answering the agent's follow-up questions**
There is no inbound channel to a running iteration — stdin closes after the
prompt, and the only thing the orchestrator can do to a live run is cancel it.
Two separate features hide here:

- *Pre-flight questions.* When the transformer raises "Open questions", hold
  the run in `DRAFT` and ask before launching the agent. Cheap, and it is the
  one that pays: a run whose request was `"continue where we left off"` spent
  17 turns and $1.04 to arrive at a question the transformer had already
  written down, and changed no files.
- *Mid-run interactivity.* Claude Code supports it —
  `--input-format stream-json` for streaming input, `--permission-prompts host`
  for routing approvals, `--brief` for the `SendUserMessage` tool. The app side
  needs a `WAITING_FOR_INPUT` status, a question queue and an inbound route.
  Note the new failure mode: a parked run holds a process open and dies on
  restart with nothing to show, which the current fire-and-forget model avoids.

## Next most useful

**Structured test-result parsing**
Validation currently records exit codes and raw output. Parsing JUnit XML, TAP
or a JSON reporter would give per-test results, so the Tests tab could show
"3 failed of 214" and name them instead of showing a log to scroll.

**Diff review annotations**
Reviewer findings carry a file and line but the Diff tab does not place them
inline. Anchoring findings to diff lines is the single biggest readability win
available on the run screen.

**Run comparison**
Two runs against the same base, side by side. Useful when trying two approaches
to the same request.

**Cost and duration history**
Cost per run is already recorded. A per-project trend over time would make the
economics visible, which matters when a run can cost a couple of dollars.

**Multiple concurrent runs per project**
Already supported technically — each run gets its own worktree and branch. What
is missing is UI: a way to see several active runs at once without navigating
between them.

**Resumable interrupted runs, properly**
A run interrupted by a restart is marked `FAILED` and can be continued, because
the session id and worktree survive. What it cannot do is pick up mid-phase — a
run interrupted during validation restarts validation from the beginning.

## Deliberately deferred

Structured so they can be added, not built now.

**Reviewer independence** — *addressed, unproven*
The `codex-cli` and `openai-api` reviewers make a different vendor from the
implementer possible, which is what ADR 0005 said was missing. Neither has
executed a success path yet. Once one has, this stops being a limitation.

**Additional implementation agents**
`ImplementationAgent` exists precisely so a second one can be added. None was,
because one working integration verified end to end is worth more than two
half-tested ones.

**Validator plugins beyond shell commands**
The `Validator` interface is the seam. `runValidation` constructs
`CommandValidator` directly; a registry is a small piece of work when the second
validator arrives.

**Request templates**
Recurring request shapes ("add a migration for…", "fix the failing test in…")
saved per project.

**Hooks**
Fire a local command on `run.ready` or `run.approved`. Trivially useful, and
trivially a security question, so it wants designing rather than adding.

## Explicitly out of scope

Not deferred — decided against for this application.

- Multi-user authentication, teams, organisations
- SaaS billing
- Cloud infrastructure, AWS, Kubernetes
- Distributed worker queues
- Public hosting or remote access
- Automatic production deployment
- **Automatic merge to the default branch.** The whole isolation design exists
  to make landing work a deliberate human act.
- **Automatic push.** Same reason.
- Slack, Trello, or other third-party integrations
- Sophisticated analytics
- Multiple agents editing the same run concurrently
- A plugin marketplace
- Browser automation of consumer Claude or ChatGPT web interfaces
