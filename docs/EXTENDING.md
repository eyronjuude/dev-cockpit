# Extending Dev Cockpit

Five boundaries are designed to be extended. Each is an interface plus a
registry, and the orchestrator only ever talks to the interface.

## Adding a transformer provider

A transformer turns a natural-language request into an implementation
specification. It handles prose only — it never sees or produces source code,
diffs, test results, stack traces, file paths, screenshots or exit codes. That
constraint is enforced by the shape of `TransformRequestInput`: there is nowhere
to put factual data.

Four providers already ship, so the fastest route is to copy the closest one:
`CodexCliTransformer` for a CLI-backed provider, `OpenAiTransformer` for an
API-backed one. Both are in `src/transformers/providers.ts`.

**1. Implement the interface** in `src/transformers/providers.ts`:

```ts
export class GeminiTransformer implements TransformerProvider {
  readonly id = 'gemini-api';
  readonly label = 'Google Gemini';
  readonly requirement = 'Requires GEMINI_API_KEY in the environment.';

  async checkAvailability(): Promise<ProviderAvailability> {
    // Report the reason, not just the verdict — Settings shows this verbatim.
    if (!process.env.GEMINI_API_KEY) {
      return { available: false, detail: 'GEMINI_API_KEY is not set.' };
    }
    return { available: true, detail: 'Configured for gemini-2.5-pro.' };
  }

  async transformRequest(input: TransformRequestInput): Promise<TransformRequestResult> {
    const start = Date.now();
    // Reuse the shared prompt contract so every provider behaves the same way.
    const { SPEC_SYSTEM_PROMPT, SPEC_JSON_SCHEMA, specUserPrompt } =
      await import('./prompts');

    // ... call the API with specUserPrompt(input) and SPEC_JSON_SCHEMA ...

    return { spec, title, provider: this.id, durationMs: Date.now() - start };
  }
}
```

**2. Register it** in `src/transformers/registry.ts`, in preference order:

```ts
const PROVIDERS: TransformerProvider[] = [
  new NoopTransformer(),
  new CodexCliTransformer(),
  new ClaudeCliTransformer(),
  new OpenAiTransformer(),
  new AnthropicApiTransformer(),
  new GeminiTransformer(),
];
```

That is all. It appears in the New Task provider list and on the Settings page,
with its availability and requirement shown.

**Contract notes.** Throw a plain `Error` with a readable message on failure —
the orchestrator catches it, records `transform.failed`, and continues with the
request as written. Never mutate `input.request`. `summariseOutcome` is optional;
omit it if the provider cannot do it.

## Adding a reviewer

A reviewer receives evidence and returns structured findings. It must be
read-only. The V1 providers make that structural rather than advisory by running
with no tools at all, and a new provider should do something equivalent.

```ts
export class MyReviewer implements ReviewerAgent {
  readonly id = 'my-reviewer';
  readonly label = 'My reviewer';
  readonly requirement = 'Requires MY_API_KEY.';
  readonly readOnly = true;

  async checkAvailability(): Promise<ReviewerAvailability> { /* ... */ }

  async review(evidence: ReviewEvidence): Promise<ReviewResult> {
    // evidence.diff is verbatim git output. Pass it through unchanged.
    // evidence.validations already contains the deterministic results — the
    // reviewer's job is what those cannot see, not restating them.
    return { provider: this.id, findings, summary, durationMs, costUsd: null };
  }
}
```

Register in `src/reviewers/registry.ts`.

**Contract notes.** Findings are opinions, not test results. They are stored in
`review_findings`, rendered separately from validation, and do not block
readiness unless a project opts in with `reviewBlocksReady`. Reuse
`buildReviewPrompt` from `src/reviewers/providers.ts` so evidence is presented
consistently — including the instruction not to repeat validation failures as
findings.

## Adding an implementation agent

`ImplementationAgent` is the largest interface, because it owns process
lifecycle as well as translation.

```ts
export class MyAgent implements ImplementationAgent {
  readonly id = 'my-agent';
  readonly label = 'My agent';

  checkAvailability(): Promise<AgentAvailability>;
  startRun(input: AgentStartInput): Promise<AgentOutcome>;
  continueRun(input: AgentContinueInput): Promise<AgentOutcome>;
  cancelRun(iterationId: string): Promise<boolean>;
  getStatus(iterationId: string): AgentRunStatus;
}
```

Register in the `AGENTS` map in `src/orchestrator/orchestrator.ts`, and set
`runs.agentProvider` when creating a run.

**Contract notes.**

- Translate the provider's native output into `AgentStreamEvent` values. Do not
  leak the wire format upwards: the orchestrator persists these, so a provider
  change must not rewrite history.
- `AgentOutcome.ok` means "the process ended without erroring". It is not an
  approval signal and nothing treats it as one.
- `continueRun` should genuinely continue the prior session. If the provider
  cannot, return a fresh session id and set `resumed: false` so the UI can say
  so honestly rather than implying context was kept.
- Honour `input.signal`. Cancellation must kill the whole process tree —
  `killTree` in `src/process/spawn.ts` handles the platform differences.
- Keep untrusted text off command lines. Use stdin, as `ClaudeCodeAgent` does.

## Adding a validator

V1 has one implementation, `CommandValidator`, which runs a configured shell
command. The interface is the plugin seam for validators that are not shell
commands — an HTTP health probe, a bundle-size budget, an accessibility audit.

```ts
export class BundleSizeValidator implements Validator {
  readonly kind = 'build';
  readonly blocking = true;

  async run(context: ValidatorContext): Promise<ValidatorOutcome> {
    // Read from context.worktreePath. Never modify it.
    return { outcome: 'pass', exitCode: 0, /* ... */ };
  }
}
```

`runValidation` in `src/validation/engine.ts` currently constructs
`CommandValidator` directly from project configuration; wiring a registry in is
the small piece of work a second validator would need.

**Contract notes.** A validator must never modify source code. Distinguish
`fail` (the check ran and did not pass) from `error` (the check could not run) —
conflating them makes a missing binary look like a broken test.

## Adding an execution profile

One entry in `PROFILES` in `src/orchestrator/profiles.ts`. A profile is a bundle
of defaults, not a code path, so nothing else changes. Add the profile name to a
validation command's `profiles` list to include that command.

## Adding an event type

Add the name to `EVENT_TYPES` and its payload to `EventPayloads` in
`src/domain/events.ts`. Add it to `PROGRESS_EVENT_TYPES` if it belongs in the
default progress feed, and give it an icon in `src/components/event-feed.tsx`.
Unlisted types still render with a fallback icon.

## Changing the schema

Edit `src/db/schema.ts`, then:

```bash
npm run db:generate
```

That writes SQL into `src/db/migrations`, which is applied automatically on the
next database open. Commit the generated SQL.
