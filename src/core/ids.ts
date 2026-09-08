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
