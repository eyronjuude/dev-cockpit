import 'server-only';

import { z } from 'zod';

import { claudeQuery } from '@/agents/claude-query';
import { checkCodexAvailable, codexQuery } from '@/agents/codex-query';
import { ClaudeCodeAgent } from '@/agents/claude-code';
import {
  SPEC_JSON_SCHEMA,
  SPEC_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  specUserPrompt,
  summaryUserPrompt,
} from './prompts';
import type {
  ProviderAvailability,
  SummariseInput,
  SummariseResult,
  TransformRequestInput,
  TransformRequestResult,
  TransformerProvider,
} from './types';

const specResponseSchema = z.object({
  title: z.string().min(1).max(200),
  spec: z.string().min(1),
});

/* ------------------------------------------------------------------ *
 * none — the default
 * ------------------------------------------------------------------ */

/**
 * No transformation. The orchestrator uses the request verbatim.
 *
 * This is the default so that the application is fully functional with nothing
 * configured, which is the point of the transformer being optional.
 */
export class NoopTransformer implements TransformerProvider {
  readonly id = 'none';
  readonly label = 'None (use the request as written)';
  readonly requirement = 'No configuration needed.';

  async checkAvailability(): Promise<ProviderAvailability> {
    return { available: true, detail: 'Always available.' };
  }

  async transformRequest(input: TransformRequestInput): Promise<TransformRequestResult> {
    return {
      spec: input.request,
      title: null,
      provider: this.id,
      durationMs: 0,
    };
  }
}

/* ------------------------------------------------------------------ *
 * claude-cli — reuses the local Claude Code authentication
 * ------------------------------------------------------------------ */

/**
 * Transforms via a read-only single-shot `claude --print` query.
 *
 * Chosen as the first real provider because it needs no API key: a machine that
 * can run implementation runs at all can already run this.
 */
export class ClaudeCliTransformer implements TransformerProvider {
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

  async transformRequest(input: TransformRequestInput): Promise<TransformRequestResult> {
    const result = await claudeQuery({
      prompt: specUserPrompt(input),
      systemPrompt: SPEC_SYSTEM_PROMPT,
      jsonSchema: SPEC_JSON_SCHEMA,
      model: this.model,
      effort: this.effort,
      timeoutMs: 180_000,
      signal: input.signal,
    });

    if (!result.ok) throw new Error(result.error ?? 'Transformer query failed');

    const parsed = specResponseSchema.safeParse(result.structured);
    if (!parsed.success) {
      throw new Error('Transformer returned a response that did not match the schema');
    }

    return {
      spec: parsed.data.spec,
      title: parsed.data.title,
      provider: this.id,
      durationMs: result.durationMs ?? 0,
    };
  }

  async summariseOutcome(input: SummariseInput): Promise<SummariseResult> {
    const result = await claudeQuery({
      prompt: summaryUserPrompt(input),
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      model: this.model,
      effort: 'low',
      timeoutMs: 120_000,
      signal: input.signal,
    });

    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'Summary query failed');
    }

    return { summary: result.text.trim(), provider: this.id, durationMs: result.durationMs ?? 0 };
  }
}

/* ------------------------------------------------------------------ *
 * anthropic-api — direct Messages API
 * ------------------------------------------------------------------ */

/**
 * Transforms through the Anthropic Messages API.
 *
 * Needs ANTHROPIC_API_KEY. Kept separate from the CLI provider so neither is a
 * prerequisite for the other, and so a future OpenAI provider has an obvious
 * shape to copy: construct a client lazily, map to the same result type, throw
 * a plain message on failure.
 */
export class AnthropicApiTransformer implements TransformerProvider {
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

  private async client() {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic();
  }

  async transformRequest(input: TransformRequestInput): Promise<TransformRequestResult> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    const start = Date.now();
    const client = await this.client();

    const response = await client.messages.create(
      {
        model: this.model,
        max_tokens: 4_000,
        system: SPEC_SYSTEM_PROMPT,
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: SPEC_JSON_SCHEMA as Record<string, unknown> },
        },
        messages: [{ role: 'user', content: specUserPrompt(input) }],
      } as never,
      input.signal ? { signal: input.signal } : undefined,
    );

    const text = extractText(response);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new Error('Anthropic API returned output that was not JSON');
    }

    const parsed = specResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error('Anthropic API response did not match the schema');
    }

    return {
      spec: parsed.data.spec,
      title: parsed.data.title,
      provider: this.id,
      durationMs: Date.now() - start,
    };
  }

  async summariseOutcome(input: SummariseInput): Promise<SummariseResult> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    const start = Date.now();
    const client = await this.client();

    const response = await client.messages.create(
      {
        model: this.model,
        max_tokens: 1_000,
        system: SUMMARY_SYSTEM_PROMPT,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: summaryUserPrompt(input) }],
      } as never,
      input.signal ? { signal: input.signal } : undefined,
    );

    return {
      summary: extractText(response).trim(),
      provider: this.id,
      durationMs: Date.now() - start,
    };
  }
}

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

/* ------------------------------------------------------------------ *
 * codex-cli — reuses the local Codex CLI authentication (ChatGPT plan)
 * ------------------------------------------------------------------ */

/**
 * Transforms and summarises via a read-only single-shot `codex exec`.
 *
 * The OpenAI counterpart of `ClaudeCliTransformer`, and chosen for the same
 * reason: it needs no API key, because it reuses the Codex CLI's own ChatGPT
 * sign-in. Usage counts against the ChatGPT plan rather than API credits.
 *
 * The model is pinned rather than left on the CLI default, which may be a
 * codex-specialised model tuned for agentic coding rather than for reading
 * prose. Pass a general model to get behaviour closer to chatgpt.com.
 */
export class CodexCliTransformer implements TransformerProvider {
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

  async transformRequest(input: TransformRequestInput): Promise<TransformRequestResult> {
    const result = await codexQuery({
      prompt: specUserPrompt(input),
      instructions: SPEC_SYSTEM_PROMPT,
      jsonSchema: SPEC_JSON_SCHEMA,
      model: this.model,
      effort: this.effort,
      timeoutMs: 180_000,
      signal: input.signal,
    });

    if (!result.ok) throw new Error(result.error ?? 'Codex transformer query failed');

    const parsed = specResponseSchema.safeParse(result.structured);
    if (!parsed.success) {
      throw new Error('Codex returned a response that did not match the schema');
    }

    return {
      spec: parsed.data.spec,
      title: parsed.data.title,
      provider: this.id,
      durationMs: result.durationMs ?? 0,
    };
  }

  async summariseOutcome(input: SummariseInput): Promise<SummariseResult> {
    const result = await codexQuery({
      prompt: summaryUserPrompt(input),
      instructions: SUMMARY_SYSTEM_PROMPT,
      model: this.model,
      effort: 'low',
      timeoutMs: 120_000,
      signal: input.signal,
    });

    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'Codex summary query failed');
    }

    return { summary: result.text.trim(), provider: this.id, durationMs: result.durationMs ?? 0 };
  }
}

/* ------------------------------------------------------------------ *
 * openai-api — direct Responses API
 * ------------------------------------------------------------------ */

/**
 * Transforms and summarises through the OpenAI Responses API.
 *
 * Needs OPENAI_API_KEY and is metered per token. The reason to prefer it over
 * the CLI is control rather than quality: the instruction goes in a real system
 * slot, there is no agent harness in the way, and the model and effort are
 * exactly what you asked for.
 */
export class OpenAiTransformer implements TransformerProvider {
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

  private async client() {
    const { default: OpenAI } = await import('openai');
    return new OpenAI();
  }

  async transformRequest(input: TransformRequestInput): Promise<TransformRequestResult> {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    const start = Date.now();
    const client = await this.client();

    const response = await client.responses.create(
      {
        model: this.model,
        instructions: SPEC_SYSTEM_PROMPT,
        input: specUserPrompt(input),
        text: {
          format: {
            type: 'json_schema',
            name: 'implementation_specification',
            schema: SPEC_JSON_SCHEMA as unknown as Record<string, unknown>,
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
      throw new Error('OpenAI returned output that was not JSON');
    }

    const parsed = specResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error('OpenAI response did not match the schema');
    }

    return {
      spec: parsed.data.spec,
      title: parsed.data.title,
      provider: this.id,
      durationMs: Date.now() - start,
    };
  }

  async summariseOutcome(input: SummariseInput): Promise<SummariseResult> {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    const start = Date.now();
    const client = await this.client();

    const response = await client.responses.create(
      {
        model: this.model,
        instructions: SUMMARY_SYSTEM_PROMPT,
        input: summaryUserPrompt(input),
      },
      input.signal ? { signal: input.signal } : undefined,
    );

    const summary = response.output_text.trim();
    if (!summary) throw new Error('OpenAI returned an empty summary');

    return { summary, provider: this.id, durationMs: Date.now() - start };
  }
}
