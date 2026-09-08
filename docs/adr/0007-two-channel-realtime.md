# 0007 — Events and snapshot are separate channels

**Status:** accepted

## Context

The run screen must stay current during a run that can last an hour: a progress
feed, a validation scorecard, and action buttons whose availability depends on
run state.

## Decision

- `GET /api/runs/:id/events` — SSE. Replays from the client's cursor, then
  tails. Drives the progress feed.
- `GET /api/runs/:id/snapshot` — full current state. Drives everything else.

Event `seq` is the cursor. Snapshot fetches are coalesced and prioritised:
status, validation and review events refresh within 60ms, tool chatter waits
900ms.

## Why

Folding events into client-side run state is where a live view drifts from the
database — the client would need to reimplement the readiness rules, and any bug
there would show the user something the orchestrator does not believe. Fetching
the state the server actually computed removes that class of bug entirely.

The cursor makes reconnects and reloads lossless, which also means the SSE
endpoint needs no replay buffer: persistence already is one.

## Consequences

- More HTTP requests than a pure event stream. Negligible on localhost, and
  coalescing keeps it to roughly one per meaningful change.
- The client holds two pieces of state. The seam is clear: events are a list,
  the snapshot is the truth.
