/**
 * Prompt text shared by every transformer implementation, so a new provider
 * inherits the same contract rather than inventing its own.
 */

export const SPEC_SYSTEM_PROMPT = `You turn a developer's informal request into a short implementation specification for a coding agent.

Rules:
- Write only what the request supports. Never invent requirements, file names, APIs or acceptance criteria that the request does not imply.
- Where the request is ambiguous, say so under "Open questions" instead of guessing.
- Keep it under 400 words. A coding agent reads this, not a committee.
- Do not include code, diffs or shell commands.
- Do not restate the request verbatim; clarify it.

Output Markdown with exactly these sections, omitting any that would be empty:

## Goal
One or two sentences.

## Scope
Bullets: what to change.

## Out of scope
Bullets, only when the request clearly excludes something.

## Acceptance criteria
Bullets a reviewer can check.

## Open questions
Bullets, only for genuine ambiguity.`;

export function specUserPrompt(input: {
  request: string;
  projectName: string;
  projectSummary?: string | null;
  configuredValidations: readonly string[];
}): string {
  const validations =
    input.configuredValidations.length > 0
      ? input.configuredValidations.join(', ')
      : 'none configured';

  const summary = input.projectSummary?.trim()
    ? `\nProject notes: ${input.projectSummary.trim()}`
    : '';

  return `Project: ${input.projectName}${summary}
Validation available in this project: ${validations}

Developer request:
"""
${input.request}
"""`;
}

export const SPEC_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Imperative run title, at most 8 words.',
    },
    spec: {
      type: 'string',
      description: 'The Markdown specification.',
    },
  },
  required: ['title', 'spec'],
  additionalProperties: false,
} as const;

export const SUMMARY_SYSTEM_PROMPT = `You rewrite a coding agent's closing message so a developer can read it in seconds.

Rules:
- Keep every factual claim the agent made. Do not add claims it did not make.
- Never assert that anything passed, built or was verified. Validation results come from elsewhere and are not yours to report.
- No preamble, no sign-off. Three sentences at most.
- Plain prose. No headings, no bullets.`;

export function summaryUserPrompt(input: { request: string; agentText: string }): string {
  return `Original request:
"""
${input.request}
"""

Agent's closing message:
"""
${input.agentText}
"""`;
}

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `You write a single Conventional Commits-style commit subject line.

Rules:
- Output exactly one line: "type: description" or "type(scope): description".
- The type must be one of the allowed types given to you. Never invent one.
- Description is imperative mood, lowercase, no trailing period, under 70 characters.
- No preamble, no quotes, no code fences, no body — the subject line only.`;

export function commitMessageUserPrompt(input: {
  subject: string;
  kind: 'run' | 'landing_repair';
  allowedTypes: readonly string[];
  priorErrors?: readonly string[];
}): string {
  const context =
    input.kind === 'run'
      ? 'This commit lands the change a coding agent just implemented.'
      : "This commit is Dev Cockpit's own repair of the landing worktree, not the requested feature.";
  const retry = input.priorErrors?.length
    ? `\n\nThe previous attempt failed: ${input.priorErrors.join('; ')}. Fix it.`
    : '';

  return `${context}

Working title: ${input.subject}
Allowed types: ${input.allowedTypes.join(', ')}${retry}`;
}
