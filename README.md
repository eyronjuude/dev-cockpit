# Dev Cockpit

A local-first control centre for AI-assisted software engineering.

You give it a development request in plain language. It creates a persistent
Run, prepares an isolated Git worktree, launches an implementation agent inside
that worktree, captures what happened as structured data, runs your project's
own checks against the result, collects the evidence, and presents all of it for
you to approve or reject.

It is not a model and not an IDE. It is the layer that turns "make the login
page remember the email address" into an auditable run with a diff, four exit
codes and a decision.

## The rule the design serves

**Implementer ≠ approver.**

Claude Code is the default implementer, with Codex CLI available as the built-in
fallback when the default provider is out of capacity or as an explicit per-run
choice. Neither is treated as authoritative about whether the work is done.
Readiness is computed from stored run state and deterministic validation results
— the agent's own summary is recorded as a claim and shown as one.

Here is that rule doing its job on a real run:

```
agent.completed       Implementation finished in 24.2s, 4 turn(s)
validation.result     typecheck: pass (exit 0) in 1.7s
validation.result     lint: fail (exit 1) in 861ms
validation.result     unit: pass (exit 0) in 1.2s
validation.result     build: pass (exit 0) in 2.0s
run.status_changed    VALIDATING → NEEDS_CHANGES (lint failed (exit 1))
```

The agent reported success. The orchestrator disagreed, on evidence.

## What it looks like

| | |
| --- | --- |
| ![Run screen](docs/screenshots/run-ready.png) | ![Diff](docs/screenshots/run-diff.png) |
| The run screen: request, transformed specification, validation scorecard, live progress. | The Diff tab: per-file collapse, real stats. |
| ![Blocked run](docs/screenshots/run-tests-failure.png) | ![Settings](docs/screenshots/settings.png) |
| A run the orchestrator refused to mark ready, with the failing output that decided it. | Settings reports what can actually run on this machine, and why not when it cannot. |

## Following a run

Two views of the same event stream, pointing opposite ways on purpose.

**Progress**, bottom right, answers *what is happening now*. Newest entry at the
top, so the answer is never at the end of a list you have to chase, and a
phase-by-phase bar above it — spec, worktree, implement, changes, validate,
review, decision — with the running phase animated. Scroll down through it and
you are reading backwards into the run's history; a counter offers the way back
to the top.

**Logs**, in the evidence tabs, is the log proper: every event in the order it
happened, appended at the bottom, following the tail until you scroll up. Agent
prose is printed in full under its summary line. Two filters narrow it —
`verbose` includes the debug-level chatter (thinking, tool results, per-file
diffs), and `code changes only` cuts it to the edits, writes and commits, which
is the fastest way to see what the agent actually did to the tree.

Both are written as the orchestrator writes them. Nothing needs a refresh, and
the tab shows a pulse while a run is live. The `Saved files` view beside the
stream holds the raw NDJSON transcript and any setup output — those are files an
agent process leaves behind, so they only appear once the step producing them
has finished.

## Requirements

- **Node.js 22.12 or newer.** Built and tested on 22.17.
- **Git 2.30 or newer**, with `git worktree` available. Tested on 2.43.
- **Claude Code CLI** on `PATH`, already logged in. Tested against 2.1.263.
  Check with `claude --version`. This is the default implementer.
- Windows, macOS or Linux. Developed and verified on Windows 11.

No API key is required. The optional transformer and reviewer layers default to
providers that reuse a local CLI's own authentication.

Optional, and each unlocks one more provider:

- **Codex CLI** (`npm i -g @openai/codex`, then `codex login`) — provides the
  implementation fallback and runs the transformer and reviewer on your
  **ChatGPT plan**, no API key. This is the recommended reviewer, because a
  reviewer from a different vendor than the implementer catches a different
  class of problem.
- `ANTHROPIC_API_KEY` — enables the `anthropic-api` providers.
- `OPENAI_API_KEY` — enables the `openai-api` providers.

## Install

```bash
npm install
npm run build
npm run start
```

Then open <http://127.0.0.1:4317>.

For development, `npm run dev` runs the same app with hot reloading.

The server binds to `127.0.0.1` only. This application launches implementation
agents and runs your project's shell commands, so it is never exposed on a network
interface. Mutating API routes additionally require a local `Origin` header, so
a page in another tab cannot start a run.

## Register a project

1. Go to **Projects → Register a project**.
2. Enter the absolute path of a local Git repository and press **Check**. The
   path is resolved to the repository root and the default branch is detected.
3. Fill in whichever validation commands the project has. Leave the rest blank —
   a blank command means *not configured*, which is reported as such and never
   as a failure.
4. Under **Worktree setup**, list the paths each run needs but a fresh worktree
   will not have. `node_modules` is the usual one; `.env.local` is common.
5. Save.

A worked example, for a typical Node project:

| Field | Value |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit | `npm test` |
| Build | `npm run build` |
| Development command | `npm run dev` |
| Paths to link | `node_modules` |
| Setup command | *(blank — linking `node_modules` is enough)* |
| Open command | `code {path}` |
| Permission mode | `bypassPermissions` (default) — **skips every permission check**, so the agent can run those four commands itself |

Nothing is mandatory except the repository path and a name.

## Start a task

**Projects → New task**, describe what you want, attach any files that explain
it, pick a mode and a profile, press **Start**.

Two independent choices. The **mode** decides what the run produces; the
**profile** decides how much effort it spends producing it. Attachments are
optional and covered [below](#attachments).

### Working modes

| Mode | Produces | Edits files | Validation | Reviewer |
| --- | --- | --- | --- | --- |
| Ask | a written answer | **no** — permission mode forced to `plan` | not run | not run |
| Plan | a written plan | **no** — permission mode forced to `plan` | not run | not run |
| **Build** (default) | a diff plus check results | yes | as configured | as configured |
| Auto | resolves to one of the above three | — | — | — |

Ask and Plan read the repository and write nothing. The closing message *is*
the deliverable: it is stored as an artifact and shown on the run screen. No
checks run, because nothing changed — you are the reviewer.

The difference between them is what you get back. Ask leads with the answer and
cites `file:line` for every claim about the code; it is told **not** to hand you
a plan. Plan gives you ordered steps, what would prove them, and the risks.

A finished Ask or Plan run offers a switch to Build — **Implement this plan**,
or **Switch to Build** from an answer — which resumes the same agent session, so
the reading behind it is not thrown away.

Approving a plan does not use that offer up. There is nothing to land, so
**Approved** on an Ask or Plan run records the decision and leaves both
**Implement this plan** and **Revise the plan** available on the same worktree
and session. The approval itself is dropped once the build starts: it described
the plan, not the code the build goes on to write.

Auto decides in two steps. First, is this read-only? Yes if the request forbids
code changes, or names a plan as its deliverable, or — with no change verb
anywhere — asks a question or asks for a judgement. Then, which read-only mode:
**Ask** when the request asks about code that already exists, **Plan** when it
asks what to do next. Otherwise **Build**.

The ordering is what makes it work:

| Request | Mode | Because |
| --- | --- | --- |
| *"Plan how to fix the login bug"* | Plan | a stated deliverable beats a change verb |
| *"Explain why login 500s and fix it"* | Build | a change verb beats a question |
| *"What's the best way to model this?"* | Plan | a request for judgement beats a bare question |
| *"How does session expiry work?"* | Ask | a question with no change named |
| *"Continue where we left off"* | Build | the default |

It is a keyword rule, not a model call, so it is instant, offline and the same
every time. The New Task screen shows the mode it would pick and why, before
anything is created, and the reason is recorded on the run afterwards. Where it
guesses wrong, pick the mode yourself.

The mode belongs to the run, not the project: a run is one agent session, one
worktree, one branch.

These mirror three of Cursor's modes — Ask, Plan and Agent (here called Build).
Cursor's Manual mode is deliberately not mirrored: it exists for editing what
your cursor is pointing at, and there is no cursor here. See
[ADR 0010](docs/adr/0010-working-modes.md), including the caveat that the
mapping was written without access to Cursor's documentation.

### Execution profiles

| Profile | Implementation | Validation | Reviewer |
| --- | --- | --- | --- |
| Quick | effort `medium`, 15m cap | commands enabled for `quick` | skipped |
| **Standard** (default) | effort `high`, 45m cap | all configured commands | on, if selected |
| Deep | effort `xhigh`, 90m cap | all configured commands | on, if selected |

In Ask and Plan mode a profile sets effort and the time cap only.

The **What will run** panel on that page states exactly what is about to happen
before you commit to it.

## When a run stops short

A run that failed, was cancelled, or stalled on a landing can be picked back up
three ways. They are deliberately different sizes, and the run screen only
offers the ones its stored state supports.

| Action | Worktree | Branch | Agent session | Prompt |
| --- | --- | --- | --- | --- |
| **Retry** | kept | kept | resumed if recorded | resumes at the phase that stopped |
| **Retry iteration** | kept | kept | resumed if recorded | the last one again, unchanged |
| **Force restart** | rebuilt | fresh `-r2` | cleared | the initial prompt, cold |

**Retry** resumes rather than starting over, and where it resumes comes from the
run's own record rather than from anything the agent said:

- No worktree — nothing was done, so it runs from the top. A specification the
  transformer already wrote is reused rather than paid for twice.
- A worktree but no finished agent pass — it re-issues that pass.
- A finished agent pass — the failure was downstream, so it re-collects the
  diff and runs validation and review. The agent is not called at all.
- `MERGE_CONFLICT` or `LANDING_FAILED` — it retries landing, which keeps its own
  separate worktree.

The button says which of those it will do, so pressing it holds no surprise.

**Retry iteration** sends the last implementation prompt again, unchanged. It is
for when the pass is what went wrong — a timeout, a CLI that died, an agent that
stopped halfway — rather than the request, which is what *Request changes* is
for. The recorded agent session is resumed when there is one and the provider is
unchanged, so the second attempt knows what the first already wrote.

If the implementation provider reports a quota, credit or rate-limit exhaustion,
Dev Cockpit tries the next configured implementation fallback. The default order
is `claude-code`, then `codex-code`; override the fallback tail with
`DEV_COCKPIT_AGENT_FALLBACKS=codex-code` or set it to `none` to disable
fallbacks. If every implementation option is exhausted or unavailable after one
has exhausted, the run moves to **Paused**. Its worktree, branch, prompt history
and artifacts stay intact, and **Retry** picks it up at the agent pass after the
provider limits refresh.

You can also choose the implementation agent and model manually when starting a
new run, starting a draft, retrying an agent pass, retrying an iteration,
requesting changes, switching a plan to Build, or force restarting. A provider
switch starts a fresh session so one CLI is never asked to resume another
provider's conversation; changing only the model keeps the recorded session.

Neither retry is offered while a run is live. The honest action there is
**Cancel**, which already says what it does; a retry that quietly killed a
working agent would be a cancel wearing a friendlier label.

**Force restart** is the exception, and the only action available mid-run,
because stopping the work is the request. It cancels whatever is running and
waits for the process to actually exit, removes the worktree, and starts the
whole pipeline again with nothing carried over.

- **Discarded:** the worktree and everything uncommitted in it, the agent
  session, the recorded specification, and the run's approval if it had one.
- **Kept:** the event log, every iteration row, saved artifacts, the
  attempt-numbered validation results and review findings, and the recorded
  cost — that money was spent, and zeroing it would make the run under-report
  what it actually cost. The next pass writes a new attempt number; the old
  rows stay as the record of the one before it.
- **Kept on its own branch:** the previous attempt. It is never deleted. The
  restart takes the next free `cockpit/<runId>-r2`, `-r3` and so on, because
  `git branch -d` refuses a branch holding commits and this project never
  reaches for `-D`. Any commits the discarded attempt made stay reachable.

If the worktree cannot be removed — an editor holding a file open, a Windows
lock — the restart fails with that reason and the run is left exactly as it was,
rather than reset to a draft that could never prepare.

A landed or rejected run cannot be restarted. Its commits are on the target
branch, and undoing that is a git operation you make deliberately.

## How run isolation works

Each run gets its own worktree and its own branch. Nothing else is touched.

```
your repository (untouched, stays on its own branch)
│
├── main ──────────────────── base commit recorded on the run; landing target
│
└── cockpit/run_xxx ───────── created by the run, checked out at:
                              <data>/worktrees/<projectId>/<runId>/
```

Specifically:

- The run branch is created fresh. A run **never** checks out a protected
  branch, and the default branch is always protected whatever you configure.
- Your working tree is never modified, clean or dirty. Uncommitted work in the
  main checkout survives untouched — there is a test that asserts exactly that.
- Approving a run creates a commit **on the run branch only** by default.
  Nothing is merged or pushed by approval itself.
- Landing an approved run creates or reuses a separate landing worktree from the
  target branch, merges the run branch there, runs validation, then
  fast-forwards the target checkout only when the merge and validation are
  clean. Landings are queued per repository and target branch, so two runs for
  the same `main` land one at a time while unrelated repositories or branches
  can proceed independently. If the target branch moved after the landing
  worktree was prepared, Dev Cockpit refreshes the landing worktree from the
  current target branch before validating and applying. Merge conflicts and
  failed landing validation get one AI repair pass in the landing worktree; if
  that cannot finish, Dev Cockpit records manual repair instructions and leaves
  the landing worktree intact.
- Once a run lands or is rejected, both of its worktrees are removed and their
  branches deleted with `git branch -d`, never `-D`. A worktree holding
  uncommitted changes is kept, an unmerged branch is kept, and the reason for
  each goes into the event log. Turn this off per project with **Remove a run's
  worktrees once it lands or is rejected**.
- A run that failed or was cancelled keeps its worktree until you ask for it
  back, with **Remove worktrees** on the run screen. Rejecting offers the same
  thing with the option to discard uncommitted work as well — or leave it, and
  retention reclaims it after a week. See *Expiry and retention*.
- Force restarting removes the worktree but keeps the branch, and prepares the
  new attempt on `cockpit/<runId>-r2`. Same reason: nothing is deleted with
  `-D`, so an attempt that committed stays reachable.
- Linked paths become junctions on Windows (no elevation needed) or symlinks
  elsewhere. Files are *copied* rather than linked, so the agent editing
  `.env.local` cannot reach your original.
- The agent works with permission checks skipped, because nobody is there to
  answer one. It is spawned with the worktree as its working directory and told
  to stay in it, but it runs as your user with your credentials — the isolation
  is a git worktree, not a sandbox. See *Current limitations*.

Pushing remains a deliberate manual step. Dev Cockpit updates only the local
target branch.

## Worktree previews

If a project has a **Development command**, a run with a prepared worktree can
start it from the run screen. Dev Cockpit allocates a local `127.0.0.1` port,
sets `PORT`, `HOST`, `HOSTNAME` and `DEV_COCKPIT_PREVIEW_URL` for the command,
captures its output as a **Preview server log** artifact, and shows the URL in
the **Preview** tab. The action bar can stop the server, and cleanup or force
restart stops it before deleting the worktree.

## Validation configuration

Six kinds are supported: `typecheck`, `lint`, `unit`, `integration`, `e2e`,
`build`. Each takes a command line, an optional working directory relative to
the worktree, a timeout, and two flags:

- **blocks readiness on failure** — off makes the check advisory. It still runs
  and still records pass or fail, but cannot hold the run back. Useful for a
  flaky E2E suite.
- **enabled** — off skips it entirely.

Commands run sequentially through the platform shell, inside the worktree. They
compete for the same CPU, ports and lockfiles, so interleaving them would
produce flaky results.

Every outcome is recorded with its command, exit code, duration, stdout, stderr
and timestamps. Five outcomes are distinguished, and the difference matters:

| Outcome | Meaning | Blocks readiness |
| --- | --- | --- |
| `pass` | exit 0 | no |
| `fail` | non-zero exit | yes, if blocking |
| `error` | could not start, or timed out | yes, if blocking |
| `not_configured` | no command defined | **no** |
| `skipped` | excluded by the profile | no |

A project that never set up E2E has not failed E2E. Collapsing those two into
one red badge is the mistake this table exists to prevent.

## Where things are stored

Everything lives under one directory, `./data` by default. Override with
`DEV_COCKPIT_DATA_DIR`.

```
data/
├── cockpit.db                    SQLite: projects, runs, events, results
├── worktrees/<projectId>/<runId>/    the isolated checkout
├── landings/<projectId>/<runId>/     the isolated merge checkout, when landing
├── attachments/<runId>/
│   └── <attachmentId>__<name>    files you attached, verbatim
└── artifacts/<runId>/
    ├── specification.md          transformer output
    ├── changes.diff              git diff, verbatim
    ├── changed-files.json
    ├── visualisation/implementation-map-N.svg
    ├── agent/<iterationId>*.jsonl     raw implementation-agent stream
    ├── answers/iteration-N.md        ask runs only
    ├── plans/iteration-N.md          plan runs only
    ├── summaries/iteration-N.md      build runs only
    ├── validation/attempt-N-<kind>.log
    ├── validation/attempt-N-report.md
    └── review/attempt-N.md
```

The database holds metadata; bytes live on disk. That keeps `cockpit.db` small
enough to open with any SQLite client, which is the point — this is your data.

Artifacts are first-class records with their own browser in the UI. You should
never need to read an agent transcript to find out what happened.

Attachments sit under their own root, not inside `artifacts/`. The two look
alike and travel in opposite directions: an artifact is evidence a run
produced, and retention is allowed to delete it; an attachment is an input you
supplied, and this is the only copy.

## Expiry and retention

A run's storage is reclaimed by the passage of time, not by anything in its
lifecycle. Each project has two windows, both counted from the moment the run
finished, and both on the project form under **Policies**:

| Window                    | Default | What goes                                          |
| ------------------------- | ------- | -------------------------------------------------- |
| **Expire worktrees after** | 7 days  | `worktrees/<runId>/` and `landings/<runId>/`        |
| **Expire artifacts after** | 30 days | the bytes under `artifacts/<runId>/`                |

Two windows because the costs differ by orders of magnitude. A worktree is a
full checkout plus whatever `linkPaths` brought in — usually `node_modules`, so
hundreds of megabytes per run — and it is worthless once nobody is going to
open the diff again. Artifacts are logs and reports measured in megabytes, and
they are the evidence for what the run claimed, so they stay three times as
long. Set either to `0` to keep that target forever.

What expiry will not do:

- **It never forces.** Worktree removal is the same non-forcing path the
  **Remove worktrees** button uses, so a checkout holding uncommitted changes
  and a branch holding unmerged commits both survive, and the refusal goes into
  the event log — once, not on every sweep. Overdue does not mean expendable,
  and later sweeps keep trying, so committing the work is enough to let the
  directory go.
- **It never removes history.** The run row, its events, iterations,
  validation results, findings and diff statistics all stay. An expired
  artifact keeps its row and reads "expired" in the browser, with the size it
  held — which is a more useful thing to be told than that a file is missing.
- **It never touches attachments.** Those are your files.
- **It never touches a run that is not over.** Only `LANDED`, `REJECTED`,
  `FAILED` and `CANCELLED` are eligible. A run waiting on your decision, or
  with landing still ahead of it, is not expired at any age.

`FAILED` and `CANCELLED` are eligible even though both can be picked back up.
That is what the window is for: a rework happens within days, and a run nobody
returned to in a week is a checkout that is pure cost. Nothing is lost either
way, because removal still refuses to discard work.

The sweep runs at startup, then every six hours for as long as the process
lives — a startup-only sweep would never fire on a machine that leaves the
server running, and a timer-only sweep would never fire on one that does not.
`DEV_COCKPIT_DISABLE_EXPIRY=1` turns it off entirely. To see what a sweep would
free without freeing it:

```
curl http://127.0.0.1:4317/api/maintenance/expiry
```

`GET` always previews; `POST` acts.

The reasoning behind both defaults, and why expiry refuses to force, is in
[ADR 0012](docs/adr/0012-run-expiry.md).

## Attachments

A request often needs a file: the screenshot of the broken page, the log from
the crash, the design the change is meant to match. Attach them on the New task
screen, or on the run screen afterwards.

| | |
| --- | --- |
| Limits | 10 files per request, 25 MB each |
| Types | any — nothing here executes them |
| Stored | `data/attachments/<runId>/`, verbatim and unredacted |
| Given to the agent | as absolute paths, with read access to that directory |

**Attachments never enter the worktree.** The agent is handed the directory
with `--add-dir` and the paths in its prompt, so it opens what it needs with
its own tools. A file copied into the worktree would land in the diff, and an
attached log is not a change you asked for.

**The transformer never sees them.** That layer handles prose and nothing else
by design, so a specification is built from your text alone. What the
attachments inform is the implementation.

**The list is fixed once a run starts working.** You can add and remove while a
run is a draft, and again whenever it comes back — `NEEDS_CHANGES`, `READY`,
`PAUSED`, `FAILED` or `CANCELLED` — which is what makes "here is a screenshot
of what is still wrong" work before you press Request changes or Retry. A
follow-up prompt marks which files arrived since the last pass. While a run is
implementing, its prompt is already built, so the list is read-only rather than
quietly ineffective.

Both add and remove are recorded as run events, so a file that was attached and
later withdrawn still shows in the log. What the agent was given stays
readable.

Why each of those went the way it did is in
[ADR 0011](docs/adr/0011-request-attachments.md).

## The implementation map

Every run produces one, on the **Map** tab of the run screen: a single SVG
showing what the run did.

```
Pipeline      Request → Specification → Worktree → Implementation
              → Changes → Validation → Review → Verdict, each with the
              state it actually reached
Checks        one cell per validation kind, with its outcome and duration
Change map    every changed file, grouped by directory, bar width = churn,
              split green/red by additions and deletions
Findings      review severities, tallied
```

Three things are deliberate about it:

- **It is computed, not narrated.** Every value is read back out of stored run
  state — iterations, recorded file changes, exit codes, findings, the event
  log. No model is asked anything, so the map cannot disagree with the diff, and
  it costs nothing to produce. Same rule as the scorecard: the implementer's
  summary is not consulted.
- **Every run gets one, including the ones that went wrong.** A run that failed
  in preparation still produces a map; it shows the pipeline stopping at
  `Worktree`, which is exactly the question a failed run raises. `skipped`, `no
  change` and `not run` are three different words on it, and none of them is
  `failed`.
- **It is written down as well as drawn.** The whole map is also a paragraph of
  plain text in the SVG's `<desc>`, reused as the image's alt text — so it reads
  to a screen reader, and `grep` finds it on disk.

A change request draws a second map rather than overwriting the first, so the
picture taken before the request survives next to the one taken after it.

## Who does what

| Role | Providers | Credential |
| --- | --- | --- |
| Implementer | `claude-code` default, `codex-code` fallback, selectable per run or follow-up | CLI login |
| Transformer — request → specification, and the implementer's closing message → plain language | `none` (default), `codex-cli`, `claude-cli`, `openai-api`, `anthropic-api` | CLI login, or an API key |
| Reviewer — read-only opinion on the diff | `codex-cli`, `openai-api`, `claude-cli`, `anthropic-api` | CLI login, or an API key |

The transformer handles **prose only**. It never sees source code, diffs, test
results, stack traces, exit codes or screenshots — the interface has nowhere to
put them. Its reading of the implementer's closing message is stored *beside*
the original, never replacing it, because losing the implementer's actual words
would make a run less auditable rather than more.

Reviewer order is deliberate: `codex-cli` first, because it is a different
vendor from the implementer. That is the strongest independence the architecture
can offer without a second subscription.

## Secret redaction

Process output, agent text and log artifacts are passed through a redaction
pass before being stored or displayed. It covers Anthropic, OpenAI, GitHub, AWS,
Google, Slack and Stripe key formats, bearer tokens, JWTs, PEM private key
blocks, credentials embedded in connection strings, `NAME=value` pairs whose
name looks secret, and the values of secret-looking variables in the current
environment.

Two honest caveats:

- It is pattern-based defence in depth, not a guarantee. A project that prints a
  credential in a novel format will leak it.
- **Git diffs are deliberately not redacted.** A diff is evidence, and silently
  altering evidence is worse than the alternative. If your repository commits a
  secret, the diff will show it.

## Current limitations

- **Single machine, single user.** No authentication, by design.
- **One agent per run.** Concurrent runs across different projects are fine;
  two agents editing one run is not supported. Landing is serialized per
  repository and target branch.
- **A server restart kills in-flight runs.** Child processes do not survive the
  server stopping. Such runs are marked `FAILED` with "interrupted by a restart"
  rather than left showing a spinner forever. The worktree and agent session id
  are both preserved, so **Retry** picks the run up at the phase it died in.
- **No automatic push.** Intentional. Landing can update the local target
  branch after an isolated merge and validation pass, but publishing remains
  yours to do deliberately.
- **Screenshot and Playwright-trace capture is not automated.** The artifact
  kinds, storage, database records and UI rendering all exist and screenshots
  display correctly, but nothing in V1 drives a browser to produce them. A
  configured Playwright E2E command that writes into the worktree will have its
  stdout captured; its HTML report is not yet registered as an artifact.
- **Preview servers are live processes, not persisted jobs.** Their logs are
  artifacts, but a Dev Cockpit server restart loses the in-memory process state;
  start the preview again from the run screen if needed.
- **The implementation map is a snapshot, not a live view.** It is drawn when a
  pass finishes, so a run you approve afterwards still shows the verdict the
  orchestrator reached — `Ready for review`, not `Approved`. The timestamp in
  its footer says when it was taken. It also caps the change map at 40 file
  rows and counts the rest, so a very large run is summarised rather than
  drawn in full.
- **Only the Claude CLI implementation path has executed live end to end.**
  `codex-code`, `codex-cli`, `openai-api` and `anthropic-api` are implemented
  against current published interfaces, but the Codex and API-key success paths
  were not exercised during development. Their unavailable paths and fallback
  orchestration are tested; treat live success as unproven until you have run
  one on your machine.
- **Runs skip permission checks by default.** A run is unattended: there is no
  terminal to answer an approval in, so a permission check can only be bypassed
  or refused — asking is not an option. The default is therefore
  `bypassPermissions`, which launches the CLI with
  `--dangerously-skip-permissions`. The agent can run your tests, inspect git
  and check a build inside its own disposable worktree, on its own branch,
  without your changes committed or pushed anywhere. It also means the agent
  runs arbitrary commands on your machine with your credentials: the isolation
  is a git worktree, not a container. A project you do not trust that far should
  be set to `acceptEdits`, which permits file edits and refuses every Bash and
  PowerShell call — the implementer then works blind, is told so in its prompt,
  and any refusal is recorded as a run notice naming the tools. Deterministic
  validation decides readiness either way; see
  [ADR 0010](docs/adr/0010-unattended-permission-default.md).
  `DEV_COCKPIT_PERMISSION_MODE` overrides every project on the machine.
- **`--dangerously-skip-permissions` has historically been refused as root.**
  Claude Code rejects the flag under `sudo` or as `root` on some versions. That
  was not re-tested here — this is a Windows machine — so if you run the server
  as root on Linux and every run dies at spawn, set
  `DEV_COCKPIT_PERMISSION_MODE=acceptEdits` and check the agent stderr in the
  Logs tab.
- **Codex CLI has no `--system-prompt` equivalent.** The Claude providers
  replace the system prompt outright; the Codex ones prepend the instruction to
  the prompt body instead. The output schema does the constraining either way,
  but it is a smaller guarantee.
- **Retention does not measure what it frees from a worktree.** The sweep
  reports artifact bytes exactly and worktree *counts* only: a recursive stat
  over a checkout costs more than the number is worth. So "reclaimed 12 MB and
  4 worktrees" under-reports the disk actually freed, usually by a very large
  margin. Nothing reports the total size of the data directory yet either.
- **Attachment delivery has not been exercised against a live CLI.** The
  wiring is deliberate: the directory is passed with `--add-dir` and every
  file is named by absolute path in the prompt, so the agent opens them with
  its own tools. But no end-to-end run has confirmed Claude Code reads an
  attached screenshot from an added directory. Verify it on a throwaway
  request before it matters, and check the agent's tool calls in the Logs tab
  for the read.
- **The per-run attachment limit is checked read-then-write.** Two uploads
  landing at the same instant could both pass a check that says nine are
  stored and leave eleven. Single-user local app; not worth a transaction.
- **The transformer can rename a run.** It sets the run title from its own
  suggestion, which is usually an improvement but does mean the title is not
  always your words. The request itself is never altered.
- **The read-only modes' permission handling has not been exercised against a
  live CLI.** The wiring is deliberate — `--permission-mode plan` alongside the
  existing `--permission-prompts none`, so anything that would ask to leave
  plan mode is denied rather than left hanging — but it has not been run
  end to end. Verify it on a throwaway question before trusting it with one
  that matters, and check the run's Changes tab is empty. Readiness blocks a
  read-only run that changed a file, so a failure here is reported rather than
  silent.
- **Auto mode is a keyword rule and will misread some requests.** It is off by
  default for that reason, it shows what it picked and why before the run
  starts, and a run can be switched afterwards without losing its session. The
  rule is in `src/domain/modes.ts` and is the whole of it — there is no model
  behind it.
- **An Ask or Plan run still goes through a transformer, if one is selected.**
  The specification it produces is useful input to both, but it is written as an
  *implementation* specification, because the transformer boundary was left
  unchanged. The heading is wrong; the content is not misleading.
- **The mapping onto Cursor's modes was written without access to Cursor's
  docs.** Ask, Plan and Agent-as-Build are from the author's own knowledge of
  the product, which moves. The modes here stand on their own; only the claim
  about what Cursor calls them is unverified.

## Extending it

Adding a transformer or reviewer provider is one class and one registry entry.
See [docs/EXTENDING.md](docs/EXTENDING.md).

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and
[docs/adr/](docs/adr/) for the decisions and why they went the way they did.

## Development

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # vitest
npm run build          # next build
npm run db:generate    # regenerate SQL migrations after a schema change
```

The test suite uses real SQLite databases in temporary directories, real Git
repositories and real child processes. Very little is mocked, because the things
most likely to break here are exactly the things a mock would hide.

Tests that spend money on the Claude API are opt-in:

```bash
DEV_COCKPIT_LIVE_AGENT_TESTS=1 npm run test
```

Those ten cover the live agent adapter: a real implementation run, session
resume with retained context, cancellation, and the read-only providers.

## V2 backlog

[docs/V2-BACKLOG.md](docs/V2-BACKLOG.md) — what was deliberately left out, and
why.
