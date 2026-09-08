import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STATUSES,
  assertTransition,
  BLOCKING_OUTCOMES,
  canTransition,
  isActive,
  isTerminal,
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
