'use client';

import type { PhaseState, ProgressTone, RunProgress } from '@/domain/progress';

/**
 * The run's progress bar.
 *
 * One segment per phase rather than a single sliding fill: a run does not move
 * at a knowable rate, and a smooth bar would be inventing a number. Segments
 * say what has happened and what is happening now, which is the honest version
 * of the same reassurance, and the running segment animates so a long silent
 * phase still reads as alive.
 */

const FILL: Record<ProgressTone, string> = {
  running: 'bg-running',
  pass: 'bg-pass',
  accent: 'bg-accent',
  warn: 'bg-warn',
  fail: 'bg-fail',
  idle: 'bg-idle',
};

const TEXT: Record<ProgressTone, string> = {
  running: 'text-running',
  pass: 'text-pass',
  accent: 'text-accent',
  warn: 'text-warn',
  fail: 'text-fail',
  idle: 'text-ink-muted',
};

function segmentClass(state: PhaseState, tone: ProgressTone): string {
  switch (state) {
    case 'done':
      return FILL[tone === 'running' ? 'accent' : tone];
    case 'active':
      return `${FILL[tone]} progress-active`;
    case 'halted':
      return 'bg-fail/40';
    default:
      return 'bg-idle/35';
  }
}

export function RunProgressBar({
  progress,
  label,
}: {
  progress: RunProgress;
  /** What to call the current state — the phase, or the run's status. */
  label: string;
}) {
  const { steps, percent, tone, activeIndex, completed, total } = progress;
  const position = activeIndex === null ? completed : activeIndex + 1;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11.5px] font-medium ${TEXT[tone]}`}>
          {label}
          {activeIndex === null ? '' : '…'}
        </span>
        <span className="text-[10.5px] tabular-nums text-ink-faint">
          {percent === 100 ? 'all phases' : `phase ${position} of ${total}`} · {percent}%
        </span>
      </div>

      <div
        className="mt-1.5 flex gap-[2px]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${label}, ${percent}% complete`}
      >
        {steps.map((step) => (
          <span
            key={step.key}
            title={`${step.label} — ${step.state}`}
            className={`h-1 flex-1 rounded-full ${segmentClass(step.state, tone)}`}
          />
        ))}
      </div>
    </div>
  );
}
