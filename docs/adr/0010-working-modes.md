# 0010 — Working modes: Ask, Plan, Build, Auto

**Status:** accepted

## Context

Every run did the same thing: implement, validate, review, decide. Some
requests do not want that. "How does session expiry work here" wants an answer.
"How should we structure the billing module" wants a plan. A run that responds
to either by editing files has answered a different question.

Cursor's mode selector is the reference the request named. What is worth taking
from it is the shape — a small, explicit choice made per conversation, visible
while you work — not its visual design.

### Which of Cursor's modes this mirrors

**Unverified.** Web access was denied in the session that wrote this, so the
mapping below is from the author's own knowledge of Cursor rather than from its
documentation, and Cursor's own naming moves. Check it against
`cursor.com/docs` before quoting it anywhere.

| Cursor | Here | |
| --- | --- | --- |
| Ask | **Ask** | Read-only questions about the codebase. |
| Plan | **Plan** | Research, then a plan handed to an agent to execute. |
| Agent | **Build** | Reads, edits, and runs what it is permitted to run. |
| Manual | — | Declined, see below. |
| Custom modes | — | Deferred, see the V2 backlog. |

Manual mode — edit exactly what I point at, in the file I have open, and do not
go exploring — has no analogue worth building here. Its value comes from an
editor with a cursor in it and a human watching each keystroke. Dev Cockpit
hands a written request to an autonomous agent in a disposable worktree and
reads the diff afterwards; there is nothing to point at. The nearest thing that
already exists is the Quick execution profile, whose prompt suffix says "keep
the change tightly scoped to what was asked".

## Decision

**Four modes, three behaviours.** `ask`, `plan` and `build` are what a run can
execute in. `auto` is a choice between them, resolved from the request text
before the run is created and stored as `resolved_mode`, so nothing downstream
ever has to handle a fourth case.

**What each mode allows.**

| | Ask | Plan | Build |
| --- | --- | --- | --- |
| May edit files | no | no | yes |
| Agent permission mode | forced to `plan` | forced to `plan` | the project's |
| Validation | not run | not run | as configured |
| Independent review | not run | not run | as configured |
| Closing message | is the answer | is the plan | a claim about work done |
| Stored as | `answer` artifact | `plan` artifact | `markdown_report` |

The read-only modes are enforced twice, and the second one is the one that
matters. The prompt says what the run is for; Claude Code's own `plan`
permission mode makes the refusal real. A prompt is an instruction, and
"changes nothing" has to be a promise the agent cannot break by misreading it.
A mode can only take capability away — Ask and Plan override
`bypassPermissions`, and nothing in the table can escalate a restrictive
project.

**Ask and Plan are separate modes, not one read-only mode.** They share every
phase toggle and differ only in the prompt and the deliverable, which looks
like a reason to merge them. It is not: the prompt *is* the product here. Ask
is told to lead with the answer, cite `file:line` for every claim, and *not* to
propose a plan. Plan is told to produce ordered steps and name its risks. Given
one prompt for both, every question would come back as a five-section
implementation plan, which is exactly the failure Ask exists to avoid.

**Auto includes a written rule, not a model call.** Two steps. Is this
read-only — because the request forbids changes, names a plan as its
deliverable, or (with no change verb anywhere) asks a question or asks for a
judgement? Then, which read-only mode — Ask when the request asks about code
that already exists, Plan when it asks what to do next. Otherwise Build. It is
a keyword heuristic in `src/domain/modes.ts`, it is pure, and it is tested.

The ordering carries the design: a stated deliverable beats a change verb
("plan how to fix the login bug" is a Plan), a change verb beats a question
("explain why login 500s and fix it" is a Build), and a request for judgement
beats a bare question ("what's the best way to model this" is a Plan, not an
Ask).

**Scope is the run.** A run is this application's unit of conversation — one
agent session, one worktree, one branch — so the mode belongs to it, chosen on
the New Task screen. `mode` records what was asked for and is never rewritten;
`resolved_mode` records what is executing and moves if the run switches.

**A read-only run can become a build.** "Implement this plan" (or "Switch to
Build" from an Ask) moves `resolved_mode` and resumes the same Claude Code
session, told explicitly that the read-only rules are replaced. Without that,
asking or planning separately would cost a whole second run and throw away
everything the agent read.

## Why

**Why default to Build.** Every run that existed before this defaulted to
Build, and a keyword heuristic quietly turning "fix the login crash" into a
document is a worse surprise than the reverse. Auto is opt-in, and shows the
mode it would pick, with its reason, before anything is created.

**Why a heuristic rather than a model.** The transformer layer exists and could
classify. It is also optional, absent on a default install, network-dependent
and non-deterministic — and this decision has to be made before the run exists,
shown live in a form as the user types, and reproduced identically on the
server. A rule that can be read, tested and argued with beats a call that
cannot on all four counts.

**Why readiness needed splitting.** `assessReadiness` demanded a diff and a
green scorecard. Applied to a read-only run, every plan would sit in
`NEEDS_CHANGES` forever with "No files changed" — technically true, entirely
useless. A read-only run is judged on two things instead: the deliverable
exists, and the worktree is untouched. The second is the interesting one. Ask
and Plan promise to change nothing, so a run that changed a file has broken its
promise, and that is exactly what a person should be shown.

"The deliverable exists" means an iteration that **completed** and left
non-empty text. A failed or cancelled iteration can still carry partial output,
and half a plan presented as ready is the same class of mistake as a green
badge on a test that never ran.

`IMPLEMENTER != APPROVER` is unchanged. What the mode alters is what counts as
evidence, never who weighs it: the agent's own assessment decides nothing in
any mode.

**Why a cold follow-up rebuilds the whole prompt.** A follow-up iteration is
deliberately short, because the agent session is resumed and repeating the task
would compete with the context it already holds. When there is no session to
resume that reasoning inverts: the agent inherits nothing, so feedback alone
would ask it to revise work it has never seen. A cold follow-up therefore
carries the mode's rules, the task, and the previous iteration's output; a
resumed one carries none of the three.

## Consequences

- Two columns on `runs`, and one migration. Rows written before this read as
  Build runs, because `mode` defaults to `'build'` and a null `resolved_mode`
  resolves to Build.
- A read-only run records no validation rows at all, rather than six
  `not_configured` ones. The scorecard says why instead of showing an empty
  grid, and "Re-run validation" is refused with a reason.
- The transformer still produces an "implementation specification" for Ask and
  Plan runs. It is useful input to both and the boundary was left alone, but the
  heading is wrong and known to be.
- Auto will misread some requests. That is survivable because the choice is
  shown before the run starts, recorded with its reason after, and switchable
  without losing the session. It is not survivable if it becomes the default,
  which is why it is not.
- No project-level default mode. It is one more column and one more form field
  for a choice already made on the screen where the run starts; if the same
  mode turns out to be picked every time for a project, that is the moment to
  add it.
