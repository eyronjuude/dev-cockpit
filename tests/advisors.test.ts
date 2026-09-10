import { beforeAll, describe, expect, it } from 'vitest';

import type { RepoEvidence, SetupProposal } from '@/services/repo-evidence';
import type { SuggestSetupInput } from '@/advisors/types';

/**
 * The advisor layer's reliability property: it degrades to the deterministic
 * proposal instead of failing.
 *
 * No model is called here. The providers that need credentials are exercised
 * with none, which is the failure path that matters — a machine without a key
 * must still get a usable draft.
 */

let providers: typeof import('@/advisors/providers');
let registry: typeof import('@/advisors/registry');

const BASELINE: SetupProposal = {
  packageManager: 'pnpm',
  setupCommand: null,
  developmentCommand: 'pnpm dev',
  linkPaths: ['node_modules'],
  validationCommands: [{ kind: 'build', command: 'pnpm build', workingDir: null }],
  notes: null,
  confidence: 'high',
};

const EVIDENCE: RepoEvidence = {
  repositoryPath: 'C:\\repo',
  ecosystems: ['node'],
  packageManager: 'pnpm',
  packageManagerSource: 'lockfile',
  manifests: ['package.json'],
  lockfiles: ['pnpm-lock.yaml'],
  scripts: [{ name: 'build', value: 'vite build' }],
  makeTargets: [],
  toolingConfigs: [],
  monorepo: false,
  monorepoMarkers: [],
  dependencyDirs: ['node_modules'],
  rejectsLinkedDependencies: false,
  notes: [],
};

const input: SuggestSetupInput = {
  evidence: EVIDENCE,
  baseline: BASELINE,
  projectName: 'thing',
};

beforeAll(async () => {
  providers = await import('@/advisors/providers');
  registry = await import('@/advisors/registry');
});

describe('advisor registry', () => {
  it('defaults to the deterministic advisor', () => {
    expect(registry.getAdvisor(null).id).toBe('none');
    expect(registry.DEFAULT_ADVISOR_ID).toBe('none');
  });

  it('falls back rather than throwing on an unknown provider id', () => {
    expect(registry.getAdvisor('no-such-provider').id).toBe('none');
  });

  it('reports every provider with its requirement', async () => {
    const statuses = await registry.advisorStatuses();
    expect(statuses.map((s) => s.id)).toContain('claude-cli');
    expect(statuses.map((s) => s.id)).toContain('anthropic-api');
    // The deterministic one is always usable; that is what makes it the default.
    expect(statuses.find((s) => s.id === 'none')?.available).toBe(true);
    for (const status of statuses) expect(status.requirement).toBeTruthy();
  });
});

describe('deterministic advisor', () => {
  it('returns the baseline untouched and claims no fallback', async () => {
    const result = await new providers.DeterministicAdvisor().suggestSetup(input);
    expect(result.proposal).toEqual(BASELINE);
    expect(result.fellBackTo).toBeNull();
    expect(result.provider).toBe('none');
  });
});

describe('credentialled providers with no credentials', () => {
  it('falls back to the baseline and says why', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const advisor = new providers.AnthropicApiAdvisor();
      expect((await advisor.checkAvailability()).available).toBe(false);

      const result = await advisor.suggestSetup(input);
      expect(result.proposal).toEqual(BASELINE);
      expect(result.fellBackTo).toBe('deterministic');
      expect(result.fallbackReason).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('does the same for the OpenAI provider', async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await new providers.OpenAiAdvisor().suggestSetup(input);
      expect(result.proposal).toEqual(BASELINE);
      expect(result.fellBackTo).toBe('deterministic');
      expect(result.fallbackReason).toMatch(/OPENAI_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe('advisor response contract', () => {
  const valid = {
    packageManager: 'pnpm',
    setupCommand: 'pnpm install',
    developmentCommand: 'pnpm dev',
    linkPaths: ['node_modules'],
    validationCommands: [{ kind: 'build', command: 'pnpm build', workingDir: null }],
    notes: 'Read from the lockfile.',
    confidence: 'high' as const,
  };

  it('accepts a well-formed response', () => {
    const proposal = providers.normaliseAdvisorResponse(valid);
    expect(proposal?.setupCommand).toBe('pnpm install');
    expect(proposal?.validationCommands).toEqual([
      { kind: 'build', command: 'pnpm build', workingDir: null },
    ]);
  });

  it('rejects an invented validation kind', () => {
    // A closed enum is what stops a model widening the six fixed kinds.
    expect(
      providers.normaliseAdvisorResponse({
        ...valid,
        validationCommands: [{ kind: 'smoke', command: 'make smoke', workingDir: null }],
      }),
    ).toBeNull();
  });

  it('rejects a missing field rather than filling it in', () => {
    const { confidence, ...withoutConfidence } = valid;
    void confidence;
    expect(providers.normaliseAdvisorResponse(withoutConfidence)).toBeNull();
  });

  it('rejects a command longer than a command could reasonably be', () => {
    expect(
      providers.normaliseAdvisorResponse({ ...valid, setupCommand: 'x'.repeat(2_000) }),
    ).toBeNull();
  });

  it('rejects a non-object entirely', () => {
    expect(providers.normaliseAdvisorResponse(null)).toBeNull();
    expect(providers.normaliseAdvisorResponse('pnpm build')).toBeNull();
  });

  it('drops a blank command and keeps only the first entry per kind', () => {
    const proposal = providers.normaliseAdvisorResponse({
      ...valid,
      validationCommands: [
        { kind: 'build', command: 'pnpm build', workingDir: null },
        { kind: 'build', command: 'pnpm build:other', workingDir: null },
        { kind: 'lint', command: '   ', workingDir: null },
      ],
    });

    // The form has one field per kind, so a duplicate would overwrite silently.
    expect(proposal?.validationCommands).toEqual([
      { kind: 'build', command: 'pnpm build', workingDir: null },
    ]);
  });
});
