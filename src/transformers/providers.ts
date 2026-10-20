import 'server-only';

import { z } from 'zod';

import { claudeQuery } from '@/agents/claude-query';
import { checkCodexAvailable, codexQuery } from '@/agents/codex-query';
import { ClaudeCodeAgent } from '@/agents/claude-code';
import {
  COMMIT_MESSAGE_SYSTEM_PROMPT,
  SPEC_JSON_SCHEMA,
  SPEC_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  commitMessageUserPrompt,
  specUserPrompt,
  summaryUserPrompt,
} from './prompts';
import type {
  CommitMessageInput,
  CommitMessageResult,
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
      costUsd: result.costUsd,
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

    return {
      summary: result.text.trim(),
      provider: this.id,
      durationMs: result.durationMs ?? 0,
      costUsd: result.costUsd,
    };
  }

  async formatCommitMessage(input: CommitMessageInput): Promise<CommitMessageResult> {
    const result = await claudeQuery({
      prompt: commitMessageUserPrompt(input),
      systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
      model: this.model,
      effort: 'low',
      timeoutMs: 60_000,
      signal: input.signal,
    });

    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'Commit-message query failed');
    }

    return {
      subject: result.text.trim().split('\n')[0] ?? '',
      provider: this.id,
      durationMs: result.durationMs ?? 0,
    };
  }
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

  async formatCommitMessage(input: CommitMessageInput): Promise<CommitMessageResult> {
    const result = await codexQuery({
      prompt: commitMessageUserPrompt(input),
      instructions: COMMIT_MESSAGE_SYSTEM_PROMPT,
      model: this.model,
      effort: 'low',
      timeoutMs: 60_000,
      signal: input.signal,
    });

    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'Codex commit-message query failed');
    }

    return {
      subject: result.text.trim().split('\n')[0] ?? '',
      provider: this.id,
      durationMs: result.durationMs ?? 0,
    };
  }
}
