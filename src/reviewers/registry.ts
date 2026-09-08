import 'server-only';

import {
  AnthropicApiReviewer,
  ClaudeCliReviewer,
  CodexCliReviewer,
  OpenAiReviewer,
} from './providers';
import type { ReviewerAgent } from './types';

/**
 * Reviewer registry.
 *
 * `none` is represented by the absence of a selection rather than by a null
 * object: a run with no reviewer records `review.skipped` and moves on, and no
 * part of the app treats a missing reviewer as a failure.
 *
 * Ordered by independence, most independent first: a reviewer from a different
 * vendor than the implementer catches a different class of problem than one
 * sharing its model family.
 */
const REVIEWERS: ReviewerAgent[] = [
  new CodexCliReviewer(),
  new OpenAiReviewer(),
  new ClaudeCliReviewer(),
  new AnthropicApiReviewer(),
];

export const DEFAULT_REVIEWER_ID = 'none';

export function listReviewers(): readonly ReviewerAgent[] {
  return REVIEWERS;
}

export function getReviewer(id: string | null | undefined): ReviewerAgent | null {
  if (!id || id === 'none') return null;
  return REVIEWERS.find((r) => r.id === id) ?? null;
}

export interface ReviewerStatus {
  id: string;
  label: string;
  requirement: string;
  readOnly: boolean;
  available: boolean;
  detail: string;
}

export async function reviewerStatuses(): Promise<ReviewerStatus[]> {
  return Promise.all(
    REVIEWERS.map(async (reviewer) => {
      try {
        const availability = await reviewer.checkAvailability();
        return {
          id: reviewer.id,
          label: reviewer.label,
          requirement: reviewer.requirement,
          readOnly: reviewer.readOnly,
          available: availability.available,
          detail: availability.detail,
        };
      } catch (err) {
        return {
          id: reviewer.id,
          label: reviewer.label,
          requirement: reviewer.requirement,
          readOnly: reviewer.readOnly,
          available: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
