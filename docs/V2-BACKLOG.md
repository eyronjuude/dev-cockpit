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

**Exercise the live CLI paths** — *gap*
`codex-code`, `codex-cli` and `gemini-cli` are implemented
against current published interfaces, but their success paths still need real
runs on a configured machine. The unavailable paths and fallback orchestration
are tested. `codex-code` and `codex-cli` are the cheapest to prove:
`npm i -g @openai/codex` and an interactive `codex login`.

**Disk usage reporting**
Retention now enforces both windows (ADR 0012), but nothing shows the user how
much disk the data directory holds, so the problem the windows solve is
invisible until it is urgent. The sweep reports artifact bytes exactly and
worktree counts only — a recursive stat over a checkout costs more than the
number is worth during a sweep, but computing it once for a Settings panel is
cheap. That panel is the missing half: per-project totals for `worktrees/`,
`landings/` and `artifacts/`, and a **Sweep now** button beside them.

**Preview automation** — *mostly done*
Auto-start on `READY`, a configurable ready path with a real timeout, restart,
and a log tail all ship now, and the tab opens the page an implementer names
rather than the site root. What remains is browser-capture integration that can
register screenshots or Playwright reports against the preview URL, and a
readiness check richer than "something answered" — parsing the dev server's own
output for its bound URL would beat polling.

Route *derivation* is the other gap. Today a page is previewed because the
implementer named it; a run whose agent writes no `## Preview` section falls
back to the configured ready path. Mapping a changed file to the URL that
renders it would cover that, and needs framework knowledge the app does not
have: `repo-evidence.ts` reads only top-level manifests and identifies
ecosystems, not frameworks. The cheap first step is already sitting there —
`dependencyNames` is computed in `packageJsonFacts` and thrown away without
reaching `RepoEvidence`.

**Host-side permission allowlist**
ADR 0010 made runs skip permission checks entirely, so the implementer can now
verify its own work. What is still missing is the middle setting:
`--permission-prompts host` plus a per-project approve/deny policy — read-only
git and the project's own test commands approved, everything else denied
without hanging. That is the only way to be unattended *and* restricted; today
the choice is all commands or none.

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
between them. Landing is narrower on purpose: runs targeting the same
repository branch wait in a per-branch FIFO, while unrelated landing targets can
proceed independently.

**Resumable interrupted runs, properly**
A run interrupted by a restart is marked `FAILED` and can be continued, because
the session id and worktree survive. What it cannot do is pick up mid-phase — a
run interrupted during validation restarts validation from the beginning.

## Deliberately deferred

Structured so they can be added, not built now.

**Reviewer independence** — *addressed, unproven*
The `codex-cli` reviewer makes a different vendor from the implementer
possible, which is what ADR 0005 said was missing. Its live success path still
needs to be exercised on a configured machine. Direct API providers were removed
in favor of CLI authentication.

**Project-level implementation agent preference**
`claude-code` remains the default and `codex-code` is the built-in fallback, but
there is no project form control for choosing a different primary implementer
yet. The run row can store it; the UI to set it is the missing part.

**Validator plugins beyond shell commands**
The `Validator` interface is the seam. `runValidation` constructs
`CommandValidator` directly; a registry is a small piece of work when the second
validator arrives. The pipeline is free-form now, so a non-command validator has
somewhere to sit without displacing anything.

**Proving `auto` mode against a live model** — *gap*
The probe, the revision rule and the configuration history are tested with
commands the tests write. What has not been exercised is a real advisor
returning a proposal that a probe then corrects — the one path where a model's
commands are saved and run without a human reading them first. Worth doing on a
throwaway project before trusting it with a real one.

**Probe cost accounting** — *gap*
`auto` mode makes up to two advisor calls and neither is added to any total.
`addRunCost` counts a run's spending and a probe has no run; a per-project
figure is the missing half.

**Request templates**
Recurring request shapes ("add a migration for…", "fix the failing test in…")
saved per project.

**Working modes, the parts left out**
Ask, Plan, Build and Auto ship (ADR 0010). Four smaller things were
deliberately not built with them:

- *Custom modes.* Cursor has them; `WORK_MODE_BEHAVIOURS` is exactly the seam
  they would plug into — a stored row of phase toggles, a permission mode and a
  prompt, instead of a compiled-in table entry. The work is not the model, it is
  the editor UI and validating that a user-defined mode cannot grant itself more
  capability than the project allows.
- *A project-level default mode.* One more column and one more form field for a
  choice already made on the screen where a run starts. Worth adding the moment
  a project turns out to pick the same mode every time.
- *A mode-aware transformer.* An Ask or Plan run's specification is still headed
  "implementation specification", because `TransformRequestInput` was left
  alone. Passing the mode through would let each get a brief of the right shape.
- *A better Auto.* The current rule is keywords in a fixed order. A transformer
  could classify instead, but it is optional, offline-absent and cannot run in
  the form as the user types, so the written rule earns its place until Auto is
  wrong often enough to measure.

Cursor's **Manual** mode was considered and declined rather than deferred: it
exists to edit what your cursor points at, and this application has no cursor.
See ADR 0010.

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
- **Dev Cockpit itself growing third-party API clients** — posting to Slack,
  syncing Trello cards, and the like. Different from a project's own MCP
  integrations (`projects.integrations`, wired into `agents/claude-code.ts`):
  those configure what a *run's agent* can reach, the same way its model or
  permission mode already vary per project; this line is about the app's own
  surface area growing new outbound API clients.
- Sophisticated analytics
- Multiple agents editing the same run concurrently
- A plugin marketplace
- Browser automation of consumer Claude or ChatGPT web interfaces
