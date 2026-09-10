import { CLAUDE_CODE_PROVIDER } from '@/domain/models';
import type { ExecutionProfileName } from '@/domain/types';

/**
 * Execution profiles.
 *
 * A profile is a bundle of defaults, not a separate code path: the orchestrator
 * reads these fields and behaves accordingly, so adding a profile means adding
 * an entry here.
 */
export interface ExecutionProfile {
  id: ExecutionProfileName;
  label: string;
  description: string;
  /** Effort passed to the implementation agent. */
  agentEffort: string;
  /**
   * The model this profile suggests, per implementation provider.
   *
   * A recommendation, not a rule: it is the weakest of the three ways a model
   * gets chosen (see `resolveAgentModel`), so a project default or a per-run
   * pick overrides it without touching the profile. A provider absent from this
   * map keeps its own CLI default.
   *
   * The pairing is the point. Effort and model are one statement about how much
   * to spend, and a profile that raised effort while leaving the model to
   * chance would only be saying half of it.
   */
  recommendedModels: Readonly<Record<string, string>>;
  /** Wall-clock cap for one implementation iteration. */
  agentTimeoutMs: number;
  /** Whether to run the reviewer, when one is selected for the run. */
  runReviewer: boolean;
  /** Whether to collect screenshots and other optional artifacts. */
  collectArtifacts: boolean;
  /** Appended to the implementation prompt. */
  promptSuffix: string;
}

export const PROFILES: Record<ExecutionProfileName, ExecutionProfile> = {
  quick: {
    id: 'quick',
    label: 'Quick',
    description: 'Targeted change, targeted validation. Skips the reviewer.',
    agentEffort: 'medium',
    // Haiku takes no effort setting, so Quick is a model choice rather than a
    // dial position: the speed comes from what is running, not from how hard it
    // is told to try.
    recommendedModels: { [CLAUDE_CODE_PROVIDER]: 'claude-haiku-4-5' },
    agentTimeoutMs: 15 * 60 * 1000,
    runReviewer: false,
    collectArtifacts: false,
    promptSuffix:
      'Keep the change tightly scoped to what was asked. Do not refactor adjacent code, and do not add tests beyond what the change needs.',
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'Normal implementation, the project’s configured validation, artifacts.',
    agentEffort: 'high',
    recommendedModels: { [CLAUDE_CODE_PROVIDER]: 'claude-sonnet-5' },
    agentTimeoutMs: 45 * 60 * 1000,
    runReviewer: true,
    collectArtifacts: true,
    promptSuffix: '',
  },
  deep: {
    id: 'deep',
    label: 'Deep',
    description: 'Thorough implementation, full validation, independent review when configured.',
    agentEffort: 'xhigh',
    recommendedModels: { [CLAUDE_CODE_PROVIDER]: 'claude-opus-5' },
    agentTimeoutMs: 90 * 60 * 1000,
    runReviewer: true,
    collectArtifacts: true,
    promptSuffix:
      'Take the time to check adjacent code for the same defect, and add or update tests that cover the change.',
  },
};

export const DEFAULT_PROFILE: ExecutionProfileName = 'standard';

export function getProfile(name: string | null | undefined): ExecutionProfile {
  if (!name) return PROFILES[DEFAULT_PROFILE];
  return PROFILES[name as ExecutionProfileName] ?? PROFILES[DEFAULT_PROFILE];
}

export function listProfiles(): ExecutionProfile[] {
  return [PROFILES.quick, PROFILES.standard, PROFILES.deep];
}

/**
 * What this profile suggests for a provider, or null when it suggests nothing.
 *
 * Null is a real answer rather than a gap: a provider with no recommendation
 * runs on its own CLI default, which for a coding CLI is usually a model tuned
 * for exactly this and better than anything guessed at here.
 */
export const recommendedModelFor = (
  profile: ExecutionProfile,
  provider: string,
): string | null => profile.recommendedModels[provider] ?? null;
