/**
 * Landing rules shared by the orchestrator and the read models built on it.
 *
 * The orchestrator decides which branch a landing targets, and the landing
 * queue view has to group runs by exactly the same answer. Two copies of this
 * rule would drift the moment one of them learned about a new override, and the
 * symptom would be a queue that shows a run waiting on a branch it is not
 * actually queued on.
 */

/** How far a run's landing state has got in its target branch's queue. */
export type LandingQueueState =
  | 'landing'
  /** In the live queue, behind something else landing to the same branch. */
  | 'waiting'
  /** Entitled to land, but no landing has been asked for yet. */
  | 'pending';

/** What a landing does when its turn comes. */
export type LandingModeKind = 'land' | 'resolve_conflicts';

/**
 * The branch a run's landing merges into.
 *
 * A run branches from its base ref when it has one, so that is what it must
 * merge back into; otherwise the project's default branch is the target.
 */
export function landingTargetBranch(
  baseBranch: string | null | undefined,
  defaultBranch: string,
): string {
  return baseBranch?.trim() || defaultBranch;
}
