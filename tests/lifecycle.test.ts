import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STATUSES,
  assertTransition,
  BLOCKING_OUTCOMES,
  canRestart,
  canTransition,
  IMPLEMENTATION_ITERATION_KINDS,
  isActive,
  isLandableStatus,
  isTerminal,
  ITERATION_KINDS,
  RUN_STATUSES,
  VALIDATION_KINDS,
  type RunStatus,
} from '@/domain/types';

describe('run lifecycle', () => {
  it('walks the documented happy path', () => {
    const path: RunStatus[] = [
      'DRAFT',
      'PREPARING',
      'IMPLEMENTING',
      'VALIDATING',
      'REVIEWING',
      'READY',
      'APPROVED',
      'LANDING',
      'LANDED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i] as RunStatus;
      const to = path[i + 1] as RunStatus;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('lets a run skip review when no reviewer is configured', () => {
    expect(canTransition('VALIDATING', 'READY')).toBe(true);
    expect(canTransition('VALIDATING', 'NEEDS_CHANGES')).toBe(true);
  });

  it('allows a change request to re-enter implementation', () => {
    expect(canTransition('NEEDS_CHANGES', 'IMPLEMENTING')).toBe(true);
    expect(canTransition('READY', 'IMPLEMENTING')).toBe(true);
    expect(canTransition('PAUSED', 'IMPLEMENTING')).toBe(true);
  });

  it('lets a capacity pause stop without spending the run', () => {
    expect(canTransition('IMPLEMENTING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'REJECTED')).toBe(true);
    expect(isActive('PAUSED')).toBe(false);
    expect(isTerminal('PAUSED')).toBe(false);
  });

  it('allows re-running validation on a failed run', () => {
    expect(canTransition('FAILED', 'VALIDATING')).toBe(true);
    expect(canTransition('CANCELLED', 'IMPLEMENTING')).toBe(true);
  });

  it('treats LANDED and REJECTED as terminal', () => {
    for (const status of RUN_STATUSES) {
      if (status === 'LANDED') continue;
      expect(canTransition('LANDED', status), `LANDED -> ${status}`).toBe(false);
    }
    for (const status of RUN_STATUSES) {
      if (status === 'REJECTED') continue;
      expect(canTransition('REJECTED', status), `REJECTED -> ${status}`).toBe(false);
    }
    expect(isTerminal('APPROVED')).toBe(false);
    expect(isTerminal('LANDED')).toBe(true);
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('READY')).toBe(false);
  });

  it('lets an approved run be picked back up', () => {
    // An approved plan has nothing to land, so approval is where it becomes
    // work. Without this edge the only action left is a forced restart, which
    // discards the plan that was approved.
    expect(canTransition('APPROVED', 'IMPLEMENTING')).toBe(true);
    // "Re-run validation" is offered on an approved build run, and it enters
    // VALIDATING directly.
    expect(canTransition('APPROVED', 'VALIDATING')).toBe(true);
    // A follow-up pass can still stop before a phase writes a status.
    expect(canTransition('APPROVED', 'FAILED')).toBe(true);
    expect(canTransition('APPROVED', 'CANCELLED')).toBe(true);
    // The verdict is still the only thing that writes a verdict, and it is
    // reached through implementation.
    expect(canTransition('APPROVED', 'READY')).toBe(false);
    expect(canTransition('APPROVED', 'NEEDS_CHANGES')).toBe(false);
  });

  it('models landing and conflict recovery after approval', () => {
    expect(canTransition('APPROVED', 'LANDING')).toBe(true);
    expect(canTransition('LANDING', 'MERGE_CONFLICT')).toBe(true);
    expect(canTransition('MERGE_CONFLICT', 'LANDING')).toBe(true);
    expect(canTransition('LANDING', 'LANDING_FAILED')).toBe(true);
    expect(canTransition('LANDING_FAILED', 'LANDING')).toBe(true);
    expect(canTransition('LANDING', 'LANDED')).toBe(true);
  });

  it('refuses to jump straight from DRAFT to READY', () => {
    // The whole point of the orchestrator: nothing reaches READY without
    // passing through implementation and validation.
    expect(canTransition('DRAFT', 'READY')).toBe(false);
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition('DRAFT', 'IMPLEMENTING')).toBe(false);
    expect(() => assertTransition('DRAFT', 'READY')).toThrow(/Illegal run transition/);
  });

  it('refuses to approve a run that is still implementing', () => {
    expect(canTransition('IMPLEMENTING', 'APPROVED')).toBe(false);
    expect(canTransition('VALIDATING', 'APPROVED')).toBe(false);
  });

  it('treats a self-transition as a no-op rather than an error', () => {
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
      expect(() => assertTransition(status, status)).not.toThrow();
    }
  });

  it('lets a forced restart put any unfinished run back to DRAFT', () => {
    // Restart is the universal escape hatch, so every non-terminal status has
    // to be able to reach the state a run is created in.
    for (const status of RUN_STATUSES) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, 'DRAFT'), `${status} -> DRAFT`).toBe(true);
      expect(canRestart(status), `canRestart(${status})`).toBe(true);
    }
  });

  it('refuses to restart a run that already landed or was rejected', () => {
    expect(canTransition('LANDED', 'DRAFT')).toBe(false);
    expect(canTransition('REJECTED', 'DRAFT')).toBe(false);
    expect(canRestart('LANDED')).toBe(false);
    expect(canRestart('REJECTED')).toBe(false);
    expect(() => assertTransition('LANDED', 'DRAFT')).toThrow(/Illegal run transition/);
  });

  it('keeps DRAFT as the only entrance to PREPARING', () => {
    // A restarted run re-enters the pipeline through the same door a new one
    // does. Anything else would give preparation two callers to satisfy.
    for (const status of RUN_STATUSES) {
      if (status === 'DRAFT' || status === 'PREPARING') continue;
      expect(canTransition(status, 'PREPARING'), `${status} -> PREPARING`).toBe(false);
    }
    expect(canTransition('DRAFT', 'PREPARING')).toBe(true);
  });

  it('marks exactly the working statuses as active', () => {
    expect(ACTIVE_STATUSES).toEqual([
      'PREPARING',
      'IMPLEMENTING',
      'VALIDATING',
      'REVIEWING',
      'LANDING',
    ]);
    expect(isActive('IMPLEMENTING')).toBe(true);
    expect(isActive('LANDING')).toBe(true);
    expect(isActive('READY')).toBe(false);
    expect(isActive('DRAFT')).toBe(false);
  });

  it('can always reach a terminal or failed state from every non-terminal status', () => {
    for (const status of RUN_STATUSES) {
      if (isTerminal(status)) continue;
      const escapes = canTransition(status, 'REJECTED') || canTransition(status, 'CANCELLED');
      expect(escapes, `${status} has no exit`).toBe(true);
    }
  });
});

describe('landability', () => {
  it('allows landing from approval and from a stalled landing', () => {
    expect(isLandableStatus('APPROVED', 'approved')).toBe(true);
    expect(isLandableStatus('MERGE_CONFLICT', 'approved')).toBe(true);
    expect(isLandableStatus('LANDING_FAILED', 'approved')).toBe(true);
  });

  it('allows landing a cancelled run that was approved first', () => {
    // Cancelling a landing does not withdraw the approval, and the merge is
    // still the outstanding step.
    expect(isLandableStatus('CANCELLED', 'approved')).toBe(true);
    expect(isLandableStatus('CANCELLED', null)).toBe(false);
    expect(isLandableStatus('CANCELLED', 'rejected')).toBe(false);
  });

  it('refuses to land a run nobody approved', () => {
    expect(isLandableStatus('READY', null)).toBe(false);
    expect(isLandableStatus('NEEDS_CHANGES', null)).toBe(false);
    // A failed run holds no approval to act on, even if one was recorded
    // before the failure: the status is what the landing flow can act from.
    expect(isLandableStatus('FAILED', 'approved')).toBe(false);
  });
});

describe('iteration kinds', () => {
  it('separates the kinds that run in the run worktree from the landing ones', () => {
    expect(IMPLEMENTATION_ITERATION_KINDS).toEqual(['initial', 'change_request', 'retry']);
    for (const kind of IMPLEMENTATION_ITERATION_KINDS) {
      expect(ITERATION_KINDS).toContain(kind);
    }
    // The landing kinds work against a merge in a different worktree, so their
    // prompts are meaningless to a retry of the run itself.
    expect(IMPLEMENTATION_ITERATION_KINDS).not.toContain('merge_resolution');
    expect(IMPLEMENTATION_ITERATION_KINDS).not.toContain('landing_repair');
  });
});

describe('validation outcome semantics', () => {
  it('counts only failure and error as blocking', () => {
    expect(BLOCKING_OUTCOMES).toEqual(['fail', 'error']);
  });

  it('does not treat a missing configuration as a failure', () => {
    // "not configured" must never read as "failed": that is the difference
    // between an unset E2E command and a broken E2E suite.
    expect(BLOCKING_OUTCOMES).not.toContain('not_configured');
    expect(BLOCKING_OUTCOMES).not.toContain('skipped');
  });

  it('does not treat a cancellation as a failure', () => {
    expect(BLOCKING_OUTCOMES).not.toContain('cancelled');
  });

  it('covers the six validation kinds the scorecard renders', () => {
    expect(VALIDATION_KINDS).toEqual([
      'typecheck',
      'lint',
      'unit',
      'integration',
      'e2e',
      'build',
    ]);
  });
});
