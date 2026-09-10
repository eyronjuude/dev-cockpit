import { describe, expect, it } from 'vitest';

import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  agentModelLabel,
  CLAUDE_CODE_PROVIDER,
  findAgentModel,
  isKnownAgentModel,
  listAgentModels,
  modelBelongsTo,
  modelForProvider,
  resolveAgentEffort,
  resolveAgentModel,
  type AgentModel,
} from '@/domain/models';
import { listProfiles, PROFILES, recommendedModelFor } from '@/orchestrator/profiles';

const CODEX_PROVIDER = 'codex-code';

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

describe('the model catalogue', () => {
  it('offers models only for the provider that accepts their ids', () => {
    expect(listAgentModels(CLAUDE_CODE_PROVIDER).length).toBeGreaterThan(0);
    // Codex is reached only as a capacity fallback and stays on its own CLI
    // default, so it has no catalogue to pick from.
    expect(listAgentModels(CODEX_PROVIDER)).toEqual([]);
  });

  it('lists models weakest first, so the picker reads like the profile picker', () => {
    expect(AGENT_MODELS.map((model) => model.tier)).toEqual(['fast', 'balanced', 'frontier']);
  });

  it('declares effort levels in the ladder order', () => {
    for (const model of AGENT_MODELS) {
      const ranks = model.efforts.map((effort) => AGENT_EFFORTS.indexOf(effort));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(ranks).not.toContain(-1);
    }
  });

  it('has unique ids and aliases', () => {
    const ids = AGENT_MODELS.map((model) => model.id);
    const aliases = AGENT_MODELS.flatMap((model) => model.aliases);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

describe('finding a model by id', () => {
  it('matches an exact id', () => {
    expect(findAgentModel('claude-opus-5')?.label).toBe('Opus 5');
  });

  it('matches an alias the CLI also accepts', () => {
    expect(findAgentModel('haiku')?.id).toBe('claude-haiku-4-5');
    expect(findAgentModel('SONNET')?.id).toBe('claude-sonnet-5');
  });

  /**
   * The provider reports the id it actually resolved and the orchestrator writes
   * that onto the run, so a second iteration usually reads a dated snapshot of
   * the model the first one was given.
   */
  it('reads a dated snapshot as the model it is a build of', () => {
    expect(findAgentModel('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
  });

  it('does not read a version bump as a snapshot of the version below it', () => {
    expect(findAgentModel('claude-opus-5-1')).toBeNull();
    expect(findAgentModel('claude-opus-5-2026')).toBeNull();
  });

  it('treats an unknown id as unknown rather than guessing', () => {
    expect(findAgentModel('gpt-5.6')).toBeNull();
    expect(findAgentModel('')).toBeNull();
    expect(findAgentModel(null)).toBeNull();
    expect(isKnownAgentModel('some-future-model')).toBe(false);
  });

  it('names an unknown model as typed, because that is what will be sent', () => {
    expect(agentModelLabel('some-future-model')).toBe('some-future-model');
    expect(agentModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(agentModelLabel(null)).toBe('');
  });

  it('knows which provider a model belongs to', () => {
    expect(modelBelongsTo(CLAUDE_CODE_PROVIDER, 'claude-opus-5')).toBe(true);
    expect(modelBelongsTo(CODEX_PROVIDER, 'claude-opus-5')).toBe(false);
    expect(modelBelongsTo(CLAUDE_CODE_PROVIDER, 'gpt-5.6')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Profile recommendations
 * ------------------------------------------------------------------ */

describe('profile recommendations', () => {
  it('recommends a model this build actually knows', () => {
    for (const profile of listProfiles()) {
      const recommended = recommendedModelFor(profile, CLAUDE_CODE_PROVIDER);
      expect(recommended).not.toBeNull();
      expect(findAgentModel(recommended)?.id).toBe(recommended);
    }
  });

  it('climbs the tiers as the profiles climb effort', () => {
    const tierOf = (name: 'quick' | 'standard' | 'deep') =>
      findAgentModel(recommendedModelFor(PROFILES[name], CLAUDE_CODE_PROVIDER))?.tier;

    expect(tierOf('quick')).toBe('fast');
    expect(tierOf('standard')).toBe('balanced');
    expect(tierOf('deep')).toBe('frontier');
  });

  it('recommends nothing for a provider without a catalogue', () => {
    expect(recommendedModelFor(PROFILES.deep, CODEX_PROVIDER)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Precedence
 * ------------------------------------------------------------------ */

describe('resolving which model a run uses', () => {
  it('prefers the run over the project over the profile', () => {
    expect(
      resolveAgentModel({
        requested: 'claude-opus-5',
        projectDefault: 'claude-sonnet-5',
        recommended: 'claude-haiku-4-5',
      }),
    ).toEqual({ model: 'claude-opus-5', source: 'run' });

    expect(
      resolveAgentModel({ projectDefault: 'claude-sonnet-5', recommended: 'claude-haiku-4-5' }),
    ).toEqual({ model: 'claude-sonnet-5', source: 'project' });

    expect(resolveAgentModel({ recommended: 'claude-haiku-4-5' })).toEqual({
      model: 'claude-haiku-4-5',
      source: 'profile',
    });
  });

  it('falls through to the provider default when nothing pins a model', () => {
    expect(resolveAgentModel({})).toEqual({ model: null, source: 'provider' });
  });

  it('treats blank and whitespace as no choice at all', () => {
    expect(
      resolveAgentModel({ requested: '   ', projectDefault: '', recommended: 'claude-opus-5' }),
    ).toEqual({ model: 'claude-opus-5', source: 'profile' });
  });
});

describe('resolving the model for one provider in a fallback chain', () => {
  const chain = (provider: string, stored: string | null) =>
    modelForProvider({
      provider,
      runProvider: CLAUDE_CODE_PROVIDER,
      stored,
      recommended: recommendedModelFor(PROFILES.deep, provider),
    });

  it('gives the provider the stored model when the id is one it accepts', () => {
    expect(chain(CLAUDE_CODE_PROVIDER, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  /**
   * The whole point of the provider check. `--model claude-opus-5` on the Codex
   * CLI fails the launch, and a capacity fallback exists to keep a run moving.
   */
  it('never hands one vendor’s model id to another vendor’s CLI', () => {
    expect(chain(CODEX_PROVIDER, 'claude-opus-5')).toBeNull();
  });

  it('passes an unrecognised id to the provider the run chose', () => {
    expect(chain(CLAUDE_CODE_PROVIDER, 'claude-future-9')).toBe('claude-future-9');
  });

  it('withholds an unrecognised id from a fallback provider', () => {
    expect(chain(CODEX_PROVIDER, 'claude-future-9')).toBeNull();
  });

  it('falls back to the profile recommendation when nothing is stored', () => {
    expect(chain(CLAUDE_CODE_PROVIDER, null)).toBe('claude-opus-5');
  });
});

/* ------------------------------------------------------------------ *
 * Effort
 * ------------------------------------------------------------------ */

describe('resolving the effort a model will accept', () => {
  it('passes through a level the model accepts', () => {
    const resolved = resolveAgentEffort('claude-opus-5', 'xhigh');
    expect(resolved).toEqual({
      effort: 'xhigh',
      requested: 'xhigh',
      clamped: false,
      reason: null,
    });
  });

  /**
   * The acceptance criterion the developer named: a model override has to hold
   * even at maximum effort. It holds by moving the effort, not the model.
   */
  it('keeps the model and drops the flag when the model takes no effort setting', () => {
    const resolved = resolveAgentEffort('claude-haiku-4-5', 'max');
    expect(resolved.effort).toBeNull();
    expect(resolved.clamped).toBe(true);
    expect(resolved.requested).toBe('max');
    expect(resolved.reason).toContain('Haiku 4.5');
  });

  it('applies the same rule to a dated snapshot of that model', () => {
    expect(resolveAgentEffort('claude-haiku-4-5-20251001', 'medium').effort).toBeNull();
  });

  it('leaves an unknown model’s effort alone rather than guessing its range', () => {
    expect(resolveAgentEffort('some-future-model', 'max')).toEqual({
      effort: 'max',
      requested: 'max',
      clamped: false,
      reason: null,
    });
  });

  it('sends nothing when nothing was asked for', () => {
    expect(resolveAgentEffort('claude-opus-5', null).effort).toBeNull();
    expect(resolveAgentEffort('claude-opus-5', '  ').clamped).toBe(false);
  });

  it('leaves an effort word it cannot rank alone', () => {
    expect(resolveAgentEffort('claude-opus-5', 'ludicrous')).toEqual({
      effort: 'ludicrous',
      requested: 'ludicrous',
      clamped: false,
      reason: null,
    });
  });

  /**
   * No catalogue entry stops short of either end of the ladder today, so these
   * pass the entry in directly. The clamp has to be right before a model that
   * needs it is added, not after.
   */
  it('clamps down to the highest level a model accepts', () => {
    const capped: AgentModel = { ...AGENT_MODELS[2]!, efforts: ['low', 'medium', 'high'] };
    const resolved = resolveAgentEffort(capped, 'max');

    expect(resolved.effort).toBe('high');
    expect(resolved.clamped).toBe(true);
    expect(resolved.requested).toBe('max');
    expect(resolved.reason).toBe('Opus 5 tops out at high effort, so max runs as high');
  });

  it('clamps up to the lowest level a model accepts', () => {
    const floored: AgentModel = { ...AGENT_MODELS[2]!, efforts: ['high', 'xhigh', 'max'] };
    const resolved = resolveAgentEffort(floored, 'low');

    expect(resolved.effort).toBe('high');
    expect(resolved.clamped).toBe(true);
    expect(resolved.reason).toBe('Opus 5 starts at high effort, so low runs as high');
  });

  it('takes a catalogue entry and its id to the same answer', () => {
    const model = AGENT_MODELS[0]!;
    expect(resolveAgentEffort(model, 'high')).toEqual(resolveAgentEffort(model.id, 'high'));
  });
});

/* ------------------------------------------------------------------ *
 * The pairing profiles and models make together
 * ------------------------------------------------------------------ */

describe('a profile and its recommended model together', () => {
  it('sends every profile a level its own recommendation accepts, or none', () => {
    for (const profile of listProfiles()) {
      const model = recommendedModelFor(profile, CLAUDE_CODE_PROVIDER);
      const resolved = resolveAgentEffort(model, profile.agentEffort);
      const accepted = findAgentModel(model)!.efforts as readonly string[];

      if (resolved.effort === null) {
        expect(accepted).toEqual([]);
      } else {
        expect(accepted).toContain(resolved.effort);
      }
    }
  });

  it('lets Deep run on the fast model without refusing either choice', () => {
    const resolved = resolveAgentEffort('claude-haiku-4-5', PROFILES.deep.agentEffort);
    expect(resolved.effort).toBeNull();
    expect(resolved.clamped).toBe(true);
  });

  it('lets Quick run on the frontier model at the profile’s own effort', () => {
    const resolved = resolveAgentEffort('claude-opus-5', PROFILES.quick.agentEffort);
    expect(resolved.effort).toBe('medium');
    expect(resolved.clamped).toBe(false);
  });
});
