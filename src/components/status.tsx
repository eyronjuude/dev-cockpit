import type { FindingSeverity, RunStatus, ValidationOutcome } from '@/domain/types';
import {
  formatDuration,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  SEVERITY_TONE,
} from '@/domain/vocabulary';

/**
 * The DOM half of the status vocabulary: a tone becomes a CSS class here.
 *
 * The tones and labels themselves live in `@/domain/vocabulary`, because the
 * SVG implementation map has to reach the same meanings without a stylesheet.
 */

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

export function OutcomeBadge({ outcome }: { outcome: ValidationOutcome }) {
  return (
    <span className={`badge badge-${OUTCOME_TONE[outcome]}`}>
      {outcome === 'running' ? <span className="pulse-dot" aria-hidden /> : null}
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

export const outcomeLabel = (outcome: ValidationOutcome): string => OUTCOME_LABEL[outcome];

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={`badge badge-${SEVERITY_TONE[severity]}`}>{severity}</span>;
}

export { formatDuration };

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
