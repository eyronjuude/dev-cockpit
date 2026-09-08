'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { isProgressEvent, type EventType, type RunEvent } from '@/domain/events';
import type { RunProgress } from '@/domain/progress';
import { RunProgressBar } from './run-progress';
import { formatTime } from './status';

/**
 * The progress feed.
 *
 * Derived from structured events, not from a terminal transcript. By default it
 * shows only the events that mean something to a person — tool calls, agent
 * messages, validation results, status changes — and hides the debug-level
 * chatter behind a toggle. The goal is that a user can follow a run without
 * opening a log.
 *
 * Newest first, deliberately. This panel is the answer to "what is happening
 * right now", and that answer should never be at the bottom of a list the user
 * has to chase. The full-order stream, appended at the bottom the way a log
 * behaves, lives in the Logs tab instead.
 */

const ICON: Partial<Record<EventType, string>> = {
  'run.created': '◆',
  'run.status_changed': '→',
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
  'artifact.created': '📎',
  'review.started': '⌕',
  'review.finding': '⚑',
  'review.completed': '⌕',
  'review.skipped': '·',
  'landing.started': '⑂',
  'landing.merged': '⑂',
  'landing.conflicted': '⚑',
  'landing.resolution_started': '▶',
  'landing.resolution_completed': '✓',
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
    case 'landing.merged':
    case 'landing.applied':
      return 'text-pass';
    case 'landing.conflicted':
    case 'landing.validation_failed':
      return 'text-warn';
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
  progress,
  progressLabel,
  progressDetail,
}: {
  events: readonly RunEvent[];
  connected: boolean;
  active: boolean;
  progress: RunProgress;
  progressLabel: string;
  progressDetail?: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** Newest first. `events` arrive in sequence order, so one reverse suffices. */
  const visible = useMemo(() => {
    const filtered = showAll ? events : events.filter((e) => isProgressEvent(e.type));
    return filtered.slice().reverse();
  }, [events, showAll]);

  const newestSeq = visible[0]?.seq ?? 0;

  // Scrolled to the top means "keep me on the newest". Scrolling away pauses
  // that, and the count of what arrived since becomes the way back.
  const [pinned, setPinned] = useState(true);
  const [seenSeq, setSeenSeq] = useState(newestSeq);

  useEffect(() => {
    if (!pinned) return;
    setSeenSeq(newestSeq);
    const node = scrollRef.current;
    if (node) node.scrollTop = 0;
  }, [pinned, newestSeq]);

  let unseen = 0;
  for (const event of visible) {
    if (event.seq <= seenSeq) break;
    unseen += 1;
  }

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
        </div>
      </div>

      <div className="shrink-0 border-b border-line px-3.5 py-2">
        <RunProgressBar progress={progress} label={progressLabel} detail={progressDetail} />
      </div>

      {unseen > 0 ? (
        <div className="shrink-0 border-b border-line px-3.5 py-1.5">
          <button
            type="button"
            className="btn btn-sm w-full"
            onClick={() => {
              setPinned(true);
              scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            ↑ {unseen} newer {unseen === 1 ? 'entry' : 'entries'}
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={(e) => setPinned(e.currentTarget.scrollTop <= 8)}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2"
      >
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
