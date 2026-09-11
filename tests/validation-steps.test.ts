import { describe, expect, it } from 'vitest';

import {
  coveredKinds,
  evaluateRunWhen,
  matchesPathPatterns,
  nextPosition,
  orderSteps,
  parseEnvLines,
  secretValuesIn,
  shouldRetry,
  slugifyStepKey,
  uncoveredKinds,
  uniqueStepKey,
  type StepPlanInput,
} from '@/domain/validation-steps';
import type { ValidationOutcome } from '@/domain/types';

/**
 * The pure rules behind a validation pipeline.
 *
 * Kept away from a worktree on purpose: ordering, skipping and retry decisions
 * are the parts most likely to be got subtly wrong, and they should be
 * checkable without spawning anything.
 */

function step(overrides: Partial<StepPlanInput> = {}): StepPlanInput {
  return {
    key: 'unit',
    label: 'Unit',
    kind: 'unit',
    command: 'npm test',
    enabled: true,
    profiles: [],
    position: 0,
    runWhen: 'always',
    runWhenArg: null,
    retries: 0,
    retryOn: 'error',
    ...overrides,
  };
}

const noOutcomes = new Map<string, ValidationOutcome>();

describe('ordering', () => {
  it('runs steps in configured position, not the order they were stored', () => {
    const ordered = orderSteps([
      { key: 'c', position: 30 },
      { key: 'a', position: 10 },
      { key: 'b', position: 20 },
    ]);
    expect(ordered.map((s) => s.key)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a position tie by key so the order is stable', () => {
    const ordered = orderSteps([
      { key: 'zebra', position: 0 },
      { key: 'apple', position: 0 },
    ]);
    expect(ordered.map((s) => s.key)).toEqual(['apple', 'zebra']);
  });

  it('appends past the highest position, not past the count', () => {
    expect(nextPosition([{ position: 0 }, { position: 500 }])).toBe(510);
    expect(nextPosition([])).toBe(0);
  });
});

describe('conditions', () => {
  it('always runs an unconditional step', () => {
    expect(
      evaluateRunWhen(step(), { changedPaths: [], outcomes: noOutcomes }).skipped,
    ).toBe(false);
  });

  it('skips when no changed file matches, and says why', () => {
    const decision = evaluateRunWhen(
      step({ runWhen: 'changed_files_match', runWhenArg: 'src/ui/' }),
      { changedPaths: ['docs/readme.md'], outcomes: noOutcomes },
    );
    expect(decision.skipped).toBe(true);
    expect(decision.skipped && decision.reason).toContain('src/ui/');
  });

  it('runs when a changed file matches, including on Windows separators', () => {
    const decision = evaluateRunWhen(
      step({ runWhen: 'changed_files_match', runWhenArg: 'src/ui/' }),
      { changedPaths: ['src\\ui\\Button.tsx'], outcomes: noOutcomes },
    );
    expect(decision.skipped).toBe(false);
  });

  it('runs a conditional step whose condition has no patterns at all', () => {
    // A condition with nothing to match is a configuration mistake, not an
    // instruction to never run. Skipping forever would hide the mistake.
    const decision = evaluateRunWhen(
      step({ runWhen: 'changed_files_match', runWhenArg: '  ' }),
      { changedPaths: ['a.ts'], outcomes: noOutcomes },
    );
    expect(decision.skipped).toBe(false);
  });

  it('runs a dependent step when its dependency passed', () => {
    const decision = evaluateRunWhen(
      step({ key: 'e2e', runWhen: 'depends_on', runWhenArg: 'build' }),
      { changedPaths: [], outcomes: new Map([['build', 'pass' as ValidationOutcome]]) },
    );
    expect(decision.skipped).toBe(false);
  });

  it('skips a dependent step when its dependency failed', () => {
    const decision = evaluateRunWhen(
      step({ key: 'e2e', runWhen: 'depends_on', runWhenArg: 'build' }),
      { changedPaths: [], outcomes: new Map([['build', 'fail' as ValidationOutcome]]) },
    );
    expect(decision.skipped).toBe(true);
    expect(decision.skipped && decision.reason).toContain('build');
  });

  it('skips a dependent step when its dependency never ran', () => {
    const decision = evaluateRunWhen(
      step({ key: 'e2e', runWhen: 'depends_on', runWhenArg: 'build' }),
      { changedPaths: [], outcomes: noOutcomes },
    );
    expect(decision.skipped).toBe(true);
  });
});

describe('retries', () => {
  it('retries a step that could not run, by default', () => {
    expect(shouldRetry('error', 'error')).toBe(true);
    expect(shouldRetry('fail', 'error')).toBe(false);
  });

  it('retries a failure only when asked to', () => {
    expect(shouldRetry('fail', 'fail')).toBe(true);
    expect(shouldRetry('error', 'fail')).toBe(false);
    expect(shouldRetry('fail', 'both')).toBe(true);
    expect(shouldRetry('error', 'both')).toBe(true);
  });

  it('never retries a pass, a skip or a cancellation', () => {
    // A cancellation is a decision, not a flake.
    expect(shouldRetry('pass', 'both')).toBe(false);
    expect(shouldRetry('skipped', 'both')).toBe(false);
    expect(shouldRetry('cancelled', 'both')).toBe(false);
    expect(shouldRetry('not_configured', 'both')).toBe(false);
  });
});

describe('kind coverage', () => {
  it('counts a kind as covered once, however many steps carry it', () => {
    const covered = coveredKinds([
      step({ key: 'lint-web', kind: 'lint' }),
      step({ key: 'lint-api', kind: 'lint' }),
    ]);
    expect([...covered]).toEqual(['lint']);
  });

  it('does not count a disabled or blank step as coverage', () => {
    expect(coveredKinds([step({ enabled: false })]).size).toBe(0);
    expect(coveredKinds([step({ command: '   ' })]).size).toBe(0);
  });

  it('reports a kind-less step as covering nothing', () => {
    const steps = [step({ key: 'licences', kind: null })];
    expect(coveredKinds(steps).size).toBe(0);
    expect(uncoveredKinds(steps)).toHaveLength(6);
  });

  it('lists uncovered kinds in scorecard order', () => {
    expect(uncoveredKinds([step({ kind: 'unit' })])).toEqual([
      'typecheck',
      'lint',
      'integration',
      'e2e',
      'build',
    ]);
  });
});

describe('environment', () => {
  it('parses KEY=VALUE lines and ignores blanks and comments', () => {
    expect(parseEnvLines('A=1\n\n# note\nB=two words\n')).toEqual({
      A: '1',
      B: 'two words',
    });
  });

  it('keeps an equals sign inside a value', () => {
    expect(parseEnvLines('URL=postgres://u:p@h/db?a=b')).toEqual({
      URL: 'postgres://u:p@h/db?a=b',
    });
  });

  it('drops a line with no key rather than guessing at one', () => {
    expect(parseEnvLines('=orphan\nnot-an-assignment')).toEqual({});
  });

  it('picks out secret-looking values, longest first', () => {
    const secrets = secretValuesIn({
      API_KEY: 'short-key',
      DATABASE_PASSWORD: 'a-much-longer-password',
      PORT: '3000',
    });
    expect(secrets).toEqual(['a-much-longer-password', 'short-key']);
  });
});

describe('keys', () => {
  it('turns a label into a slug a filename and an index can hold', () => {
    expect(slugifyStepKey('Lint (web app)!')).toBe('lint-web-app');
    expect(slugifyStepKey('***')).toBe('step');
  });

  it('suffixes a key that is already taken', () => {
    expect(uniqueStepKey('Lint', new Set(['lint']))).toBe('lint-2');
    expect(uniqueStepKey('Lint', new Set(['lint', 'lint-2']))).toBe('lint-3');
  });
});

describe('path matching', () => {
  it('is shared with the UI-change policy, so a pattern means one thing', () => {
    expect(matchesPathPatterns(['src/Button.TSX'], ['.tsx'])).toBe(true);
    expect(matchesPathPatterns(['src/api.ts'], ['.tsx'])).toBe(false);
    expect(matchesPathPatterns(['src/api.ts'], [])).toBe(false);
  });
});
