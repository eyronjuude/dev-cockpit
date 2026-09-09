'use client';

import { redactPatterns } from '@/core/redact-patterns';
import type { EventType, RunEvent } from '@/domain/events';
import { formatTime } from './status';

/**
 * One line of the log.
 *
 * Shared, because the same line is drawn in two places: the Logs tab, which
 * holds every line in the order it arrived, and the right-rail progress panel,
 * which holds only the newest one. Drawing both from here is what stops the
 * two from drifting apart into looking like two different logs.
 *
 * The shape is the readable one — a per-type glyph and the event's own message,
 * coloured by what the event means rather than by its log level. A raw
 * `type: message` dump is what a machine writes; this is the same row a person
 * can scan, which is why the Logs tab uses it too.
 *
 * Event *messages* are redacted when stored; the detail block prints payload
 * prose, so it runs the same patterns client-side through
 * `core/redact-patterns.ts`.
 */

/** Tools whose call means the codebase changed. Drives the Logs tab filter. */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Update',
  'Create',
  'ApplyPatch',
]);

const ICON: Partial<Record<EventType, string>> = {
  'run.created': '◆',
  'run.status_changed': '→',
  'run.mode_selected': '◈',
  'run.mode_switched': '◈',
  'run.retried': '↻',
  'run.restarted': '↺',
  'transform.completed': '✎',
  'transform.skipped': '·',
  'transform.failed': '!',
  'summarise.completed': '✎',
  'summarise.skipped': '·',
  'worktree.prepared': '⑂',
  'worktree.setup': '⚙',
  'preview.started': '▶',
  'preview.ready': '✓',
  'preview.stopped': '⊘',
  'preview.failed': '✕',
  'agent.started': '▶',
  'agent.message': '“',
  'agent.tool_started': '·',
  'agent.tool_completed': '·',
  'agent.completed': '✓',
  'agent.failed': '✕',
  'agent.cancelled': '⊘',
  'agent.notice': '!',
  'validation.started': '⋯',
  'validation.result': '◇',
  'validation.completed': '◆',
  'validation.skipped': '·',
  'artifact.created': '📎',
  'visualisation.skipped': '·',
  // An input arriving reads differently from an output being produced, so it
  // gets its own glyph rather than sharing the artifact paperclip.
  'attachment.added': '⊕',
  'attachment.removed': '⊖',
  'review.started': '⌕',
  'review.finding': '⚑',
  'review.completed': '⌕',
  'review.skipped': '·',
  'landing.queued': '⋯',
  'landing.dequeued': '▶',
  'landing.cancelled': '⊘',
  'landing.started': '⑂',
  'landing.merged': '⑂',
  'landing.conflicted': '⚑',
  'landing.resolution_started': '▶',
  'landing.resolution_completed': '✓',
  'landing.refresh_started': '⑂',
  'landing.refresh_completed': '✓',
  'landing.repair_started': '▶',
  'landing.repair_committed': '⑂',
  'landing.manual_instructions': '!',
  'landing.validation_failed': '✕',
  'landing.applied': '✓',
  'landing.failed': '✕',
  'run.ready': '✓',
  'run.needs_changes': '⚑',
  'run.approved': '✓',
  'run.rejected': '✕',
  'run.failed': '✕',
  'run.cancelled': '⊘',
  'run.commit_created': '⑂',
};

function toneFor(event: RunEvent): string {
  if (event.level === 'error') return 'text-fail';
  if (event.level === 'notice') return 'text-warn';
  switch (event.type) {
    case 'run.ready':
    case 'agent.completed':
    case 'run.approved':
    case 'preview.ready':
    case 'landing.merged':
    case 'landing.refresh_completed':
    case 'landing.applied':
      return 'text-pass';
    case 'landing.conflicted':
    case 'landing.queued':
    case 'landing.manual_instructions':
    case 'landing.validation_failed':
    case 'preview.failed':
      return 'text-warn';
    case 'landing.dequeued':
    case 'preview.started':
      return 'text-running';
    case 'agent.message':
      return 'text-ink';
    case 'validation.result':
      return 'text-ink';
    default:
      return 'text-ink-muted';
  }
}

/** Events that carry prose worth printing in full under the summary line. */
const TEXT_EVENTS = new Set([
  'agent.message',
  'agent.thinking',
  'agent.notice',
  'run.needs_changes',
]);

const MAX_DETAIL_CHARS = 4_000;

/**
 * Payloads are typed per event, so reading one field across every type needs a
 * widening cast. Done once, here, rather than at each call site.
 */
function payloadField(event: RunEvent, key: string): string | null {
  const record = event.payload as unknown as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function touchesCode(event: RunEvent): boolean {
  if (event.type === 'file.changed' || event.type === 'run.commit_created') return true;
  if (event.type !== 'agent.tool_started' && event.type !== 'agent.tool_completed') return false;
  const tool = payloadField(event, 'tool');
  return tool !== null && WRITE_TOOLS.has(tool);
}

function detailFor(event: RunEvent): string | null {
  if (!TEXT_EVENTS.has(event.type)) return null;
  const text = payloadField(event, 'text');
  if (text === null) return null;
  const trimmed = text.trim();
  // The message line already carries the first line of short prose; repeating
  // it under itself would double every agent message in the log.
  if (trimmed.length === 0 || trimmed === event.message) return null;
  const safe = redactPatterns(trimmed).text;
  return safe.length > MAX_DETAIL_CHARS
    ? `${safe.slice(0, MAX_DETAIL_CHARS)}\n… ${safe.length - MAX_DETAIL_CHARS} more characters — see the saved log file`
    : safe;
}

export function LogLine({
  event,
  /** Off where only the line itself fits — a run's prose can be pages long. */
  showDetail = true,
}: {
  event: RunEvent;
  showDetail?: boolean;
}) {
  const detail = showDetail ? detailFor(event) : null;
  const tone = toneFor(event);

  return (
    // The event type sits on hover rather than in the row: it is what you reach
    // for when a message is ambiguous, not something to read on every line.
    <div className="flex gap-2.5 py-0.5 text-[12.5px] leading-snug" title={event.type}>
      <span className="w-16 shrink-0 pt-px text-[11px] tabular-nums text-ink-faint">
        {formatTime(event.createdAt)}
      </span>
      <span className={`w-3.5 shrink-0 pt-px text-center text-[11px] ${tone}`} aria-hidden>
        {ICON[event.type] ?? '·'}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`break-words ${tone}`}>{event.message}</p>
        {detail ? (
          <pre className="log my-1 border-l border-line py-0.5 pl-2.5">{detail}</pre>
        ) : null}
      </div>
    </div>
  );
}
