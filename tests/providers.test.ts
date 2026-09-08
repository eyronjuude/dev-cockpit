import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTransformer, listTransformers, transformerStatuses } from '@/transformers/registry';
import { getReviewer, listReviewers, reviewerStatuses } from '@/reviewers/registry';

/**
 * Registry and availability behaviour.
 *
 * The point of these is the graceful-degradation contract: a provider that
 * cannot run must report that clearly rather than throw, and the rest of the
 * application must keep working with none of them configured.
 */

describe('transformer registry', () => {
  it('offers the no-op provider first, so the default needs no configuration', () => {
    const ids = listTransformers().map((t) => t.id);
    expect(ids[0]).toBe('none');
  });

  it('registers both ChatGPT-backed providers alongside the Claude ones', () => {
    const ids = listTransformers().map((t) => t.id);
    expect(ids).toContain('codex-cli');
    expect(ids).toContain('openai-api');
    expect(ids).toContain('claude-cli');
    expect(ids).toContain('anthropic-api');
  });

  it('falls back to the no-op provider for an unknown or missing id', () => {
    expect(getTransformer('does-not-exist').id).toBe('none');
    expect(getTransformer(null).id).toBe('none');
    expect(getTransformer(undefined).id).toBe('none');
  });

  it('gives every provider a non-empty requirement line for the settings page', () => {
    for (const provider of listTransformers()) {
      expect(provider.requirement.length, provider.id).toBeGreaterThan(0);
      expect(provider.label.length, provider.id).toBeGreaterThan(0);
    }
  });

  it('the no-op provider returns the request untouched', async () => {
    const result = await getTransformer('none').transformRequest({
      request: 'make the button blue',
      projectName: 'p',
      configuredValidations: [],
      profile: 'standard',
    });
    expect(result.spec).toBe('make the button blue');
    expect(result.title).toBeNull();
  });

  it('exposes summariseOutcome on every provider that can interpret prose', () => {
    // The no-op provider deliberately cannot; the orchestrator checks for this
    // before calling, and records summarise.skipped when it is absent.
    expect(typeof getTransformer('none').summariseOutcome).toBe('undefined');
    for (const id of ['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api']) {
      expect(typeof getTransformer(id).summariseOutcome, id).toBe('function');
    }
  });

  it('reports availability for every provider without throwing', async () => {
    const statuses = await transformerStatuses();
    expect(statuses).toHaveLength(listTransformers().length);
    for (const status of statuses) {
      expect(typeof status.available, status.id).toBe('boolean');
      expect(status.detail.length, status.id).toBeGreaterThan(0);
    }
  });
});

describe('reviewer registry', () => {
  it('orders reviewers with the cross-vendor option first', () => {
    // A reviewer from a different vendor than the implementer is the more
    // useful default, so it must be the first candidate offered.
    expect(listReviewers().map((r) => r.id)[0]).toBe('codex-cli');
  });

  it('treats a missing reviewer as absence, not as an error', () => {
    expect(getReviewer('none')).toBeNull();
    expect(getReviewer(null)).toBeNull();
    expect(getReviewer(undefined)).toBeNull();
    expect(getReviewer('does-not-exist')).toBeNull();
  });

  it('marks every reviewer read-only', async () => {
    for (const reviewer of listReviewers()) {
      expect(reviewer.readOnly, reviewer.id).toBe(true);
    }
  });

  it('reports availability for every reviewer without throwing', async () => {
    const statuses = await reviewerStatuses();
    expect(statuses).toHaveLength(listReviewers().length);
    for (const status of statuses) {
      expect(typeof status.available, status.id).toBe('boolean');
      expect(status.detail.length, status.id).toBeGreaterThan(0);
    }
  });
});

describe('key-based providers report honestly when unconfigured', () => {
  let savedOpenAi: string | undefined;
  let savedAnthropic: string | undefined;

  beforeEach(() => {
    savedOpenAi = process.env.OPENAI_API_KEY;
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAi;
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
  });

  it('names the missing variable rather than failing vaguely', async () => {
    const openai = await getTransformer('openai-api').checkAvailability();
    expect(openai.available).toBe(false);
    expect(openai.detail).toContain('OPENAI_API_KEY');

    const anthropic = await getTransformer('anthropic-api').checkAvailability();
    expect(anthropic.available).toBe(false);
    expect(anthropic.detail).toContain('ANTHROPIC_API_KEY');
  });

  it('throws a readable error rather than a network failure when called anyway', async () => {
    await expect(
      getTransformer('openai-api').summariseOutcome!({
        agentText: 'did the thing',
        request: 'do the thing',
      }),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });
});

describe('codex-cli availability', () => {
  it('reports unavailable, naming the binary, when the CLI is absent', async () => {
    const saved = process.env.DEV_COCKPIT_CODEX_BIN;
    process.env.DEV_COCKPIT_CODEX_BIN = 'codex-does-not-exist-zzz';
    try {
      const status = await getTransformer('codex-cli').checkAvailability();
      expect(status.available).toBe(false);
      expect(status.detail).toContain('codex-does-not-exist-zzz');
    } finally {
      if (saved === undefined) delete process.env.DEV_COCKPIT_CODEX_BIN;
      else process.env.DEV_COCKPIT_CODEX_BIN = saved;
    }
  }, 30_000);

  it('surfaces the same verdict through the reviewer registry', async () => {
    const saved = process.env.DEV_COCKPIT_CODEX_BIN;
    process.env.DEV_COCKPIT_CODEX_BIN = 'codex-does-not-exist-zzz';
    try {
      const reviewer = getReviewer('codex-cli');
      expect(reviewer).not.toBeNull();
      const status = await reviewer!.checkAvailability();
      expect(status.available).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.DEV_COCKPIT_CODEX_BIN;
      else process.env.DEV_COCKPIT_CODEX_BIN = saved;
    }
  }, 30_000);
});
