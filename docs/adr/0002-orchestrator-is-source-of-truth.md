# 0002 — The orchestrator owns readiness, not the agent

**Status:** accepted

## Context

A coding agent will say it is finished. It is frequently right and occasionally
wrong, and it has no way to be sure — it cannot run the checks that have not run
yet.

## Decision

Run status is computed from stored state. `assessReadiness(run, project)` is a
pure function over persisted validation results, review findings, the changed
file list and the project's policies. The agent's closing message is stored as a
claim and labelled as one in the UI: "a claim, not evidence — validation is
recorded separately".

`setStatus` is the only write path for status, it enforces a transition table,
and it appends an event on every change. `DRAFT → READY` is not a legal
transition.

## Why

Completion is a factual question with a factual answer: did the configured
commands exit zero. Deriving it from anything else makes the system unreliable
in exactly the case that matters — when the agent is confidently wrong.

## Consequences

- A run can be `NEEDS_CHANGES` while the agent reports success. Verified in
  practice: lint exit 1 against a clean agent summary.
- Validation must run before readiness can be assessed, which costs wall-clock
  time on every run.
- The user can override and approve a not-ready run. The dialog enumerates what
  is being overridden. The user is the approver; the goal is deliberateness, not
  obstruction.
