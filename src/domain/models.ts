import { z } from 'zod';

/**
 * Implementation models.
 *
 * A model is the other half of the statement an execution profile makes. The
 * profile says how much effort to spend; the model says what is doing the
 * spending, and the two are only useful together — `xhigh` on a small fast
 * model is not the same purchase as `medium` on a frontier one.
 *
 * The two are nonetheless chosen separately, because the interesting cases are
 * the mismatched ones: a Deep run on a cheaper model when the change is large
 * but dull, a Quick run on the best model when it is small but subtle. So a
 * profile *recommends* a model and never dictates it.
 *
 * This module is pure vocabulary: no I/O, no database, no server-only imports.
 * The New Task form runs `resolveAgentModel` and `resolveAgentEffort` in the
 * browser to show what a run will actually be given, using the same functions
 * the orchestrator uses to give it.
 */

/* ------------------------------------------------------------------ *
 * Effort
 * ------------------------------------------------------------------ */

/**
 * Effort levels, weakest first.
 *
 * The order is the whole point: it is what lets a level a model will not accept
 * be clamped to the nearest one it will, rather than refused.
 */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const agentEffortSchema = z.enum(AGENT_EFFORTS);

export const isAgentEffort = (value: string): value is AgentEffort =>
  (AGENT_EFFORTS as readonly string[]).includes(value);

/** Every level. Named so a catalogue entry reads as a statement, not a list. */
const ALL_EFFORTS: readonly AgentEffort[] = AGENT_EFFORTS;

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/**
 * The implementation provider a model belongs to, matching
 * `ImplementationAgent.id`.
 *
 * Kept as a bare string rather than a union: the agent registry lives in the
 * orchestrator and can be extended at runtime, and this module is not allowed
 * to import it. Naming the one provider that has a catalogue is enough for the
 * checks that matter.
 */
export const CLAUDE_CODE_PROVIDER = 'claude-code';

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

/** Where a model sits on the capability-for-cost curve. */
export const MODEL_TIERS = ['fast', 'balanced', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface AgentModel {
  /** Exactly what is passed to the provider CLI's `--model`. */
  id: string;
  label: string;
  /** The provider that accepts this id. */
  provider: string;
  description: string;
  tier: ModelTier;
  /**
   * The effort levels this model accepts.
   *
   * Empty means the model takes no effort setting at all, and passing one is an
   * error rather than a no-op — which is why this is a list and not a maximum.
   */
  efforts: readonly AgentEffort[];
  /** Short names the provider CLI also accepts for the same model. */
  aliases: readonly string[];
}

/**
 * The models offered for selection, weakest first.
 *
 * Ordered to match the profiles they are recommended for, so the picker and the
 * profile picker read in the same direction.
 *
 * Only Claude Code has a catalogue. Codex is reached solely as a capacity
 * fallback and is left on its own CLI default there: its default is a model
 * tuned for agentic coding, so pinning a general one would be a downgrade, and
 * pinning a specific id would be guessing at a lineup this app does not own.
 * `modelForProvider` is what keeps a Claude id from ever reaching it.
 */
export const AGENT_MODELS: readonly AgentModel[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    provider: CLAUDE_CODE_PROVIDER,
    tier: 'fast',
    description: 'Fastest and cheapest. For small changes that are already well specified.',
    // Haiku 4.5 takes no effort setting; sending one is rejected rather than
    // ignored, so the flag has to be dropped instead of clamped.
    efforts: [],
    aliases: ['haiku'],
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    provider: CLAUDE_CODE_PROVIDER,
    tier: 'balanced',
    description: 'The middle of the range on both capability and cost. Handles most work.',
    efforts: ALL_EFFORTS,
    aliases: ['sonnet'],
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    provider: CLAUDE_CODE_PROVIDER,
    tier: 'frontier',
    description: 'Most capable. For work where being right matters more than what it costs.',
    efforts: ALL_EFFORTS,
    aliases: ['opus'],
  },
];

/** A dated snapshot of a model: `claude-haiku-4-5-20251001`. */
const SNAPSHOT_SUFFIX = /^-\d{8}$/;

/**
 * The catalogue entry a stored model id refers to, or null when this build does
 * not know it.
 *
 * Three ways in, and the third is the one that earns its keep. A provider
 * reports back the id it actually resolved, and that id is written onto the run
 * — so the model a second iteration reads is often a dated snapshot of the
 * model the first one was given. Matching those to their family is what keeps
 * `resolveAgentEffort` from re-adding a flag it dropped an iteration earlier.
 *
 * A snapshot is a date suffix and nothing else. `claude-opus-5-1` is a
 * different model from `claude-opus-5`, not a build of it, so a bare prefix
 * match is deliberately not used.
 */
export function findAgentModel(id: string | null | undefined): AgentModel | null {
  const value = id?.trim().toLowerCase();
  if (!value) return null;

  const exact = AGENT_MODELS.find((model) => model.id === value);
  if (exact) return exact;

  const aliased = AGENT_MODELS.find((model) => model.aliases.includes(value));
  if (aliased) return aliased;

  return (
    AGENT_MODELS.find(
      (model) => value.startsWith(model.id) && SNAPSHOT_SUFFIX.test(value.slice(model.id.length)),
    ) ?? null
  );
}

export const isKnownAgentModel = (id: string | null | undefined): boolean =>
  findAgentModel(id) !== null;

/** Whether a model id is one this provider accepts. */
export function modelBelongsTo(provider: string, id: string | null | undefined): boolean {
  const model = findAgentModel(id);
  return model !== null && model.provider === provider;
}

/** The models offered for a provider, weakest first. */
export const listAgentModels = (provider: string): AgentModel[] =>
  AGENT_MODELS.filter((model) => model.provider === provider);

/**
 * How to name a model in the UI.
 *
 * An id this build does not know is shown as typed rather than as "unknown": it
 * is what will actually be passed to the CLI, and the user chose it.
 */
export const agentModelLabel = (id: string | null | undefined): string =>
  findAgentModel(id)?.label ?? id?.trim() ?? '';

/* ------------------------------------------------------------------ *
 * Choosing a model
 * ------------------------------------------------------------------ */

/** Where the model a run uses came from. */
export const MODEL_SOURCES = ['run', 'project', 'profile', 'provider'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export interface ModelResolution {
  /** The id to pass the provider. Null means "send none, use its default". */
  model: string | null;
  source: ModelSource;
}

export interface ModelChoice {
  /** What was chosen for this run, when anything was. Wins outright. */
  requested?: string | null;
  /** The project's standing default, from Settings. */
  projectDefault?: string | null;
  /** What the execution profile recommends for this provider. */
  recommended?: string | null;
}

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

/**
 * The model a run uses, and why.
 *
 * Precedence runs from the most specific statement to the least: this run, then
 * this project, then this profile, then the provider's own default. A profile
 * recommendation is the weakest of the three stated choices on purpose — it is
 * a suggestion attached to a level of effort, and both a project-wide default
 * and a per-run pick are someone actually deciding.
 */
export function resolveAgentModel(choice: ModelChoice): ModelResolution {
  const requested = clean(choice.requested);
  if (requested) return { model: requested, source: 'run' };

  const projectDefault = clean(choice.projectDefault);
  if (projectDefault) return { model: projectDefault, source: 'project' };

  const recommended = clean(choice.recommended);
  if (recommended) return { model: recommended, source: 'profile' };

  return { model: null, source: 'provider' };
}

/**
 * The model for one provider in a fallback chain.
 *
 * A model id belongs to the provider that named it. Handing Claude's id to the
 * Codex fallback would fail the launch outright, so a provider that did not
 * name the stored model gets its own recommendation, or its own default.
 *
 * An id this build does not recognise is passed through, but only to the
 * provider the run selected: it is most likely a model newer than this build,
 * and second-guessing the user there would be worse than trying it. Sending it
 * on to a *different* vendor's CLI would not be.
 */
export function modelForProvider(input: {
  provider: string;
  /** The provider the run selected, whose stored model may be a custom id. */
  runProvider: string;
  /** The model stored on the run, or the project default behind it. */
  stored: string | null | undefined;
  /** What the execution profile recommends for `provider`. */
  recommended: string | null | undefined;
}): string | null {
  const stored = clean(input.stored);
  if (stored) {
    if (modelBelongsTo(input.provider, stored)) return stored;
    if (!isKnownAgentModel(stored) && input.provider === input.runProvider) return stored;
  }
  return clean(input.recommended);
}

/* ------------------------------------------------------------------ *
 * Effort a model will accept
 * ------------------------------------------------------------------ */

export interface EffortResolution {
  /** What to hand the provider. Null means "send no effort setting". */
  effort: string | null;
  /** The level asked for, kept so a clamp can explain itself. */
  requested: string | null;
  /** True when the model would not accept the requested level. */
  clamped: boolean;
  /** Why, as a sentence fragment. Null when nothing was clamped. */
  reason: string | null;
}

/**
 * The effort a model will actually accept, given the level a profile asked for.
 *
 * The model wins. Choosing a model is a deliberate act and effort is a dial on
 * a profile, so a mismatch is resolved by moving the dial rather than by
 * refusing the model or quietly swapping it back — that is what makes "Deep,
 * but on Haiku" a selectable thing rather than an error message.
 *
 * A model this build does not know is left alone entirely. Guessing at the
 * effort range of a model released after this code was written would turn a
 * working combination into a clamped one.
 */
export function resolveAgentEffort(
  /** An id to look up, or the catalogue entry when the caller already has it. */
  candidate: AgentModel | string | null | undefined,
  requested: string | null | undefined,
): EffortResolution {
  const asked = clean(requested);
  const unclamped: EffortResolution = {
    effort: asked,
    requested: asked,
    clamped: false,
    reason: null,
  };

  const model =
    typeof candidate === 'string' || candidate === null || candidate === undefined
      ? findAgentModel(candidate)
      : candidate;
  if (!model || !asked) return unclamped;

  if (model.efforts.length === 0) {
    return {
      effort: null,
      requested: asked,
      clamped: true,
      reason: `${model.label} takes no effort setting, so the profile's ${asked} is not sent`,
    };
  }

  if ((model.efforts as readonly string[]).includes(asked)) return unclamped;
  if (!isAgentEffort(asked)) return unclamped;

  const rank = (effort: AgentEffort) => AGENT_EFFORTS.indexOf(effort);
  const lowest = model.efforts[0]!;
  const highest = model.efforts[model.efforts.length - 1]!;

  if (rank(asked) > rank(highest)) {
    return {
      effort: highest,
      requested: asked,
      clamped: true,
      reason: `${model.label} tops out at ${highest} effort, so ${asked} runs as ${highest}`,
    };
  }

  return {
    effort: lowest,
    requested: asked,
    clamped: true,
    reason: `${model.label} starts at ${lowest} effort, so ${asked} runs as ${lowest}`,
  };
}
