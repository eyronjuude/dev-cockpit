import {
  canRestart,
  IMPLEMENTATION_ITERATION_KINDS,
  isLandableStatus,
  type Disposition,
  type IterationKind,
  type IterationStatus,
  type RunStatus,
} from './types';

/**
 * Where a retry picks a stopped run back up.
 *
 * Three actions share this module, and the difference between them is the whole
 * design:
 *
 *  - **Retry** resumes from wherever the run stopped, keeping the worktree and
 *    the agent session. Nothing already done is done twice.
 *  - **Retry iteration** re-issues the last implementation prompt unchanged,
 *    for when the pass itself is what went wrong rather than the work around it.
 *  - **Restart** throws the worktree and the session away and runs the whole
 *    pipeline again from a fresh branch.
 *
 * A retry never asks the agent what happened and never reads its closing
 * message. Where to resume is derived from stored evidence — a worktree, an
 * iteration row, a disposition — in the same way readiness and the progress bar
 * are. That is what keeps it correct after a server restart has lost every
 * in-memory phase.
 *
 * Pure: no I/O, no database, no server-only imports. The run screen calls
 * `planRetry` to label the button with what pressing it will actually do.
 */

export const RETRY_STAGES = ['prepare', 'implement', 'validate', 'land'] as const;
export type RetryStage = (typeof RETRY_STAGES)[number];

/** Button copy for each stage. Verbs, so the label says what will happen. */
export const RETRY_STAGE_LABELS: Record<RetryStage, string> = {
  prepare: 'Retry from the start',
  implement: 'Retry the agent pass',
  validate: 'Retry the checks',
  land: 'Retry landing',
};

export interface RetryPlan {
  stage: RetryStage;
  /** Why the retry resumes here, as a sentence fragment for an event message. */
  reason: string;
  /** Whether the recorded agent session will be resumed rather than restarted. */
  resumesSession: boolean;
}

/** The shape `planRetry` reads. `RunView` satisfies it structurally. */
export interface RetryableRun {
  status: RunStatus;
  disposition: Disposition | null;
  worktreePath: string | null;
  agentSessionId: string | null;
  /** In ascending ordinal order, as `getRun` returns them. */
  iterations: readonly RetryableIteration[];
}

export interface RetryableIteration {
  ordinal: number;
  kind: IterationKind;
  status: IterationStatus;
  prompt: string;
}

/**
 * Statuses a retry is offered for: the ones where a run stopped short of a
 * verdict, or reached one that landing could not act on.
 *
 * `READY` and `NEEDS_CHANGES` are deliberately absent. Those runs finished;
 * what they need is "Re-run validation" or "Request changes", both of which
 * already exist and say plainly what they do.
 */
export const RETRYABLE_STATUSES: readonly RunStatus[] = [
  'FAILED',
  'CANCELLED',
  'MERGE_CONFLICT',
  'LANDING_FAILED',
];

/**
 * Statuses where re-issuing the last implementation prompt is meaningful.
 *
 * The same set "Request changes" uses: the run is idle, its worktree is intact,
 * and the transition table permits re-entering `IMPLEMENTING`. An approved or
 * landing run is excluded — its diff has been signed off, and quietly asking
 * the agent to redo it would invalidate the approval without saying so.
 */
export const ITERATION_RETRYABLE_STATUSES: readonly RunStatus[] = [
  'NEEDS_CHANGES',
  'READY',
  'FAILED',
  'CANCELLED',
];

/** The last iteration that ran in the run's own worktree, if any. */
export function lastImplementationIteration(
  iterations: readonly RetryableIteration[],
): RetryableIteration | null {
  for (let i = iterations.length - 1; i >= 0; i -= 1) {
    const iteration = iterations[i];
    if (iteration && IMPLEMENTATION_ITERATION_KINDS.includes(iteration.kind)) return iteration;
  }
  return null;
}

/**
 * Where a retry of this run would resume, and why.
 *
 * Read top to bottom: the first rule that matches wins, and the ordering is the
 * argument. A landing failure is about the merge, not the diff, so it is
 * settled before anything looks at iterations. Then evidence is consulted from
 * the earliest phase outwards, because the earliest thing missing is the
 * earliest thing that has to happen again.
 */
export function planRetry(run: RetryableRun): RetryPlan {
  const resumesSession = run.agentSessionId !== null;

  // Landing owns its own retry: it keeps a separate worktree, and its failures
  // are about the merge rather than about the diff the run produced.
  if (isLandableStatus(run.status, run.disposition)) {
    return {
      stage: 'land',
      reason:
        run.status === 'MERGE_CONFLICT'
          ? 'the landing merge conflicted'
          : run.status === 'LANDING_FAILED'
            ? 'landing failed'
            : 'the run is approved, so the outstanding step is landing',
      resumesSession,
    };
  }

  if (run.worktreePath === null) {
    return {
      stage: 'prepare',
      reason: 'no worktree was prepared, so nothing has been done yet',
      resumesSession: false,
    };
  }

  const iteration = lastImplementationIteration(run.iterations);
  if (iteration === null) {
    return {
      stage: 'implement',
      reason: 'the worktree exists but the agent never ran',
      resumesSession,
    };
  }
  if (iteration.status !== 'completed') {
    return {
      stage: 'implement',
      reason: `iteration ${iteration.ordinal} ${
        iteration.status === 'cancelled' ? 'was cancelled' : 'did not finish'
      }`,
      resumesSession,
    };
  }

  return {
    stage: 'validate',
    reason: `iteration ${iteration.ordinal} finished, so the failure was after it`,
    resumesSession: false,
  };
}

/** Whether the Retry action applies to this run right now. */
export function canRetry(run: RetryableRun, active: boolean): boolean {
  return !active && RETRYABLE_STATUSES.includes(run.status);
}

/**
 * Whether the current iteration can be re-issued right now.
 *
 * Requires an idle run. While a pass is in flight the honest action is Cancel,
 * which already exists and says what it does; a retry that silently killed a
 * working agent would be a cancel wearing a friendlier label. Forced restart is
 * the one action that stops live work, because stopping it is the request.
 */
export function canRetryIteration(run: RetryableRun, active: boolean): boolean {
  if (active) return false;
  if (!ITERATION_RETRYABLE_STATUSES.includes(run.status)) return false;
  if (run.worktreePath === null) return false;
  const iteration = lastImplementationIteration(run.iterations);
  return iteration !== null && iteration.prompt.trim().length > 0;
}

/** Whether a forced restart applies to this run right now. Ignores liveness. */
export function canForceRestart(run: RetryableRun): boolean {
  return canRestart(run.status);
}
