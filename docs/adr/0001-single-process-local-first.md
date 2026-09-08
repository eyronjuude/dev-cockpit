# 0001 — One local process, not a distributed system

**Status:** accepted

## Context

The application coordinates long-running child processes, needs real-time UI
updates, and must survive restarts. Those requirements often lead to a queue, a
worker pool and a message broker.

## Decision

One Next.js process holds the UI, the orchestrator and the child processes.
SQLite for persistence, an in-process EventEmitter for fan-out, SSE for the
browser. Bound to `127.0.0.1`.

## Why

This is a single-user tool on one machine. A broker would add a component that
can fail independently, and every failure would become harder to see rather than
easier. The orchestration is I/O-bound waiting on subprocesses, so there is no
throughput problem to solve.

## Consequences

- A restart kills in-flight runs. Handled explicitly: such runs are reconciled
  to `FAILED` with a clear reason, and the session id and worktree survive so
  the run can be continued.
- Long-lived state lives in module scope, parked on `globalThis` so dev-mode
  module reloading does not duplicate it.
- The boundaries are still interfaces with registries behind them, so a future
  extraction is a matter of moving code rather than redesigning it.
