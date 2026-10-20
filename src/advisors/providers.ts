import 'server-only';

import { z } from 'zod';

import { ClaudeCodeAgent } from '@/agents/claude-code';
import { claudeQuery } from '@/agents/claude-query';
import { checkCodexAvailable, codexQuery } from '@/agents/codex-query';
import { POSITION_STRIDE, VALIDATION_KINDS } from '@/domain/types';
import { STEP_KEY_PATTERN } from '@/domain/validation-steps';
import type { SetupProposal } from '@/services/repo-evidence';
import { SETUP_JSON_SCHEMA, SETUP_SYSTEM_PROMPT, setupUserPrompt } from './prompts';
import type {
  ProviderAvailability,
  SetupAdvisor,
  SuggestSetupInput,
  SuggestSetupResult,
} from './types';

/**
 * Advisor implementations.
 *
 * Every one of them is a refinement pass over the deterministic proposal, and
 * every one of them falls back to it rather than failing. That is the whole
 * reliability story: the worst case is the draft you would have got anyway.
 */

/* ------------------------------------------------------------------ *
 * Response validation
 * ------------------------------------------------------------------ */

const MAX_COMMAND = 500;

/**
 * The cap on how many steps a model may propose.
 *
 * Generous rather than structural: a pipeline is free-form now, so this exists
 * to bound a runaway response, not to say what a project may need. The cap that
 * still matters is on string *length* — these values become shell commands, and
 * a page of text in a command field is the failure worth refusing.
 */
const MAX_STEPS = 24;

/**
 * The response schema.
 *
 * Tighter than the JSON Schema handed to the model, because this is the one
 * that actually runs. `kind` is a closed enum so a model cannot invent a
 * seventh validation kind, `key` must match the slug pattern the database
 * indexes, and every string is length-capped.
 */

const setupResponseSchema = z.object({
  packageManager: z.string().trim().max(40).nullable(),
  setupCommand: z.string().trim().max(MAX_COMMAND).nullable(),
  developmentCommand: z.string().trim().max(MAX_COMMAND).nullable(),
  linkPaths: z.array(z.string().trim().max(200)).max(10),
  validationSteps: z
    .array(
      z.object({
        key: z.string().trim().regex(STEP_KEY_PATTERN),
        label: z.string().trim().min(1).max(80),
        // Still a closed enum, so a model cannot invent a seventh kind. Null is
        // now legal and means "fits none of them", which is a different claim
        // from inventing one.
        kind: z.enum(VALIDATION_KINDS).nullable(),
        command: z.string().trim().max(MAX_COMMAND),
        workingDir: z.string().trim().max(200).nullable(),
        blocking: z.boolean(),
      }),
    )
    .max(MAX_STEPS),
  previewWorkingDir: z.string().trim().max(200).nullable(),
  previewReadyPath: z.string().trim().max(200),
  notes: z.string().trim().max(1_500).nullable(),
  confidence: z.enum(['high', 'low']),
});

/**
 * Validates and normalises whatever a provider returned.
 *
 * Null means "unusable", which every caller turns into the deterministic
 * proposal. Exported because this is the contract a provider response has to
 * meet, and it is worth testing directly rather than only through a provider.
 */
export function normaliseAdvisorResponse(structured: unknown): SetupProposal | null {
  const parsed = setupResponseSchema.safeParse(structured);
  return parsed.success ? toProposal(parsed.data) : null;
}

/**
 * Normalises a validated response into a proposal.
 *
 * Drops blank commands and de-duplicates by key, because a key is a database
 * unique index and a result-row identity — two steps claiming one would make
 * the second silently overwrite the first's results.
 *
 * Positions are renumbered here rather than taken from the model. The order it
 * returned is honoured; the numbers it might have invented are not, so a
 * response with three steps all at position 0 still produces a pipeline that
 * runs in the order it was written.
 */
function toProposal(parsed: z.infer<typeof setupResponseSchema>): SetupProposal {
  const seen = new Set<string>();
  const steps = parsed.validationSteps.filter((step) => {
    if (!step.command) return false;
    if (seen.has(step.key)) return false;
    seen.add(step.key);
    return true;
  });

  const developmentCommand = parsed.developmentCommand || null;

  return {
    packageManager: parsed.packageManager || null,
    setupCommand: parsed.setupCommand || null,
    developmentCommand,
    linkPaths: parsed.linkPaths.filter(Boolean),
    validationSteps: steps.map((step, index) => ({
      key: step.key,
      label: step.label || step.key,
      kind: step.kind,
      command: step.command,
      workingDir: step.workingDir || null,
      position: index * POSITION_STRIDE,
      blocking: step.blocking,
    })),
    preview: {
      command: developmentCommand,
      workingDir: parsed.previewWorkingDir || null,
      readyPath: normaliseReadyPath(parsed.previewReadyPath),
    },
    notes: parsed.notes || null,
    confidence: parsed.confidence,
  };
}

/**
 * Forces a ready path to be a path.
 *
 * A model returning `http://example.com/health` here would point the readiness
 * probe at another host, so anything carrying a scheme or an authority is
 * discarded rather than corrected — there is no safe reading of it.
 */
function normaliseReadyPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function fallback(
  input: SuggestSetupInput,
  provider: string,
  reason: string,
  durationMs: number,
): SuggestSetupResult {
  return {
    proposal: input.baseline,
    provider,
    durationMs,
    fellBackTo: 'deterministic',
    fallbackReason: reason,
  };
}

/** Turns raw structured output into a result, falling back on any problem. */
function resultFrom(
  input: SuggestSetupInput,
  provider: string,
  structured: unknown,
  durationMs: number,
): SuggestSetupResult {
  const proposal = normaliseAdvisorResponse(structured);
  if (!proposal) {
    return fallback(
      input,
      provider,
      'The provider returned a response that did not match the schema.',
      durationMs,
    );
  }
  return { proposal, provider, durationMs, fellBackTo: null, fallbackReason: null };
}

/* ------------------------------------------------------------------ *
 * none — the default
 * ------------------------------------------------------------------ */

/**
 * No model. Returns the deterministic proposal as it stands.
 *
 * The default, so registering a project gets a usable draft on a machine with
 * no CLI and no API key. Most repositories are unambiguous enough that this is
 * the right answer anyway: a `build` script beside a `pnpm-lock.yaml` needs no
 * inference.
 */
export class DeterministicAdvisor implements SetupAdvisor {
  readonly id = 'none';
  readonly label = 'None (detect from the repository only)';
  readonly requirement = 'No configuration needed.';

  async checkAvailability(): Promise<ProviderAvailability> {
    return { available: true, detail: 'Always available.' };
  }

  async suggestSetup(input: SuggestSetupInput): Promise<SuggestSetupResult> {
    return {
      proposal: input.baseline,
      provider: this.id,
      durationMs: 0,
      fellBackTo: null,
      fallbackReason: null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * claude-cli — reuses the local Claude Code authentication
 * ------------------------------------------------------------------ */

/**
 * Refines through a read-only single-shot `claude --print` query.
 *
 * First real provider for the same reason the transformer layer chose it: no
 * API key, so a machine that can run implementation runs can already run this.
 */
export class ClaudeCliAdvisor implements SetupAdvisor {
  readonly id = 'claude-cli';
  readonly label = 'Claude Code CLI (local auth)';
  readonly requirement = 'Requires the Claude Code CLI on PATH. Uses its existing login.';

  constructor(
    private readonly model: string | null = null,
    private readonly effort: string = 'low',
  ) {}

  async checkAvailability(): Promise<ProviderAvailability> {
    const availability = await new ClaudeCodeAgent().checkAvailability();
    return { available: availability.available, detail: availability.detail };
  }

  async suggestSetup(input: SuggestSetupInput): Promise<SuggestSetupResult> {
    const result = await claudeQuery({
      prompt: setupUserPrompt(input),
      systemPrompt: SETUP_SYSTEM_PROMPT,
      jsonSchema: SETUP_JSON_SCHEMA,
      model: this.model,
      effort: this.effort,
      timeoutMs: 120_000,
      signal: input.signal,
    });

    const durationMs = result.durationMs ?? 0;
    if (!result.ok) {
      return fallback(input, this.id, result.error ?? 'The query failed.', durationMs);
    }
    return resultFrom(input, this.id, result.structured, durationMs);
  }
}

/* ------------------------------------------------------------------ *
 * codex-cli — reuses the local Codex CLI authentication
 * ------------------------------------------------------------------ */

export class CodexCliAdvisor implements SetupAdvisor {
  readonly id = 'codex-cli';
  readonly label = 'Codex CLI (ChatGPT plan)';
  readonly requirement =
    'Requires the Codex CLI on PATH and a completed `codex login`. Uses your ChatGPT plan, not an API key.';

  constructor(
    private readonly model: string | null = null,
    private readonly effort: string = 'low',
  ) {}

  async checkAvailability(): Promise<ProviderAvailability> {
    const availability = await checkCodexAvailable();
    return { available: availability.available, detail: availability.detail };
  }

  async suggestSetup(input: SuggestSetupInput): Promise<SuggestSetupResult> {
    const result = await codexQuery({
      prompt: setupUserPrompt(input),
      instructions: SETUP_SYSTEM_PROMPT,
      jsonSchema: SETUP_JSON_SCHEMA,
      model: this.model,
      effort: this.effort,
      timeoutMs: 120_000,
      signal: input.signal,
    });

    const durationMs = result.durationMs ?? 0;
    if (!result.ok) {
      return fallback(input, this.id, result.error ?? 'The query failed.', durationMs);
    }
    return resultFrom(input, this.id, result.structured, durationMs);
  }
}
