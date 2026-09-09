import type { RunStatus } from './types';

/**
 * How far a run has got, as a shape the progress bar can draw.
 *
 * Pure and free of UI concerns so it can be tested directly. Two independent
 * sources feed it, in this order of trust:
 *
 *  1. the orchestrator's live phase, which is exact while a run is in flight;
 *  2. what the run has actually produced — a spec, a worktree, iterations, a
 *     diff, validations, findings — which still reads correctly after a crash,
 *     a cancel, or a server restart that lost the in-memory phase.
 *
 * Deriving from evidence rather than from the event log is deliberate: a
 * progress bar that folds events would disagree with the run record the moment
 * a replay was truncated.
 */

export interface RunPhase {
  key: string;
  label: string;
}

export const RUN_PHASES: readonly RunPhase[] = [
  { key: 'specify', label: 'Spec' },
  { key: 'prepare', label: 'Worktree' },
  { key: 'implement', label: 'Implement' },
  { key: 'collect', label: 'Changes' },
  { key: 'validate', label: 'Validate' },
  { key: 'review', label: 'Review' },
  { key: 'decide', label: 'Decision' },
];

/** Phase names exactly as `activeRunPhase` reports them. */
const PHASE_INDEX: Record<string, number> = {
  transforming: 0,
  preparing: 1,
  setup: 1,
  implementing: 2,
  collecting: 3,
  validating: 4,
  reviewing: 5,
};

/** Fallback when the in-memory phase is gone but the status still says where. */
const STATUS_INDEX: Partial<Record<RunStatus, number>> = {
  PREPARING: 1,
  IMPLEMENTING: 2,
  PAUSED: 2,
  VALIDATING: 4,
  REVIEWING: 5,
};

/** Statuses that mean every phase has had its turn. */
const FINISHED: readonly RunStatus[] = ['READY', 'NEEDS_CHANGES', 'APPROVED', 'REJECTED'];

export type PhaseState = 'done' | 'active' | 'halted' | 'pending';

export type ProgressTone = 'running' | 'pass' | 'accent' | 'warn' | 'fail' | 'idle';

export interface RunProgressEvidence {
  hasSpec: boolean;
  hasWorktree: boolean;
  iterations: number;
  changedFiles: number;
  validations: number;
  reviewFindings: number;
}

export interface RunProgressInput {
  status: RunStatus;
  /** The orchestrator's current phase, or null when nothing is in flight. */
  phase: string | null;
  active: boolean;
  evidence?: Partial<RunProgressEvidence>;
}

export interface RunProgress {
  steps: { key: string; label: string; state: PhaseState }[];
  /** Index of the phase running right now, or null when nothing is. */
  activeIndex: number | null;
  activeLabel: string | null;
  completed: number;
  total: number;
  /** 0–100. A running phase counts as half, so the bar always moves. */
  percent: number;
  tone: ProgressTone;
  /** The run stopped before finishing, rather than reaching a verdict. */
  halted: boolean;
}

const TONE: Partial<Record<RunStatus, ProgressTone>> = {
  READY: 'accent',
  APPROVED: 'pass',
  NEEDS_CHANGES: 'warn',
  FAILED: 'fail',
  PAUSED: 'warn',
  CANCELLED: 'idle',
  REJECTED: 'idle',
  DRAFT: 'idle',
};

/** How many leading phases the run's own output proves it got through. */
function completedFromEvidence(evidence: Partial<RunProgressEvidence>): number {
  let reached = 0;
  if (evidence.hasSpec) reached = 1;
  if (evidence.hasWorktree) reached = 2;
  if ((evidence.iterations ?? 0) > 0) reached = 3;
  if ((evidence.changedFiles ?? 0) > 0) reached = 4;
  if ((evidence.validations ?? 0) > 0) reached = 5;
  if ((evidence.reviewFindings ?? 0) > 0) reached = 6;
  return reached;
}

export function computeRunProgress({
  status,
  phase,
  active,
  evidence = {},
}: RunProgressInput): RunProgress {
  const total = RUN_PHASES.length;
  const finished = FINISHED.includes(status);
  const halted = status === 'FAILED' || status === 'CANCELLED' || status === 'PAUSED';
  const running = active && !finished;

  const fromPhase = phase === null ? undefined : PHASE_INDEX[phase];
  const fromStatus = STATUS_INDEX[status];

  let activeIndex: number | null = null;
  let completed: number;

  if (finished) {
    completed = total;
  } else if (running) {
    // Everything before the running phase is done; nothing after it is.
    activeIndex = fromPhase ?? fromStatus ?? 0;
    completed = activeIndex;
  } else {
    completed = Math.max(completedFromEvidence(evidence), fromPhase ?? fromStatus ?? 0);
  }

  const steps = RUN_PHASES.map((step, index) => {
    let state: PhaseState = 'pending';
    if (index < completed) state = 'done';
    else if (index === activeIndex) state = 'active';
    else if (halted && index === completed) state = 'halted';
    return { key: step.key, label: step.label, state };
  });

  const percent = finished
    ? 100
    : Math.round(((completed + (running ? 0.5 : 0)) / total) * 100);

  return {
    steps,
    activeIndex,
    activeLabel: activeIndex === null ? null : (RUN_PHASES[activeIndex]?.label ?? null),
    completed,
    total,
    percent,
    tone: running ? 'running' : (TONE[status] ?? 'idle'),
    halted,
  };
}
