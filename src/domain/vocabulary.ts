import type { ChangeType, FindingSeverity, RunStatus, ValidationOutcome } from './types';

/**
 * The shared status vocabulary: what each state is called, and what it means.
 *
 * Colour carries meaning in this application and is used for nothing else, so
 * the mapping lives in one place: a "not configured" check must never be able
 * to look like a failure because two renderers chose differently. There are now
 * two renderers — the DOM, which resolves a tone to a CSS class, and the SVG
 * implementation map, which resolves the same tone to a literal hex value
 * because an image cannot read a stylesheet.
 */

export type BadgeTone = 'pass' | 'fail' | 'warn' | 'running' | 'idle' | 'accent';

export const RUN_STATUS_TONE: Record<RunStatus, BadgeTone> = {
  DRAFT: 'idle',
  PREPARING: 'running',
  IMPLEMENTING: 'running',
  PAUSED: 'warn',
  VALIDATING: 'running',
  REVIEWING: 'running',
  NEEDS_CHANGES: 'warn',
  READY: 'accent',
  APPROVED: 'pass',
  LANDING: 'running',
  MERGE_CONFLICT: 'warn',
  LANDING_FAILED: 'fail',
  LANDED: 'pass',
  REJECTED: 'idle',
  FAILED: 'fail',
  CANCELLED: 'idle',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  DRAFT: 'Draft',
  PREPARING: 'Preparing',
  IMPLEMENTING: 'Implementing',
  PAUSED: 'Paused',
  VALIDATING: 'Validating',
  REVIEWING: 'Reviewing',
  NEEDS_CHANGES: 'Needs changes',
  READY: 'Ready for review',
  APPROVED: 'Approved',
  LANDING: 'Landing',
  MERGE_CONFLICT: 'Merge conflict',
  LANDING_FAILED: 'Landing failed',
  LANDED: 'Landed',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const OUTCOME_TONE: Record<ValidationOutcome, BadgeTone> = {
  pass: 'pass',
  fail: 'fail',
  error: 'fail',
  running: 'running',
  skipped: 'idle',
  not_configured: 'idle',
  cancelled: 'idle',
};

export const OUTCOME_LABEL: Record<ValidationOutcome, string> = {
  pass: 'Pass',
  fail: 'Fail',
  error: 'Error',
  running: 'Running',
  skipped: 'Skipped',
  // Deliberately not "Fail": an unconfigured check has not failed.
  not_configured: 'Not configured',
  cancelled: 'Cancelled',
};

export const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  info: 'idle',
  low: 'idle',
  medium: 'warn',
  high: 'fail',
  critical: 'fail',
};

export const CHANGE_TYPE_TONE: Record<ChangeType, BadgeTone> = {
  added: 'pass',
  untracked: 'pass',
  modified: 'warn',
  deleted: 'fail',
  renamed: 'accent',
};

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/**
 * A byte count for humans.
 *
 * Here rather than beside the DOM helpers because the same file size is
 * rendered in three places that share no runtime: the artifact browser, the
 * attachment list, and the prompt the agent reads.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
