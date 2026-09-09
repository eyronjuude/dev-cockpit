import 'server-only';

import fs from 'node:fs';

import { AppError } from '@/core/errors';
import { landingBranchName } from '@/core/ids';
import { landingsDir, runLandingDir, worktreesDir } from '@/core/paths';
import { AUTO_CLEANUP_STATUSES, FINISHED_STATUSES } from '@/domain/types';
import { pruneWorktrees, removeWorktree } from '@/git/worktree';
import { appendEvent } from './events';
import { requireProject, type ProjectView } from './projects';
import { requireRun, updateRunFields, type RunView } from './runs';

/**
 * Reclaiming the worktrees a run left behind.
 *
 * A run occupies two directories under the data directory: its own worktree
 * and, once landing has been attempted, a landing worktree. Both are found
 * from the run rather than by scanning, and each removal re-checks which
 * branch is actually checked out — so a stale recorded path cannot make this
 * reach a worktree belonging to something else.
 *
 * This lives beside the run service rather than in the orchestrator so the
 * cleanup can be exercised without starting an agent.
 */

export type WorktreeKind = 'run' | 'landing';

export interface RunWorktree {
  kind: WorktreeKind;
  path: string;
  branch: string | null;
  exists: boolean;
}

export interface WorktreeCleanupOutcome extends RunWorktree {
  removed: boolean;
  branchDeleted: boolean;
  /** Why it was left alone. Null when it was removed. */
  reason: string | null;
}

export interface WorktreeCleanupReport {
  runId: string;
  removed: number;
  kept: number;
  targets: WorktreeCleanupOutcome[];
}

export interface CleanUpOptions {
  /** Discard uncommitted changes. Off by default. */
  force?: boolean;
  /** Delete the run and landing branches, when Git agrees they hold nothing unmerged. */
  deleteBranches?: boolean;
  /** Set when the run finishing triggered this rather than the user. */
  automatic?: boolean;
}

/**
 * The worktrees this run owns, whether or not they are still on disk.
 *
 * The landing path is derived rather than stored: a run that never reached
 * landing simply has no directory there.
 */
export function runWorktrees(run: RunView, project: ProjectView): RunWorktree[] {
  const landingPath = runLandingDir(project.id, run.id);

  return [
    {
      kind: 'run',
      path: run.worktreePath ?? '',
      branch: run.branch,
      exists: run.worktreePath !== null && fs.existsSync(run.worktreePath),
    },
    {
      kind: 'landing',
      path: landingPath,
      branch: landingBranchName(run.id),
      exists: fs.existsSync(landingPath),
    },
  ].filter((target) => target.path.length > 0) as RunWorktree[];
}

/** Convenience for callers holding only an id. */
export function listRunWorktrees(runId: string): RunWorktree[] {
  const run = requireRun(runId);
  return runWorktrees(run, requireProject(run.projectId));
}

/**
 * Removes the run's worktrees.
 *
 * Refuses unless the run is over. An active run is never in a finished status,
 * so that one check also keeps this off a worktree currently being written to.
 */
export async function cleanUpRunWorktrees(
  runId: string,
  options: CleanUpOptions = {},
): Promise<WorktreeCleanupReport> {
  const { force = false, deleteBranches = false, automatic = false } = options;

  const run = requireRun(runId);
  const project = requireProject(run.projectId);

  if (!FINISHED_STATUSES.includes(run.status)) {
    throw new AppError(
      `Run ${run.id} is ${run.status}. Its worktrees can only be removed once the run is over.`,
      { code: 'run_not_finished' },
    );
  }

  const targets: WorktreeCleanupOutcome[] = [];

  for (const target of runWorktrees(run, project)) {
    if (!target.exists) {
      targets.push({ ...target, removed: false, branchDeleted: false, reason: 'already gone' });
      continue;
    }

    const result = await removeWorktree(project.repositoryPath, target.path, target.branch, {
      force,
      deleteBranch: deleteBranches,
      root: target.kind === 'landing' ? landingsDir() : worktreesDir(),
      expectBranch: target.branch,
      linkedPaths: project.linkPaths,
    });

    targets.push({
      ...target,
      removed: result.removed,
      branchDeleted: result.branchDeleted,
      reason: result.removed ? null : (result.reason ?? 'git refused'),
    });
  }

  const removed = targets.filter((t) => t.removed).length;
  const kept = targets.filter((t) => t.exists && !t.removed).length;

  if (removed > 0) {
    await pruneWorktrees(project.repositoryPath);
  }

  // The run screen offers "Open worktree" off this field, so it has to stop
  // pointing at a directory that is no longer there.
  const runTarget = targets.find((t) => t.kind === 'run');
  if (runTarget?.removed) {
    updateRunFields(run.id, { worktreePath: null });
  }

  appendEvent({
    runId: run.id,
    type: 'worktree.removed',
    level: kept > 0 ? 'notice' : 'info',
    message: describe(targets, removed, kept),
    payload: {
      automatic,
      removed,
      kept,
      targets: targets.map((t) => ({
        kind: t.kind,
        path: t.path,
        branch: t.branch,
        removed: t.removed,
        branchDeleted: t.branchDeleted,
        reason: t.reason,
      })),
    },
  });

  return { runId: run.id, removed, kept, targets };
}

/**
 * The automatic pass, run when a run lands or is rejected.
 *
 * Never forces. A worktree holding uncommitted changes and a branch holding
 * unmerged commits both survive, and the event says so — the point is to stop
 * the data directory growing without bound, not to throw work away.
 *
 * Returns null when the project has the policy off or the run ended in a state
 * that still has landing ahead of it.
 */
export async function cleanUpFinishedRunWorktrees(
  runId: string,
): Promise<WorktreeCleanupReport | null> {
  const run = requireRun(runId);
  const project = requireProject(run.projectId);

  if (!project.cleanUpWorktreeOnFinish) return null;
  if (!AUTO_CLEANUP_STATUSES.includes(run.status)) return null;

  return cleanUpRunWorktrees(runId, {
    force: false,
    deleteBranches: true,
    automatic: true,
  });
}

function describe(
  targets: readonly WorktreeCleanupOutcome[],
  removed: number,
  kept: number,
): string {
  if (removed === 0 && kept === 0) return 'No worktrees left to remove';

  const branches = targets.filter((t) => t.branchDeleted).length;
  const head =
    removed === 0
      ? 'Kept every worktree'
      : `Removed ${removed} worktree${removed === 1 ? '' : 's'}${
          branches > 0 ? ` and ${branches} branch${branches === 1 ? '' : 'es'}` : ''
        }`;

  const refusals = targets
    .filter((t) => t.exists && !t.removed)
    .map((t) => `${t.kind}: ${t.reason}`);

  return refusals.length > 0 ? `${head} — kept ${refusals.join(', ')}` : head;
}
