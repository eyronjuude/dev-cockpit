import 'server-only';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '@/core/errors';
import { ensureDir, isInside, landingsDir } from '@/core/paths';
import { currentBranch, git, isDirty, refExists, resolveCommit } from './git';

export interface LandingWorktreeInput {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  targetBranch: string;
}

export interface LandingWorktree {
  worktreePath: string;
  branch: string;
  targetBranch: string;
  targetCommit: string;
  reused: boolean;
}

export async function ensureLandingWorktree(
  input: LandingWorktreeInput,
): Promise<LandingWorktree> {
  const { repositoryPath, worktreePath, branch, targetBranch } = input;

  if (!isInside(landingsDir(), worktreePath)) {
    throw new AppError(`Landing worktree path must live under ${landingsDir()}`, {
      code: 'unsafe_path',
    });
  }

  const targetCommit = await resolveCommit(repositoryPath, targetBranch);

  if (fs.existsSync(worktreePath)) {
    const entries = await fsp.readdir(worktreePath);
    if (entries.length === 0) {
      await fsp.rm(worktreePath, { recursive: true, force: true });
    } else {
      const isRepo = await git(worktreePath, ['rev-parse', '--is-inside-work-tree'], {
        allowFailure: true,
      });
      if (isRepo.exitCode !== 0 || isRepo.stdout.trim() !== 'true') {
        throw new AppError(`Landing path already exists and is not a Git worktree: ${worktreePath}`, {
          code: 'landing_exists',
        });
      }

      const checkedOut = await currentBranch(worktreePath);
      if (checkedOut !== branch) {
        throw new AppError(
          `Landing path is on ${checkedOut}, expected ${branch}: ${worktreePath}`,
          { code: 'wrong_landing_branch' },
        );
      }

      return { worktreePath, branch, targetBranch, targetCommit, reused: true };
    }
  }

  ensureDir(path.dirname(worktreePath));

  if (await refExists(repositoryPath, `refs/heads/${branch}`)) {
    await git(repositoryPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    await git(repositoryPath, ['worktree', 'add', worktreePath, '-b', branch, targetCommit]);
  }

  return { worktreePath, branch, targetBranch, targetCommit, reused: false };
}

export async function mergeSourceIntoLanding(
  worktreePath: string,
  sourceBranch: string,
): Promise<{ merged: boolean; conflicts: string[]; stdout: string; stderr: string }> {
  const res = await git(
    worktreePath,
    ['merge', '--no-ff', '--no-edit', sourceBranch],
    { allowFailure: true },
  );
  const conflicts = await unmergedFiles(worktreePath);

  if (res.exitCode !== 0 && conflicts.length === 0) {
    throw new AppError(`Git could not merge ${sourceBranch}: ${res.stderr.trim() || res.stdout.trim()}`, {
      code: 'merge_failed',
    });
  }

  return { merged: res.exitCode === 0, conflicts, stdout: res.stdout, stderr: res.stderr };
}

export async function mergeTargetIntoLanding(
  worktreePath: string,
  targetBranch: string,
): Promise<{ merged: boolean; conflicts: string[]; stdout: string; stderr: string }> {
  const res = await git(
    worktreePath,
    ['merge', '--no-ff', '--no-edit', targetBranch],
    { allowFailure: true },
  );
  const conflicts = await unmergedFiles(worktreePath);

  if (res.exitCode !== 0 && conflicts.length === 0) {
    throw new AppError(`Git could not refresh from ${targetBranch}: ${res.stderr.trim() || res.stdout.trim()}`, {
      code: 'target_refresh_failed',
    });
  }

  return { merged: res.exitCode === 0, conflicts, stdout: res.stdout, stderr: res.stderr };
}

export async function unmergedFiles(worktreePath: string): Promise<string[]> {
  const res = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'], {
    allowFailure: true,
  });
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m;

export async function filesWithConflictMarkers(
  worktreePath: string,
  files: readonly string[],
): Promise<string[]> {
  const markerFiles: string[] = [];

  for (const file of files) {
    const absolutePath = path.resolve(worktreePath, file);
    if (!isInside(worktreePath, absolutePath)) {
      throw new AppError(`Conflict path escapes the landing worktree: ${file}`, {
        code: 'unsafe_path',
      });
    }

    let text: string;
    try {
      text = await fsp.readFile(absolutePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    if (CONFLICT_MARKER.test(text)) {
      markerFiles.push(file);
    }
  }

  return markerFiles;
}

export async function stageResolvedConflictFiles(
  worktreePath: string,
): Promise<{ staged: string[]; conflicts: string[]; markerFiles: string[] }> {
  const conflicts = await unmergedFiles(worktreePath);
  if (conflicts.length === 0) return { staged: [], conflicts: [], markerFiles: [] };

  const markerFiles = await filesWithConflictMarkers(worktreePath, conflicts);
  if (markerFiles.length > 0) {
    return { staged: [], conflicts: markerFiles, markerFiles };
  }

  await git(worktreePath, ['add', '-A', '--', ...conflicts]);

  const remaining = await unmergedFiles(worktreePath);
  return { staged: conflicts, conflicts: remaining, markerFiles: [] };
}

export async function mergeInProgress(worktreePath: string): Promise<boolean> {
  const res = await git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
    allowFailure: true,
  });
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

export async function sourceMergedIntoLanding(
  worktreePath: string,
  sourceBranch: string,
): Promise<boolean> {
  return refMergedIntoLanding(worktreePath, sourceBranch);
}

export async function refMergedIntoLanding(
  worktreePath: string,
  ref: string,
): Promise<boolean> {
  const res = await git(worktreePath, ['merge-base', '--is-ancestor', ref, 'HEAD'], {
    allowFailure: true,
  });
  return res.exitCode === 0;
}

export async function completeMergeIfResolved(
  worktreePath: string,
  author: { name: string; email: string },
): Promise<{
  completed: boolean;
  conflicts: string[];
  markerFiles: string[];
  staged: string[];
  commitSha: string | null;
}> {
  const stagedResolution = await stageResolvedConflictFiles(worktreePath);
  if (stagedResolution.conflicts.length > 0) {
    return {
      completed: false,
      conflicts: stagedResolution.conflicts,
      markerFiles: stagedResolution.markerFiles,
      staged: stagedResolution.staged,
      commitSha: null,
    };
  }

  if (await mergeInProgress(worktreePath)) {
    await git(worktreePath, ['add', '--all']);
    const res = await git(
      worktreePath,
      [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '--no-edit',
        '--no-verify',
      ],
      { allowFailure: true },
    );
    if (res.exitCode !== 0) {
      throw new AppError(`Git could not complete the resolved merge: ${res.stderr.trim() || res.stdout.trim()}`, {
        code: 'merge_commit_failed',
      });
    }
  }

  const head = await resolveCommit(worktreePath, 'HEAD');
  return {
    completed: true,
    conflicts: [],
    markerFiles: [],
    staged: stagedResolution.staged,
    commitSha: head,
  };
}

export async function assertTargetCheckoutReady(
  repositoryPath: string,
  targetBranch: string,
): Promise<void> {
  const branch = await currentBranch(repositoryPath);
  if (branch !== targetBranch) {
    throw new AppError(`The target checkout is on ${branch}, not ${targetBranch}.`, {
      code: 'wrong_target_branch',
    });
  }
  if (await isDirty(repositoryPath)) {
    throw new AppError(`The ${targetBranch} checkout has uncommitted changes.`, {
      code: 'dirty_target',
    });
  }
}

export async function applyLandingToTarget(
  repositoryPath: string,
  targetBranch: string,
  landingBranch: string,
): Promise<string> {
  await assertTargetCheckoutReady(repositoryPath, targetBranch);

  const alreadyApplied = await git(
    repositoryPath,
    ['merge-base', '--is-ancestor', landingBranch, targetBranch],
    { allowFailure: true },
  );
  if (alreadyApplied.exitCode === 0) {
    return resolveCommit(repositoryPath, targetBranch);
  }

  const res = await git(repositoryPath, ['merge', '--ff-only', landingBranch], {
    allowFailure: true,
  });
  if (res.exitCode !== 0) {
    throw new AppError(`Could not fast-forward ${targetBranch}: ${res.stderr.trim() || res.stdout.trim()}`, {
      code: 'target_update_failed',
    });
  }

  return resolveCommit(repositoryPath, targetBranch);
}
