'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { isProgressEvent, type EventType, type RunEvent } from '@/domain/events';
import { formatTime } from './status';

/**
 * The progress feed.
 *
 * Derived from structured events, not from a terminal transcript. By default it
 * shows only the events that mean something to a person — tool calls, agent
 * messages, validation results, status changes — and hides the debug-level
 * chatter behind a toggle. The goal is that a user can follow a run without
 * opening a log.
 */

const ICON: Partial<Record<EventType, string>> = {
  'run.created': '◆',
  'run.status_changed': '→',
  'run.mode_selected': '◈',
  'run.mode_switched': '◈',
  'transform.completed': '✎',
  'transform.skipped': '·',
  'transform.failed': '!',
  'summarise.completed': '✎',
  'summarise.skipped': '·',
  'worktree.prepared': '⑂',
  'worktree.setup': '⚙',
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
  'review.started': '⌕',
  'review.finding': '⚑',
  'review.completed': '⌕',
  'review.skipped': '·',
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
      return 'text-pass';
    case 'agent.message':
      return 'text-ink';
    case 'validation.result':
      return 'text-ink';
    default:
      return 'text-ink-muted';
  }
}

export function EventFeed({
  events,
  connected,
  active,
}: {
  events: readonly RunEvent[];
  connected: boolean;
  active: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(
    () => (showAll ? events : events.filter((e) => isProgressEvent(e.type))),
    [events, showAll],
  );

  useEffect(() => {
    if (!autoScroll) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [visible.length, autoScroll]);

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <h2 className="panel-title">Progress</h2>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-pass' : 'bg-idle'
              } ${connected && active ? 'pulse-dot' : ''}`}
              aria-hidden
            />
            {connected ? 'live' : 'reconnecting'}
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-accent"
            />
            everything
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-accent"
            />
            follow
          </label>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2">
        {visible.length === 0 ? (
          <p className="empty-state">
            {active ? 'Waiting for the first event…' : 'No progress recorded yet.'}
          </p>
        ) : (
          <ol className="space-y-0.5">
            {visible.map((event) => (
              <li key={event.seq} className="flex gap-2.5 py-0.5 text-[12.5px] leading-snug">
                <span className="w-16 shrink-0 pt-px text-[11px] tabular-nums text-ink-faint">
                  {formatTime(event.createdAt)}
                </span>
                <span
                  className={`w-3.5 shrink-0 pt-px text-center text-[11px] ${toneFor(event)}`}
                  aria-hidden
                >
                  {ICON[event.type] ?? '·'}
                </span>
                <span className={`min-w-0 flex-1 break-words ${toneFor(event)}`}>
                  {event.message}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
