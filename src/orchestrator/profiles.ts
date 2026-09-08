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
