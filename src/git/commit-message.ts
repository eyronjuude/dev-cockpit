/**
 * Conventional Commits vocabulary: the type allow-list, the header grammar,
 * and a linter against either.
 *
 * Pure vocabulary — no I/O — same spirit as `domain/models.ts`: it checks
 * `type(scope): description` plus a type allow-list and a header length cap.
 * It deliberately does not implement footers, breaking-change markers, or
 * case rules the way a full `commitlint` config would; see the plan's Risks
 * section for that trade-off.
 */

export const CONVENTIONAL_COMMIT_TYPES = [
  'feat',
  'fix',
  'build',
  'chore',
  'ci',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'revert',
] as const;

export interface CommitConvention {
  types: readonly string[];
  /** Default 100, matching commitlint's own default. */
  maxHeaderLength?: number;
}

export interface CommitLintResult {
  valid: boolean;
  errors: string[];
}

const HEADER_PATTERN = /^([a-z][a-z0-9-]*)(\(([^)]+)\))?(!)?:\s(.+)$/;

/** Whether a subject already reads as `type(scope): description`, any type. */
export function looksConventional(subject: string): boolean {
  return HEADER_PATTERN.test(subject.trim());
}

export function lintCommitSubject(subject: string, convention: CommitConvention): CommitLintResult {
  const errors: string[] = [];
  const trimmed = subject.trim();
  const match = HEADER_PATTERN.exec(trimmed);
  if (!match) {
    return { valid: false, errors: ['Subject must read as "type(scope): description".'] };
  }

  const [, type, , , , description] = match;
  if (!type || !convention.types.includes(type)) {
    errors.push(`Type "${type ?? ''}" is not one of: ${convention.types.join(', ')}.`);
  }
  if (!description?.trim()) {
    errors.push('Description must not be empty.');
  }
  const maxLen = convention.maxHeaderLength ?? 100;
  if (trimmed.length > maxLen) {
    errors.push(`Header exceeds ${maxLen} characters.`);
  }

  return { valid: errors.length === 0, errors };
}

/** Deterministic fallback: prefix with `type:` unless already conventional-shaped. */
export function withConventionalType(subject: string, type: string): string {
  const trimmed = subject.trim();
  return looksConventional(trimmed) ? trimmed : `${type}: ${trimmed}`;
}

/**
 * The convention a project has configured: the built-in Conventional Commits
 * type list, or a project's own vocabulary when it has opted into one.
 */
export function resolveCommitConvention(project: {
  commitConvention: string;
  customCommitTypes: string[];
}): CommitConvention {
  if (project.commitConvention === 'custom' && project.customCommitTypes.length > 0) {
    return { types: project.customCommitTypes };
  }
  return { types: CONVENTIONAL_COMMIT_TYPES };
}
