import { describe, expect, it } from 'vitest';

import { runAttemptBranchName, runBranchName } from '@/core/ids';
import {
  canForceRestart,
  canRetry,
  canRetryIteration,
  lastImplementationIteration,
  planRetry,
  RETRY_STAGE_LABELS,
  RETRY_STAGES,
  RETRYABLE_STATUSES,
  type RetryableIteration,
  type RetryableRun,
} from '@/domain/retry';
import { RUN_STATUSES, type RunStatus } from '@/domain/types';

/**
 * The retry planner, tested directly.
 *
 * Pure, so every case is a table row rather than a run. What is being pinned
 * down is the ordering of the rules: which piece of stored evidence decides,
 * and which pieces are deliberately not consulted.
 */

function iteration(overrides: Partial<RetryableIteration> = {}): RetryableIteration {
  return {
    ordinal: 1,
    kind: 'initial',
    status: 'completed',
    prompt: 'Implement the thing.',
    ...overrides,
  };
}

function run(overrides: Partial<RetryableRun> = {}): RetryableRun {
  return {
    status: 'FAILED',
    disposition: null,
    worktreePath: 'C:/data/worktrees/prj/run',
    agentSessionId: 'sess-1234',
    iterations: [iteration()],
    ...overrides,
  };
}

describe('planRetry', () => {
  it('resumes from the start when no worktree was ever prepared', () => {
    const plan = planRetry(run({ worktreePath: null, iterations: [], agentSessionId: null }));

    expect(plan.stage).toBe('prepare');
    expect(plan.reason).toContain('no worktree');
    expect(plan.resumesSession).toBe(false);
  });

  it('resumes at the agent pass when the worktree exists but nothing ran', () => {
    const plan = planRetry(run({ iterations: [] }));

    expect(plan.stage).toBe('implement');
    expect(plan.reason).toContain('never ran');
  });

  it('resumes at the agent pass when the last iteration did not finish', () => {
    expect(planRetry(run({ iterations: [iteration({ status: 'failed' })] })).stage).toBe(
      'implement',
    );
    expect(planRetry(run({ iterations: [iteration({ status: 'running' })] })).stage).toBe(
      'implement',
    );

    const cancelled = planRetry(
      run({ iterations: [iteration({ ordinal: 3, status: 'cancelled' })] }),
    );
    expect(cancelled.stage).toBe('implement');
    expect(cancelled.reason).toBe('iteration 3 was cancelled');
  });

  it('resumes at validation when the agent pass finished', () => {
    // The failure was downstream of the agent, so re-running it would redo
    // work that succeeded and burn another pass on the same instruction.
    const plan = planRetry(run({ iterations: [iteration({ ordinal: 2 })] }));

    expect(plan.stage).toBe('validate');
    expect(plan.reason).toContain('iteration 2 finished');
    expect(plan.resumesSession).toBe(false);
  });

  it('judges the last implementation iteration, not the last row', () => {
    // A landing repair runs in a different worktree against a merge. Reading
    // its status here would send a retry to the wrong phase.
    const plan = planRetry(
      run({
        iterations: [
          iteration({ ordinal: 1, status: 'failed' }),
          iteration({ ordinal: 2, kind: 'landing_repair', status: 'completed' }),
        ],
      }),
    );

    expect(plan.stage).toBe('implement');
    expect(plan.reason).toBe('iteration 1 did not finish');
  });

  it('sends a stalled landing back to landing without looking at iterations', () => {
    for (const status of ['MERGE_CONFLICT', 'LANDING_FAILED'] as RunStatus[]) {
      const plan = planRetry(run({ status, disposition: 'approved' }));
      expect(plan.stage, status).toBe('land');
    }

    expect(planRetry(run({ status: 'MERGE_CONFLICT' })).reason).toContain('conflicted');
    expect(planRetry(run({ status: 'LANDING_FAILED' })).reason).toContain('landing failed');
  });

  it('sends a cancelled landing of an approved run back to landing', () => {
    const plan = planRetry(run({ status: 'CANCELLED', disposition: 'approved' }));

    expect(plan.stage).toBe('land');
    expect(plan.reason).toContain('approved');
  });

  it('does not send a failed run to landing just because it holds an approval', () => {
    // FAILED is not a status the landing flow can start from, so routing there
    // would produce "approve it before landing" for a run that was approved.
    const plan = planRetry(run({ status: 'FAILED', disposition: 'approved' }));

    expect(plan.stage).toBe('validate');
  });

  it('reports whether the recorded agent session will be resumed', () => {
    expect(planRetry(run({ iterations: [iteration({ status: 'failed' })] })).resumesSession).toBe(
      true,
    );
    expect(
      planRetry(
        run({ agentSessionId: null, iterations: [iteration({ status: 'failed' })] }),
      ).resumesSession,
    ).toBe(false);
  });

  it('names every stage it can return, and labels all of them', () => {
    for (const stage of RETRY_STAGES) {
      expect(RETRY_STAGE_LABELS[stage]).toMatch(/^Retry/);
    }
    expect(Object.keys(RETRY_STAGE_LABELS).sort()).toEqual([...RETRY_STAGES].sort());
  });
});

describe('lastImplementationIteration', () => {
  it('returns null when nothing ran in the run worktree', () => {
    expect(lastImplementationIteration([])).toBeNull();
    expect(
      lastImplementationIteration([
        iteration({ kind: 'merge_resolution' }),
        iteration({ ordinal: 2, kind: 'landing_repair' }),
      ]),
    ).toBeNull();
  });

  it('returns the highest-ordinal implementation iteration', () => {
    const found = lastImplementationIteration([
      iteration({ ordinal: 1, kind: 'initial' }),
      iteration({ ordinal: 2, kind: 'change_request' }),
      iteration({ ordinal: 3, kind: 'retry' }),
      iteration({ ordinal: 4, kind: 'merge_resolution' }),
    ]);

    expect(found?.ordinal).toBe(3);
    expect(found?.kind).toBe('retry');
  });
});

describe('canRetry', () => {
  it('offers a retry only for a run that stopped short of a verdict', () => {
    expect(RETRYABLE_STATUSES).toEqual([
      'PAUSED',
      'FAILED',
      'CANCELLED',
      'MERGE_CONFLICT',
      'LANDING_FAILED',
    ]);
    for (const status of RETRYABLE_STATUSES) {
      expect(canRetry(run({ status }), false), status).toBe(true);
    }
  });

  it('does not offer a retry for a run that finished', () => {
    // READY and NEEDS_CHANGES reached a verdict. "Re-run validation" and
    // "Request changes" already exist and say plainly what they do.
    for (const status of ['READY', 'NEEDS_CHANGES', 'APPROVED', 'LANDED', 'REJECTED', 'DRAFT'] as
      RunStatus[]) {
      expect(canRetry(run({ status }), false), status).toBe(false);
    }
  });

  it('never offers a retry while work is in flight', () => {
    for (const status of RUN_STATUSES) {
      expect(canRetry(run({ status }), true), status).toBe(false);
    }
  });
});

describe('canRetryIteration', () => {
  it('offers the current iteration wherever a change request is offered', () => {
    for (const status of ['NEEDS_CHANGES', 'READY', 'PAUSED', 'FAILED', 'CANCELLED'] as RunStatus[]) {
      expect(canRetryIteration(run({ status }), false), status).toBe(true);
    }
  });

  it('refuses once the diff has been signed off or is being landed', () => {
    // Quietly asking the agent to redo an approved diff would invalidate the
    // approval without saying so.
    for (const status of ['APPROVED', 'LANDING', 'MERGE_CONFLICT', 'LANDING_FAILED', 'LANDED'] as
      RunStatus[]) {
      expect(canRetryIteration(run({ status }), false), status).toBe(false);
    }
  });

  it('needs a worktree and a recorded prompt', () => {
    expect(canRetryIteration(run({ worktreePath: null }), false)).toBe(false);
    expect(canRetryIteration(run({ iterations: [] }), false)).toBe(false);
    expect(canRetryIteration(run({ iterations: [iteration({ prompt: '   ' })] }), false)).toBe(
      false,
    );
  });

  it('is not offered while the iteration is still running', () => {
    // Cancel says what it does; a retry that killed a working agent would be a
    // cancel wearing a friendlier label.
    expect(
      canRetryIteration(run({ status: 'IMPLEMENTING', iterations: [iteration()] }), true),
    ).toBe(false);
  });
});

describe('canForceRestart', () => {
  it('applies to every run that has not finished, including a live one', () => {
    expect(canForceRestart(run({ status: 'IMPLEMENTING' }))).toBe(true);
    expect(canForceRestart(run({ status: 'PAUSED' }))).toBe(true);
    expect(canForceRestart(run({ status: 'DRAFT' }))).toBe(true);
    expect(canForceRestart(run({ status: 'APPROVED' }))).toBe(true);
    expect(canForceRestart(run({ status: 'LANDED' }))).toBe(false);
    expect(canForceRestart(run({ status: 'REJECTED' }))).toBe(false);
  });
});

describe('runAttemptBranchName', () => {
  it('leaves the first attempt on the plain run branch', () => {
    expect(runAttemptBranchName('run_abc', 1)).toBe(runBranchName('run_abc'));
    expect(runAttemptBranchName('run_abc', 0)).toBe('cockpit/run_abc');
  });

  it('numbers later attempts so no earlier branch has to be deleted', () => {
    expect(runAttemptBranchName('run_abc', 2)).toBe('cockpit/run_abc-r2');
    expect(runAttemptBranchName('run_abc', 7)).toBe('cockpit/run_abc-r7');
  });

  it('keeps the id sanitisation the plain branch name applies', () => {
    expect(runAttemptBranchName('run abc!', 3)).toBe('cockpit/run-abc--r3');
  });
});
