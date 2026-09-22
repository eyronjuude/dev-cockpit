import type { FindingSeverity } from './types';

/**
 * The minimal shape `reviewFeedbackFor` needs from a finding.
 *
 * Deliberately not `ReviewFindingView` from `services/runs`: that module is
 * server-only, and this one has to be importable from both a client
 * component (the "Address review findings" button) and the orchestrator's
 * review-automation loop. `ReviewFindingView` satisfies this shape
 * structurally, so either caller can just pass its findings straight through.
 */
export interface AddressableFinding {
  severity: FindingSeverity;
  title: string;
  file: string | null;
  line: number | null;
  detail: string | null;
  suggestion: string | null;
}

/**
 * The feedback text for "Address review findings": one instruction line
 * followed by the given findings, formatted the same way the Independent
 * Review panel shows them (`run-view.tsx`), so the two never disagree about
 * what was flagged.
 */
export function reviewFeedbackFor(findings: readonly AddressableFinding[]): string {
  const items = findings.map((finding, index) => {
    const location = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
      : null;
    const lines = [
      `${index + 1}. [${finding.severity}] ${finding.title}${location ? ` (${location})` : ''}`,
    ];
    if (finding.detail) lines.push(`   ${finding.detail}`);
    if (finding.suggestion) lines.push(`   Suggestion: ${finding.suggestion}`);
    return lines.join('\n');
  });
  return `Address the following independent review findings:\n\n${items.join('\n\n')}`;
}
