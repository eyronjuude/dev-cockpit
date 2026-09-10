import 'server-only';

import { z } from 'zod';

import { ClaudeCodeAgent } from '@/agents/claude-code';
import { claudeQuery } from '@/agents/claude-query';
import { checkCodexAvailable, codexQuery } from '@/agents/codex-query';
import { VALIDATION_KINDS } from '@/domain/types';
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
 * The response schema.
 *
 * Tighter than the JSON Schema handed to the model, because this is the one
 * that actually runs. `kind` is a closed enum so a model cannot invent a
 * seventh validation kind, and every string is length-capped so a runaway
 * response cannot land a page of text in a command field.
 */
const setupResponseSchema = z.object({
  packageManager: z.string().trim().max(40).nullable(),
  setupCommand: z.string().trim().max(MAX_COMMAND).nullable(),
  developmentCommand: z.string().trim().max(MAX_COMMAND).nullable(),
  linkPaths: z.array(z.string().trim().max(200)).max(10),
  validationCommands: z
    .array(
      z.object({
        kind: z.enum(VALIDATION_KINDS),
        command: z.string().trim().max(MAX_COMMAND),
        workingDir: z.string().trim().max(200).nullable(),
      }),
    )
    .max(VALIDATION_KINDS.length * 2),
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
 * Drops blank commands and keeps only the first entry per kind, because the
 * form has exactly one field per kind and a duplicate would silently overwrite
 * the other.
 */
function toProposal(parsed: z.infer<typeof setupResponseSchema>): SetupProposal {
  const seen = new Set<string>();
  const validationCommands = parsed.validationCommands.filter((c) => {
    if (!c.command) return false;
    if (seen.has(c.kind)) return false;
    seen.add(c.kind);
    return true;
  });

  return {
    packageManager: parsed.packageManager || null,
    setupCommand: parsed.setupCommand || null,
    developmentCommand: parsed.developmentCommand || null,
    linkPaths: parsed.linkPaths.filter(Boolean),
    validationCommands: validationCommands.map((c) => ({
      kind: c.kind,
      command: c.command,
      workingDir: c.workingDir || null,
    })),
    notes: parsed.notes || null,
    confidence: parsed.confidence,
  };
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

/* ------------------------------------------------------------------ *
 * anthropic-api — direct Messages API
 * ------------------------------------------------------------------ */

function extractText(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

export class AnthropicApiAdvisor implements SetupAdvisor {
  readonly id = 'anthropic-api';
  readonly label = 'Anthropic API';
  readonly requirement = 'Requires ANTHROPIC_API_KEY in the environment.';

  constructor(private readonly model: string = 'claude-opus-5') {}

  async checkAvailability(): Promise<ProviderAvailability> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { available: false, detail: 'ANTHROPIC_API_KEY is not set.' };
    }
    return { available: true, detail: `Configured for ${this.model}.` };
  }

  async suggestSetup(input: SuggestSetupInput): Promise<SuggestSetupResult> {
    const start = Date.now();
    if (!process.env.ANTHROPIC_API_KEY) {
      return fallback(input, this.id, 'ANTHROPIC_API_KEY is not set.', 0);
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic();
      const response = await client.messages.create(
        {
          model: this.model,
          max_tokens: 2_000,
          system: SETUP_SYSTEM_PROMPT,
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: SETUP_JSON_SCHEMA as Record<string, unknown> },
          },
          messages: [{ role: 'user', content: setupUserPrompt(input) }],
        } as never,
        input.signal ? { signal: input.signal } : undefined,
      );

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractText(response));
      } catch {
        return fallback(input, this.id, 'The API returned output that was not JSON.', Date.now() - start);
      }
      return resultFrom(input, this.id, parsedJson, Date.now() - start);
    } catch (err) {
      return fallback(
        input,
        this.id,
        err instanceof Error ? err.message : String(err),
        Date.now() - start,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * openai-api — direct Responses API
 * ------------------------------------------------------------------ */

export class OpenAiAdvisor implements SetupAdvisor {
  readonly id = 'openai-api';
  readonly label = 'OpenAI API';
  readonly requirement = 'Requires OPENAI_API_KEY in the environment. Metered per token.';

  constructor(private readonly model: string = 'gpt-5.6') {}

  async checkAvailability(): Promise<ProviderAvailability> {
    if (!process.env.OPENAI_API_KEY) {
      return { available: false, detail: 'OPENAI_API_KEY is not set.' };
    }
    return { available: true, detail: `Configured for ${this.model}.` };
  }

  async suggestSetup(input: SuggestSetupInput): Promise<SuggestSetupResult> {
    const start = Date.now();
    if (!process.env.OPENAI_API_KEY) {
      return fallback(input, this.id, 'OPENAI_API_KEY is not set.', 0);
    }

    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI();
      const response = await client.responses.create(
        {
          model: this.model,
          instructions: SETUP_SYSTEM_PROMPT,
          input: setupUserPrompt(input),
          text: {
            format: {
              type: 'json_schema',
              name: 'project_setup_proposal',
              schema: SETUP_JSON_SCHEMA as unknown as Record<string, unknown>,
              strict: true,
            },
          },
        },
        input.signal ? { signal: input.signal } : undefined,
      );

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(response.output_text);
      } catch {
        return fallback(input, this.id, 'The API returned output that was not JSON.', Date.now() - start);
      }
      return resultFrom(input, this.id, parsedJson, Date.now() - start);
    } catch (err) {
      return fallback(
        input,
        this.id,
        err instanceof Error ? err.message : String(err),
        Date.now() - start,
      );
    }
  }
}
