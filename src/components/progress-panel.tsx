'use client';

import type { RunEvent } from '@/domain/events';
import type { RunProgress } from '@/domain/progress';
import { LogLine } from './log-line';
import { RunProgressBar } from './run-progress';

/**
 * The right-rail progress panel.
 *
 * The phase bar, and the newest line of the log under it. Nothing more: this
 * panel answers "what is happening right now", and a scrolling list answers a
 * different question — "what has happened" — which the Logs tab already
 * answers properly, in order, with the filters that go with it.
 *
 * The line is drawn by the same component the Logs tab uses, so the newest
 * line here and the last line there are recognisably the same line rather than
 * two renderings of it.
 */

export function ProgressPanel({
  events,
  connected,
  active,
  progress,
  progressLabel,
}: {
  events: readonly RunEvent[];
  connected: boolean;
  active: boolean;
  progress: RunProgress;
  progressLabel: string;
}) {
  const latest = events.at(-1) ?? null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Progress</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-pass' : 'bg-idle'} ${
              connected && active ? 'pulse-dot' : ''
            }`}
            aria-hidden
          />
          {connected ? 'live' : 'reconnecting'}
        </span>
      </div>

      <div className="px-3.5 py-2.5">
        <RunProgressBar progress={progress} label={progressLabel} />
      </div>

      <div aria-live="polite" className="border-t border-line px-3.5 py-1.5">
        {latest ? (
          <LogLine event={latest} showDetail={false} />
        ) : (
          <p className="py-0.5 text-[12.5px] leading-snug text-ink-faint">
            {active ? 'Waiting for the first line…' : 'Nothing has been logged yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
