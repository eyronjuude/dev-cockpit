import { randomUUID, randomBytes } from 'node:crypto';

/** A UUID, used where Claude Code requires one (`--session-id`). */
export function uuid(): string {
  return randomUUID();
}

/**
 * Short, sortable, filesystem- and URL-safe id.
 * Time prefix keeps directory listings and `ORDER BY id` roughly chronological.
 */
export function shortId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(5).toString('hex');
  return `${prefix}_${time}${rand}`;
}

export const newProjectId = () => shortId('prj');
export const newRunId = () => shortId('run');
export const newIterationId = () => shortId('itr');
export const newValidationId = () => shortId('val');
export const newArtifactId = () => shortId('art');
export const newFindingId = () => shortId('fnd');

/** Git branch component derived from a run id. Safe for `refs/heads/`. */
export function runBranchName(runId: string): string {
  return `cockpit/${runId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** Branch used to prepare the final merge before touching the target branch. */
export function landingBranchName(runId: string): string {
  return `cockpit/landing/${runId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * Branch for a restarted run's nth attempt. Attempt 1 is the plain name.
 *
 * A restart gets a fresh branch rather than reusing the old one. `git branch
 * -d` refuses a branch that still holds commits — which is the behaviour this
 * project wants everywhere else — so reusing the name would leave a run that
 * could not be restarted at all once its agent had committed. The previous
 * attempt's commits stay reachable on their own branch instead of being
 * deleted with `-D`.
 */
export function runAttemptBranchName(runId: string, attempt: number): string {
  const base = runBranchName(runId);
  return attempt <= 1 ? base : `${base}-r${attempt}`;
}
