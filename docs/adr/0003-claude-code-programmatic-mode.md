# 0003 — Drive Claude Code through print mode with stream-json

**Status:** accepted

## Context

Claude Code needed to be driven programmatically, with events captured as
structured data rather than terminal output, and with sessions resumable so a
follow-up request keeps its context.

Options: the Claude Agent SDK, the CLI's print mode, or terminal scraping.

## Decision

Spawn the CLI:

```
claude --print --output-format stream-json --verbose
       --session-id <uuid> | --resume <id>
       --permission-mode acceptEdits --permission-prompts none
```

The prompt is written to stdin, not passed as an argument. `ImplementationAgent`
wraps this so another provider can be added without touching the orchestrator.

## Why

- The CLI is already installed and authenticated on the target machine, so no
  API key is needed. The Agent SDK bundles its own binary and its own auth
  resolution.
- `stream-json` is newline-delimited JSON with a stable, documented shape.
  Nothing parses ANSI escapes or screen positions.
- `--resume` was verified to preserve both the session id and its context, which
  is the whole basis of the change-request flow.
- Passing the prompt over stdin removes the largest injection surface entirely
  rather than trying to escape it.

## Consequences

- The integration depends on the CLI's flags. Version-sensitive, so the parser
  ignores unknown message types instead of failing, and availability is checked
  before every run with the resolved path and version reported honestly.
- Windows needed an executable resolver. See ADR 0006.
