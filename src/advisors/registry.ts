import 'server-only';

import {
  AnthropicApiAdvisor,
  ClaudeCliAdvisor,
  CodexCliAdvisor,
  DeterministicAdvisor,
  OpenAiAdvisor,
} from './providers';
import type { SetupAdvisor } from './types';

/**
 * Setup-advisor registry.
 *
 * Adding a provider means one entry here plus a class implementing
 * `SetupAdvisor`. Nothing else in the app needs to know it exists — the same
 * arrangement as the transformer and reviewer registries.
 */
const ADVISORS: SetupAdvisor[] = [
  new DeterministicAdvisor(),
  new CodexCliAdvisor(),
  new ClaudeCliAdvisor(),
  new OpenAiAdvisor(),
  new AnthropicApiAdvisor(),
];

export const DEFAULT_ADVISOR_ID = 'none';

export function listAdvisors(): readonly SetupAdvisor[] {
  return ADVISORS;
}

/**
 * The advisor for an id, or the deterministic one.
 *
 * An unknown id falls back rather than throwing: the worst outcome is a draft
 * built from the repository alone, which is a perfectly good draft.
 */
export function getAdvisor(id: string | null | undefined): SetupAdvisor {
  if (!id) return ADVISORS[0] as SetupAdvisor;
  return ADVISORS.find((a) => a.id === id) ?? (ADVISORS[0] as SetupAdvisor);
}

export interface AdvisorStatus {
  id: string;
  label: string;
  requirement: string;
  available: boolean;
  detail: string;
}

export async function advisorStatuses(): Promise<AdvisorStatus[]> {
  return Promise.all(
    ADVISORS.map(async (advisor) => {
      try {
        const availability = await advisor.checkAvailability();
        return {
          id: advisor.id,
          label: advisor.label,
          requirement: advisor.requirement,
          available: availability.available,
          detail: availability.detail,
        };
      } catch (err) {
        return {
          id: advisor.id,
          label: advisor.label,
          requirement: advisor.requirement,
          available: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
