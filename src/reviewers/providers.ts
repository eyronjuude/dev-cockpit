import 'server-only';

import { z } from 'zod';

import { ClaudeCodeAgent } from '@/agents/claude-code';
import { claudeQuery } from '@/agents/claude-query';
import { checkCodexAvailable, codexQuery } from '@/agents/codex-query';
import { FINDING_SEVERITIES } from '@/domain/types';
import type {
  ReviewEvidence,
  ReviewFinding,
  ReviewResult,
  ReviewerAgent,
  ReviewerAvailability,
} from './types';

const REVIEW_SYSTEM_PROMPT = `You are an independent reviewer of a code change. You did not write it.

You are given the original request, an optional specification, the unified diff, and the results of deterministic validation that has already run.

Rules:
- Report only what the diff shows. Never speculate about code you cannot see.
- Do not repeat a deterministic validation failure as a finding. Those are already known facts; your job is what the tools cannot see.
- Judge whether the change actually does what was asked, and whether it introduces a defect, a security problem, or an obvious regression.
- Anchor every finding to a file, and a line where the diff gives you one.
- Prefer no findings to weak findings. An empty list is a valid and useful answer.
- Severity: "critical" and "high" mean a real defect a developer must address before shipping. "medium" is a genuine concern. "low" and "info" are observations.
- You cannot modify anything and must not propose that you do. Suggestions are advice for the developer.`;

const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two sentences at most on whether the change does what was asked.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
          title: { type: 'string', description: 'One line.' },
          detail: { type: 'string', description: 'Why it matters. Two or three sentences.' },
          file: { type: 'string', description: 'Repository-relative path, or empty.' },
          line: { type: 'integer', description: 'Line number, or 0 when unknown.' },
          suggestion: { type: 'string', description: 'Advice for the developer, or empty.' },
        },
        required: ['severity', 'title', 'detail', 'file', 'line', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
} as const;

const reviewResponseSchema = z.object({
  summary: z.string().default(''),
  findings: z
    .array(
      z.object({
        severity: z.enum(FINDING_SEVERITIES),
        title: z.string().min(1),
        detail: z.string().default(''),
        file: z.string().default(''),
        line: z.number().int().default(0),
        suggestion: z.string().default(''),
      }),
    )
    .default([]),
});

const MAX_DIFF_CHARS = 180_000;

/** Builds the reviewer prompt. Evidence goes in verbatim; nothing is rewritten. */
export function buildReviewPrompt(evidence: ReviewEvidence): string {
  const sections: string[] = [];

  sections.push(`# Original request\n\n${evidence.request}`);

  if (evidence.spec?.trim()) {
    sections.push(`# Specification\n\n${evidence.spec}`);
  }

  if (evidence.changedFiles.length > 0) {
    const list = evidence.changedFiles
      .map((f) => `- ${f.path} (${f.changeType}, +${f.additions}/-${f.deletions})`)
      .join('\n');
    sections.push(`# Changed files\n\n${list}`);
  }

  if (evidence.validations.length > 0) {
    const list = evidence.validations
      .map((v) => {
        const head = `- ${v.kind}: ${v.outcome}${
          v.exitCode === null ? '' : ` (exit ${v.exitCode})`
        }`;
        if (!v.excerpt) return head;
        return `${head}\n  Output tail:\n\`\`\`\n${v.excerpt}\n\`\`\``;
      })
      .join('\n');
    sections.push(
      `# Deterministic validation already run\n\nThese are facts. Do not restate them as findings.\n\n${list}`,
    );
  }

  if (evidence.agentSummary?.trim()) {
    sections.push(
      `# Implementer's own closing note\n\nTreat this as a claim, not evidence.\n\n${evidence.agentSummary}`,
    );
  }

  let diff = evidence.diff;
  let truncationNote = '';
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncationNote =
      '\n\n(The diff was truncated for length. Do not report findings about code you cannot see.)';
  }
  sections.push(`# Diff\n\n\`\`\`diff\n${diff}\n\`\`\`${truncationNote}`);

  return sections.join('\n\n');
}

function toFindings(parsed: z.infer<typeof reviewResponseSchema>): ReviewFinding[] {
  return parsed.findings.map((f) => ({
    severity: f.severity,
    title: f.title.trim(),
    detail: f.detail.trim() || null,
    file: f.file.trim() || null,
    line: f.line > 0 ? f.line : null,
    suggestion: f.suggestion.trim() || null,
  }));
}

/* ------------------------------------------------------------------ *
 * claude-cli
 * ------------------------------------------------------------------ */

/**
 * Reviews via a read-only `claude --print` query with every tool removed.
 *
 * Independence here is limited and stated plainly: it is the same model family
 * as the implementer, in a separate process with no shared session, no tools,
 * and no access to the repository beyond the diff it is handed. That catches
 * a different class of problem than the implementer's own self-assessment, but
 * it is not an independent vendor. Configure `anthropic-api` with a different
 * model, or add a provider, when that matters.
 */
export class ClaudeCliReviewer implements ReviewerAgent {
  readonly id = 'claude-cli';
  readonly label = 'Claude Code CLI (local auth, no tools)';
  readonly requirement = 'Requires the Claude Code CLI on PATH. Uses its existing login.';
  readonly readOnly = true;

  constructor(
    private readonly model: string | null = null,
    private readonly effort: string = 'medium',
  ) {}

  async checkAvailability(): Promise<ReviewerAvailability> {
    const availability = await new ClaudeCodeAgent().checkAvailability();
    return { available: availability.available, detail: availability.detail };
  }

  async review(evidence: ReviewEvidence): Promise<ReviewResult> {
    const result = await claudeQuery({
      prompt: buildReviewPrompt(evidence),
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      jsonSchema: REVIEW_JSON_SCHEMA,
      model: this.model,
      effort: this.effort,
      timeoutMs: 600_000,
      signal: evidence.signal,
    });

    if (!result.ok) throw new Error(result.error ?? 'Reviewer query failed');

    const parsed = reviewResponseSchema.safeParse(result.structured);
    if (!parsed.success) {
      throw new Error('Reviewer returned a response that did not match the schema');
    }

    return {
      provider: this.id,
      findings: toFindings(parsed.data),
      summary: parsed.data.summary.trim() || null,
      durationMs: result.durationMs ?? 0,
      costUsd: result.costUsd,
    };
  }
}

/* ------------------------------------------------------------------ *
 * anthropic-api
 * ------------------------------------------------------------------ */

export class AnthropicApiReviewer implements ReviewerAgent {
  readonly id = 'anthropic-api';
  readonly label = 'Anthropic API';
  readonly requirement = 'Requires ANTHROPIC_API_KEY in the environment.';
  readonly readOnly = true;

  constructor(private readonly model: string = 'claude-opus-5') {}

  async checkAvailability(): Promise<ReviewerAvailability> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { available: false, detail: 'ANTHROPIC_API_KEY is not set.' };
    }
    return { available: true, detail: `Configured for ${this.model}.` };
  }

  async review(evidence: ReviewEvidence): Promise<ReviewResult> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    const start = Date.now();
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    // Streaming: a large diff at high effort can outrun the request timeout.
    const stream = client.messages.stream(
      {
        model: this.model,
        max_tokens: 32_000,
        system: REVIEW_SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA as Record<string, unknown> },
        },
        messages: [{ role: 'user', content: buildReviewPrompt(evidence) }],
      } as never,
      evidence.signal ? { signal: evidence.signal } : undefined,
    );

    const message = await stream.finalMessage();

    if ((message as { stop_reason?: string }).stop_reason === 'refusal') {
      throw new Error('The reviewer model declined to review this change');
    }

    const text = extractText(message);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Reviewer returned output that was not JSON');
    }

    const parsed = reviewResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Reviewer response did not match the schema');
    }

    return {
      provider: this.id,
      findings: toFindings(parsed.data),
      summary: parsed.data.summary.trim() || null,
      durationMs: Date.now() - start,
      costUsd: null,
    };
  }
}

function extractText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
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
 * codex-cli — cross-vendor review on a ChatGPT plan
 * ------------------------------------------------------------------ */

/**
 * Reviews via a read-only `codex exec` with the sandbox closed.
 *
 * This is the provider that makes the reviewer genuinely independent. Every
 * other reviewer here is the same model family as the implementer; this one is
 * a different vendor, a different training lineage and a different harness,
 * reading nothing but the diff it is handed. That is the strongest independence
 * claim the architecture can make without a second subscription.
 *
 * Read-only matters more here than anywhere else: Codex is a coding agent and
 * could edit the worktree it is pointed at. `--sandbox read-only` in
 * `codexQuery` is what makes "the reviewer cannot modify code" structural.
 */
export class CodexCliReviewer implements ReviewerAgent {
  readonly id = 'codex-cli';
  readonly label = 'Codex CLI (ChatGPT plan, read-only)';
  readonly requirement =
    'Requires the Codex CLI on PATH and a completed `codex login`. Uses your ChatGPT plan, not an API key.';
  readonly readOnly = true;

  constructor(
    private readonly model: string | null = null,
    private readonly effort: string = 'high',
  ) {}

  async checkAvailability(): Promise<ReviewerAvailability> {
    const availability = await checkCodexAvailable();
    return { available: availability.available, detail: availability.detail };
  }

  async review(evidence: ReviewEvidence): Promise<ReviewResult> {
    const result = await codexQuery({
      prompt: buildReviewPrompt(evidence),
      instructions: REVIEW_SYSTEM_PROMPT,
      jsonSchema: REVIEW_JSON_SCHEMA,
      model: this.model,
      effort: this.effort,
      timeoutMs: 600_000,
      signal: evidence.signal,
    });

    if (!result.ok) throw new Error(result.error ?? 'Codex reviewer query failed');

    const parsed = reviewResponseSchema.safeParse(result.structured);
    if (!parsed.success) {
      throw new Error('Codex reviewer returned a response that did not match the schema');
    }

    return {
      provider: this.id,
      findings: toFindings(parsed.data),
      summary: parsed.data.summary.trim() || null,
      durationMs: result.durationMs ?? 0,
      costUsd: null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * openai-api — cross-vendor review through the Responses API
 * ------------------------------------------------------------------ */

export class OpenAiReviewer implements ReviewerAgent {
  readonly id = 'openai-api';
  readonly label = 'OpenAI API (read-only)';
  readonly requirement = 'Requires OPENAI_API_KEY in the environment. Metered per token.';
  readonly readOnly = true;

  constructor(private readonly model: string = 'gpt-5.6') {}

  async checkAvailability(): Promise<ReviewerAvailability> {
    if (!process.env.OPENAI_API_KEY) {
      return { available: false, detail: 'OPENAI_API_KEY is not set.' };
    }
    return { available: true, detail: `Configured for ${this.model}.` };
  }

  async review(evidence: ReviewEvidence): Promise<ReviewResult> {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    const start = Date.now();
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();

    const response = await client.responses.create(
      {
        model: this.model,
        instructions: REVIEW_SYSTEM_PROMPT,
        input: buildReviewPrompt(evidence),
        reasoning: { effort: 'high' },
        text: {
          format: {
            type: 'json_schema',
            name: 'review_findings',
            schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>,
            strict: true,
          },
        },
      },
      evidence.signal ? { signal: evidence.signal } : undefined,
    );

    let json: unknown;
    try {
      json = JSON.parse(response.output_text);
    } catch {
      throw new Error('OpenAI reviewer returned output that was not JSON');
    }

    const parsed = reviewResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('OpenAI reviewer response did not match the schema');
    }

    return {
      provider: this.id,
      findings: toFindings(parsed.data),
      summary: parsed.data.summary.trim() || null,
      durationMs: Date.now() - start,
      costUsd: null,
    };
  }
}
