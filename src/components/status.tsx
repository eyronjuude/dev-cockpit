import type { FindingSeverity, RunStatus, ValidationOutcome } from '@/domain/types';

/**
 * Shared status vocabulary.
 *
 * Colour is meaning here, so the mapping lives in one place: a "not configured"
 * check must never be able to look like a failure just because two components
 * chose different classes.
 */

type BadgeTone = 'pass' | 'fail' | 'warn' | 'running' | 'idle' | 'accent';

const RUN_STATUS_TONE: Record<RunStatus, BadgeTone> = {
  DRAFT: 'idle',
  PREPARING: 'running',
  IMPLEMENTING: 'running',
  VALIDATING: 'running',
  REVIEWING: 'running',
  NEEDS_CHANGES: 'warn',
  READY: 'accent',
  APPROVED: 'pass',
  REJECTED: 'idle',
  FAILED: 'fail',
  CANCELLED: 'idle',
};

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  DRAFT: 'Draft',
  PREPARING: 'Preparing',
  IMPLEMENTING: 'Implementing',
  VALIDATING: 'Validating',
  REVIEWING: 'Reviewing',
  NEEDS_CHANGES: 'Needs changes',
  READY: 'Ready for review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const ACTIVE: readonly RunStatus[] = ['PREPARING', 'IMPLEMENTING', 'VALIDATING', 'REVIEWING'];

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const tone = RUN_STATUS_TONE[status];
  const active = ACTIVE.includes(status);
  return (
    <span className={`badge badge-${tone}`}>
      {active ? <span className="pulse-dot" aria-hidden /> : null}
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

export const runStatusLabel = (status: RunStatus): string => RUN_STATUS_LABEL[status];
export const isActiveStatus = (status: RunStatus): boolean => ACTIVE.includes(status);

const OUTCOME_TONE: Record<ValidationOutcome, BadgeTone> = {
  pass: 'pass',
  fail: 'fail',
  error: 'fail',
  running: 'running',
  skipped: 'idle',
  not_configured: 'idle',
  cancelled: 'idle',
};

const OUTCOME_LABEL: Record<ValidationOutcome, string> = {
  pass: 'Pass',
  fail: 'Fail',
  error: 'Error',
  running: 'Running',
  skipped: 'Skipped',
  // Deliberately not "Fail": an unconfigured check has not failed.
  not_configured: 'Not configured',
  cancelled: 'Cancelled',
};

export function OutcomeBadge({ outcome }: { outcome: ValidationOutcome }) {
  return (
    <span className={`badge badge-${OUTCOME_TONE[outcome]}`}>
      {outcome === 'running' ? <span className="pulse-dot" aria-hidden /> : null}
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

export const outcomeLabel = (outcome: ValidationOutcome): string => OUTCOME_LABEL[outcome];

const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  info: 'idle',
  low: 'idle',
  medium: 'warn',
  high: 'fail',
  critical: 'fail',
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={`badge badge-${SEVERITY_TONE[severity]}`}>{severity}</span>;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
