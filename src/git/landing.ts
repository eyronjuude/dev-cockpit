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

export async function unmergedFiles(worktreePath: string): Promise<string[]> {
  const res = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'], {
    allowFailure: true,
  });
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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
  const res = await git(worktreePath, ['merge-base', '--is-ancestor', sourceBranch, 'HEAD'], {
    allowFailure: true,
  });
  return res.exitCode === 0;
}

export async function completeMergeIfResolved(
  worktreePath: string,
  author: { name: string; email: string },
): Promise<{ completed: boolean; conflicts: string[]; commitSha: string | null }> {
  const conflicts = await unmergedFiles(worktreePath);
  if (conflicts.length > 0) return { completed: false, conflicts, commitSha: null };

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
  return { completed: true, conflicts: [], commitSha: head };
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
