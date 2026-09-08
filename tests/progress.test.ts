import { describe, expect, it } from 'vitest';

import { computeRunProgress, RUN_PHASES } from '@/domain/progress';

describe('computeRunProgress', () => {
  it('reports nothing started for a draft', () => {
    const progress = computeRunProgress({ status: 'DRAFT', phase: null, active: false });
    expect(progress.completed).toBe(0);
    expect(progress.percent).toBe(0);
    expect(progress.activeIndex).toBeNull();
    expect(progress.steps.every((s) => s.state === 'pending')).toBe(true);
  });

  it('marks the live phase active and everything before it done', () => {
    const progress = computeRunProgress({
      status: 'IMPLEMENTING',
      phase: 'implementing',
      active: true,
    });
    expect(progress.activeLabel).toBe('Implement');
    expect(progress.steps[0]?.state).toBe('done');
    expect(progress.steps[1]?.state).toBe('done');
    expect(progress.steps[2]?.state).toBe('active');
    expect(progress.steps[3]?.state).toBe('pending');
    expect(progress.tone).toBe('running');
  });

  it('counts a running phase as half a step so the bar always moves', () => {
    const idle = computeRunProgress({ status: 'DRAFT', phase: null, active: false });
    const running = computeRunProgress({
      status: 'PREPARING',
      phase: 'preparing',
      active: true,
    });
    expect(running.percent).toBeGreaterThan(idle.percent);
    expect(running.percent).toBe(Math.round((1.5 / RUN_PHASES.length) * 100));
  });

  it('treats the setup step as part of preparing the worktree', () => {
    const progress = computeRunProgress({ status: 'PREPARING', phase: 'setup', active: true });
    expect(progress.activeLabel).toBe('Worktree');
  });

  it('falls back to the status when the in-memory phase is gone', () => {
    const progress = computeRunProgress({ status: 'REVIEWING', phase: null, active: true });
    expect(progress.activeLabel).toBe('Review');
  });

  it('is complete once the run reaches a verdict', () => {
    for (const status of ['READY', 'NEEDS_CHANGES', 'APPROVED', 'REJECTED'] as const) {
      const progress = computeRunProgress({ status, phase: null, active: false });
      expect(progress.percent).toBe(100);
      expect(progress.completed).toBe(RUN_PHASES.length);
      expect(progress.activeIndex).toBeNull();
    }
  });

  it('keeps the ground a failed run covered, from what the run produced', () => {
    const progress = computeRunProgress({
      status: 'FAILED',
      phase: null,
      active: false,
      evidence: {
        hasSpec: true,
        hasWorktree: true,
        iterations: 1,
        changedFiles: 4,
        validations: 3,
        reviewFindings: 0,
      },
    });
    expect(progress.halted).toBe(true);
    expect(progress.tone).toBe('fail');
    // Spec, worktree, implement, changes and validation all happened; review
    // never did, so that is where the bar stops.
    expect(progress.completed).toBe(5);
    expect(progress.steps[4]?.state).toBe('done');
    expect(progress.steps[5]?.state).toBe('halted');
    expect(progress.steps[6]?.state).toBe('pending');
  });

  it('never marks a phase done ahead of the one that is running', () => {
    const progress = computeRunProgress({
      status: 'IMPLEMENTING',
      phase: 'implementing',
      active: true,
      // A change request runs again over a run that already has validations.
      evidence: { hasSpec: true, hasWorktree: true, iterations: 2, validations: 6 },
    });
    expect(progress.completed).toBe(2);
    expect(progress.steps[4]?.state).toBe('pending');
  });
});
