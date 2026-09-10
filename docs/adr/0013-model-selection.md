# ADR 0013 — A profile recommends a model, and the model wins over the effort

**Status:** accepted

## Context

An execution profile set an effort level and a timeout and left the model
alone. The model came from one place only — `agent_model` on the project, a
free-text field, blank in most projects — so every profile ran whatever Claude
Code picked for itself. "Quick" and "Deep" therefore differed by a flag value
and a clock, on identical hardware.

That is half a statement. Effort and model are one purchase: `xhigh` on a small
fast model is not the same spend as `medium` on a frontier one, and a profile
that raises effort while leaving the model to chance has said only that it would
like to try harder. The obvious pairing — fast model for Quick, frontier model
for Deep — was the thing the profile could not express.

Two constraints made this more than a lookup table.

**Models do not all accept the same effort levels.** Haiku 4.5 accepts none at
all, and sending one is rejected rather than ignored. So a naive "profile sets
effort, user sets model" design produces combinations that fail at launch, and
Quick-on-Haiku — the single most obvious pairing — is one of them.

**A model id belongs to the vendor that named it.** Runs already fall back to
the Codex CLI when Claude Code is out of capacity, and the old resolution
handed the stored model to the fallback whenever the run's provider matched,
which meant a project pinning a Codex model would have passed it to Claude Code
on the way back. `--model claude-opus-5` on the Codex CLI fails the launch, and
a capacity fallback exists precisely to keep a run moving.

## Decision

**A profile recommends a model. Three levels of precedence decide which one
runs, and where a model will not accept the profile's effort, the effort
moves.**

### Precedence

Most specific statement wins: the run, then the project, then the profile, then
the provider's own default.

| Set on | Applies to |
| --- | --- |
| New Task → Model | one run |
| Project → Model | every run in that project |
| The execution profile | runs that pin nothing |

A recommendation is deliberately the weakest of the three. It is a suggestion
attached to a level of effort; a project-wide default and a per-run pick are
someone actually deciding.

Resolution happens **when the run is created**, and the answer is written to
`runs.agent_model`. Same reason the provider choices are stored per run (ADR
0005): changing a project default, or the recommendation attached to a profile,
must not retroactively change what an existing run reports having used. It also
means the model the New Task screen showed is the model on the row.

### The model wins over the effort

Choosing a model is a deliberate act; effort is a dial on a profile. So a
mismatch is resolved by moving the dial — never by refusing the model, and never
by quietly swapping it back. `resolveAgentEffort` clamps the profile's level to
the nearest one the model accepts, and drops the flag entirely for a model that
accepts none.

That is what makes "Deep, but on Haiku" a selectable thing rather than an error
message, and it answers the case the request named directly: a model override
holds even at maximum effort.

A model this build does not recognise is left entirely alone. Guessing at the
effort range of a model released after this code was written would turn a
working combination into a clamped one, so an unknown id is passed through with
the profile's level intact.

### Only Claude Code has a catalogue

`AGENT_MODELS` lists Claude Code models and nothing else. Codex is reached only
as a capacity fallback and stays on its own CLI default there — its default is
tuned for agentic coding, so pinning a general model would be a downgrade, and
pinning a specific id would be guessing at a lineup this app does not track.
`modelForProvider` is what enforces it: a provider that did not name the stored
model gets its own recommendation or its own default, never an id from another
vendor.

An unknown id is still passed through, but only to the provider the run
selected. It is most likely a model newer than this build, and second-guessing
the user there would be worse than trying it. Sending it to a different
vendor's CLI would not be.

## Consequences

**A project with no model configured changes behaviour.** It used to run Claude
Code's default at the profile's effort; it now runs the profile's recommended
model. That is the point of the change, and the New Task screen states the
model and the effort before the run starts, but it is a real change to existing
projects rather than a new opt-in feature. A project that wants the old
behaviour back sets its own model.

**Quick sends no effort flag by default.** Its recommendation is Haiku 4.5,
which accepts none. The speed now comes from what is running rather than from
how hard it is told to try.

**`agent.started` records the effort it actually sent.** "Deep" on a run no
longer implies `xhigh` reached the CLI, and a log that stated only the profile
would be lying by omission.

**A dated snapshot resolves to its family.** The provider reports back the id it
resolved and the orchestrator writes that onto the run, so the second iteration
of a run usually reads something like `claude-haiku-4-5-20251001`. Without
family matching, `resolveAgentEffort` would re-add a flag it correctly dropped
an iteration earlier. A date suffix and nothing else counts:
`claude-opus-5-1` is a different model from `claude-opus-5`, not a build of it.

**Model ids in this repository are a cached fact.** They are strings passed to
someone else's CLI, and a model retired upstream fails at launch rather than
degrading. `AGENT_MODELS` is one list in one pure module for exactly that
reason — and the free-text field is the escape hatch when it goes stale.
