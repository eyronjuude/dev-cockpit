# 0008 — ChatGPT via Codex CLI for interpretation and cross-vendor review

**Status:** accepted

## Context

Two separate problems, one answer.

First, `summariseOutcome` was defined on `TransformerProvider` and implemented in
both providers, but the orchestrator never called it. The seam existed; the
feature did not.

Second, ADR 0005 left an acknowledged weakness: every reviewer shipped was the
same model family as the implementer. Separate process, no tools, no repository
access — but not an independent vendor.

The request was for ChatGPT to interpret Claude Code's closing messages. That
turns out to fix both.

## Decision

Wire the hook, and add two OpenAI-backed providers to each registry.

`codex-cli` uses the Codex CLI, which signs in with a ChatGPT account:

```
codex exec -                    # prompt over stdin, never on a command line
  --sandbox read-only           # Codex is an agent; this is the read-only guarantee
  --output-schema <file>        # structured response
  --output-last-message <file>  # where the answer lands
  --ignore-user-config --ignore-rules   # a target repo cannot inject instructions
  --ephemeral                   # stays out of session history
  --model <model>  -c model_reasoning_effort=<level>
```

`openai-api` uses the Responses API with `text.format.type: 'json_schema'` and
`reasoning.effort`, for people who would rather pay per token and control the
system slot exactly.

Both registries now prefer the cross-vendor option first, and the New Task
screen preselects whatever is actually available.

The interpreted summary is stored in `iterations.summary` **beside**
`iterations.final_text`, never replacing it, and the UI shows the original
underneath in a collapsed panel.

## Why the CLI first

Same reasoning as ADR 0005, and it held up: a provider that needs no API key
works on a machine that already has the subscription. The pattern is also the
one third-party integrations are expected to use — delegate to the local CLI,
never handle vendor credentials, never offer a vendor-login flow.

## Why this is not the same as chatgpt.com

Worth stating plainly, because it was asked directly.

| Difference | Closable? |
| --- | --- |
| chatgpt.com wraps input in the consumer product prompt; Codex wraps it in an agentic coding prompt | Partly — the output schema constrains far more than the ambient prompt does |
| chatgpt.com routes to the general model lineup; Codex may default to a codex-tuned model | Yes — `--model` accepts general models, so pin it |
| chatgpt.com chooses reasoning effort for you | Yes — `-c model_reasoning_effort=<level>` |

The one real fidelity loss versus the Claude adapter: Claude Code has
`--system-prompt`, which replaces the system prompt outright. Codex has no
equivalent, so the instruction is prepended to the prompt body. With a strict
output schema this costs predictability, not quality.

A schema-constrained single shot is in fact *more* consistent than a chat turn
on chatgpt.com. What it gives up is conversational polish, which a three-sentence
factual summary does not want.

## Consequences

- The transformer boundary now has four real providers and the reviewer three,
  all reporting availability honestly. Nothing is required.
- `openai-api` and `anthropic-api` remain untested — no keys were available.
  `codex-cli` is untested end to end for the same reason: the CLI is not
  installed on the development machine, and `codex login` is interactive. Its
  unavailable path *is* tested, and its flags were taken from the current
  published docs rather than recalled.
- The summariser was verified against `claude-cli`: 6.1s, every fact from a
  six-line agent message preserved, padding dropped, and no assertion that
  anything passed. The wiring was then verified on a real run, which produced
  both artifacts and left `final_text` byte-identical.
- One coupling to watch: a 2025 Windows issue had Codex's ChatGPT sign-in
  auto-minting a billable API key. Closed, and current docs say CLI auth is
  reused, but worth confirming before trusting the subscription path.
