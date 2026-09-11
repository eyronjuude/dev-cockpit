import { describe, expect, it } from 'vitest';

import {
  describeRunImpact,
  settingsChanged,
  summariseRunImpact,
  type ImpactInput,
  type ImpactIteration,
} from '@/domain/impact';

function iteration(overrides: Partial<ImpactIteration> = {}): ImpactIteration {
  return {
    kind: 'initial',
    status: 'completed',
    numTurns: 10,
    costUsd: 1,
    settings: { model: 'claude-opus-5', effort: 'high', permissionMode: 'bypassPermissions' },
    usage: {
      inputTokens: 100,
      outputTokens: 1_000,
      thinkingTokens: 400,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 2_000,
    },
    ...overrides,
  };
}

function input(overrides: Partial<ImpactInput> = {}): ImpactInput {
  return {
    profile: 'standard',
    costUsd: 1,
    iterations: [iteration()],
    changedFiles: [{ additions: 10, deletions: 2 }],
    validations: [{ outcome: 'pass', blocking: true }],
    findings: [],
    ...overrides,
  };
}

describe('summariseRunImpact', () => {
  it('sums the diff, the checks and the turns', () => {
    const impact = summariseRunImpact(
      input({
        iterations: [iteration({ numTurns: 10 }), iteration({ numTurns: 5 })],
        changedFiles: [
          { additions: 10, deletions: 2 },
          { additions: 3, deletions: 40 },
        ],
        validations: [
          { outcome: 'pass', blocking: true },
          { outcome: 'fail', blocking: true },
          { outcome: 'not_configured', blocking: false },
        ],
        findings: [{ severity: 'high' }, { severity: 'low' }],
      }),
    );

    expect(impact.filesChanged).toBe(2);
    expect(impact.additions).toBe(13);
    expect(impact.deletions).toBe(42);
    expect(impact.checksPassed).toBe(1);
    expect(impact.checksFailed).toBe(1);
    expect(impact.checksNotConfigured).toBe(1);
    // Only the blocking severities count; "low" is an observation.
    expect(impact.findings).toBe(1);
    expect(impact.turns).toBe(15);
  });

  it('derives average context per turn from cache reads', () => {
    const impact = summariseRunImpact(input({ iterations: [iteration({ numTurns: 10 })] }));
    expect(impact.avgContextTokens).toBe(10_000);
  });

  it('reports the cache-read share of tokens, not of dollars', () => {
    const impact = summariseRunImpact(input());
    // 100_000 of 103_100 total.
    expect(impact.cacheReadShare).toBeCloseTo(100_000 / 103_100, 6);
  });

  it('leaves token metrics null when no provider reported any', () => {
    const impact = summariseRunImpact(input({ iterations: [iteration({ usage: null })] }));
    expect(impact.tokens).toBeNull();
    expect(impact.avgContextTokens).toBeNull();
    expect(impact.cacheReadShare).toBeNull();
  });

  it('does not divide by zero turns', () => {
    const impact = summariseRunImpact(
      input({ costUsd: 5, iterations: [iteration({ numTurns: null })] }),
    );
    expect(impact.turns).toBe(0);
    expect(impact.costPerTurn).toBeNull();
    expect(impact.avgContextTokens).toBeNull();
  });

  it('takes settings from the last iteration that recorded any', () => {
    const impact = summariseRunImpact(
      input({
        iterations: [
          iteration(),
          iteration({
            settings: { model: 'claude-sonnet-5', effort: 'medium', permissionMode: 'plan' },
          }),
          // A later iteration that recorded nothing must not blank them.
          iteration({ settings: { model: null, effort: null, permissionMode: null } }),
        ],
      }),
    );
    expect(impact.settings.model).toBe('claude-sonnet-5');
    expect(impact.settings.effort).toBe('medium');
    expect(impact.settings.profile).toBe('standard');
  });
});

describe('settingsChanged', () => {
  const current = {
    model: 'claude-sonnet-5',
    effort: 'medium',
    permissionMode: 'plan',
    profile: 'quick',
  };

  it('names each setting that differs', () => {
    const changes = settingsChanged(current, {
      model: 'claude-opus-5',
      effort: 'medium',
      permissionMode: 'plan',
      profile: 'standard',
    });
    expect(changes).toEqual([
      { setting: 'profile', from: 'standard', to: 'quick' },
      { setting: 'model', from: 'claude-opus-5', to: 'claude-sonnet-5' },
    ]);
  });

  it('reports nothing when there is no previous run', () => {
    expect(settingsChanged(current, null)).toEqual([]);
  });

  it('ignores settings the previous run never recorded', () => {
    // Every run from before capture existed looks like this. Treating an
    // unrecorded setting as a change would make each of them read as a
    // deliberate reconfiguration.
    const changes = settingsChanged(current, {
      model: null,
      effort: null,
      permissionMode: null,
      profile: 'quick',
    });
    expect(changes).toEqual([]);
  });
});

describe('describeRunImpact', () => {
  it('leads with what changed, then what it cost', () => {
    const lines = describeRunImpact(summariseRunImpact(input({ costUsd: 2.5 })));
    expect(lines[0]).toBe('1 file(s) changed, +10/-2 · 1 passed / 0 failed');
    expect(lines[1]).toContain('$2.50');
    expect(lines[1]).toContain('10 turns');
    expect(lines[1]).toContain('avg context 10k');
  });

  it('says so plainly when nothing changed', () => {
    const lines = describeRunImpact(summariseRunImpact(input({ changedFiles: [] })));
    expect(lines[0]).toContain('No files changed');
  });

  it('distinguishes no checks configured from no checks run', () => {
    const configured = describeRunImpact(
      summariseRunImpact(input({ validations: [{ outcome: 'not_configured', blocking: false }] })),
    );
    expect(configured[0]).toContain('no checks configured');

    const none = describeRunImpact(summariseRunImpact(input({ validations: [] })));
    expect(none[0]).toContain('no checks run');
  });

  it('omits token metrics rather than printing zeroes for them', () => {
    const lines = describeRunImpact(
      summariseRunImpact(input({ iterations: [iteration({ usage: null })] })),
    );
    expect(lines.join(' ')).not.toContain('avg context');
    expect(lines.join(' ')).not.toContain('tokens');
  });

  it('keeps the cache-read share off the line but on the object', () => {
    // 96-99% on every real run, so it separates nothing and reads like a share
    // of cost. The magnitude goes on the line instead.
    const impact = summariseRunImpact(input());
    const lines = describeRunImpact(impact);
    expect(lines.join(' ')).not.toContain('cache reads');
    expect(lines[1]).toContain('103k tokens');
    expect(impact.cacheReadShare).not.toBeNull();
  });

  it('spells out which setting changed', () => {
    const impact = summariseRunImpact(input());
    const lines = describeRunImpact(impact, [
      { setting: 'effort', from: 'xhigh', to: 'high' },
    ]);
    expect(lines.at(-1)).toBe('Changed since the last run: effort xhigh → high');
  });
});
