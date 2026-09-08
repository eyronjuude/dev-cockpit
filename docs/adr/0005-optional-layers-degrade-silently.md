# 0005 — Transformer and reviewer are optional and fail soft

**Status:** accepted

## Context

Both layers improve a run and neither is essential. Requiring an API key for
either would make the application useless on a machine that has Claude Code but
no key.

## Decision

`TransformerProvider` and `ReviewerAgent` are interfaces with registries. Each
provider reports its own availability and what it needs. Unavailability, or a
thrown error, produces a `transform.skipped` / `review.skipped` event and the
run continues.

Three transformer providers ship: `none` (the default), `claude-cli`,
`anthropic-api`. Two reviewers: `claude-cli`, `anthropic-api`. The New Task
screen preselects whatever is actually available on the machine.

## Why

- Graceful fallback was prioritised over integration depth, so the vertical
  slice never depends on optional configuration.
- The `claude-cli` providers make both layers work with no API key, by reusing
  the CLI's existing login. That turns "architecture with a stub" into
  "architecture with a working default".
- Showing an unavailable provider with its reason is more useful than hiding it.

## Consequences

- The reviewer is the same model family as the implementer. Stated plainly in
  the code: separate process, no shared session, no tools, no repository access
  beyond the diff — a different class of check than self-assessment, but not an
  independent vendor.
- `anthropic-api` is implemented but has never executed, since no key was
  available. Documented as untested rather than claimed as working.
