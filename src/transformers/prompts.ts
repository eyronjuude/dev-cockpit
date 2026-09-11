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

/**
 * Whether a closing message defers to a background job's notification rather
 * than reporting an outcome — e.g. "I'll wait for the background test task to
 * notify me when it completes rather than polling."
 *
 * No CLI invocation gets a second wake-up once it exits, so a message like
 * this is never actually kept: rewriting it into plain language would just
 * paraphrase the same non-answer. `BUILD_RULES` in `orchestrator/prompt.ts`
 * now tells agents not to write this in the first place; this is the
 * fallback for when a model does anyway.
 *
 * Deliberately narrow — it requires both a wait/poll verb and a background
 * job's notification mentioned close together, so an ordinary report that
 * happens to mention "background" in passing is not caught by mistake.
 */
export function isUnresolvedBackgroundWait(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsWaiting = /\b(wait|waiting|poll|polling)\b/.test(normalized);
  const mentionsBackgroundNotice =
    /\bbackground\b[\s\S]{0,60}\b(notif\w*|complet\w*)\b/.test(normalized) ||
    /\b(notif\w*)\b[\s\S]{0,60}\bbackground\b/.test(normalized);
  return mentionsWaiting && mentionsBackgroundNotice;
}
