import 'server-only';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '@/core/errors';
import { ensureDir, isInside, worktreesDir } from '@/core/paths';
import { git, isDirty, refExists, resolveCommit } from './git';

export interface PrepareWorktreeInput {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  /** Branch or commit the run starts from. */
  baseRef: string;
  protectedBranches: readonly string[];
}

export interface PreparedWorktree {
  worktreePath: string;
  branch: string;
  baseCommit: string;
  baseRef: string;
}

/**
 * Creates an isolated worktree on a fresh per-run branch.
 *
 * Safety rules enforced here:
 *  - the run never checks out a protected branch, it always gets a new one;
 *  - the user's own working tree is never touched, dirty or clean;
 *  - an existing directory is refused rather than overwritten.
 */
export async function prepareWorktree(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
  const { repositoryPath, worktreePath, branch, baseRef, protectedBranches } = input;

  if (protectedBranches.includes(branch)) {
    throw new AppError(`Refusing to run on protected branch ${branch}`, { code: 'protected' });
  }

  if (!isInside(worktreesDir(), worktreePath)) {
    throw new AppError(
      `Worktree path must live under ${worktreesDir()}; got ${worktreePath}`,
      { code: 'unsafe_path' },
    );
  }

  if (fs.existsSync(worktreePath)) {
    const entries = await fsp.readdir(worktreePath);
    if (entries.length > 0) {
      throw new AppError(`Worktree path already exists and is not empty: ${worktreePath}`, {
        code: 'worktree_exists',
      });
    }
  }

  const baseCommit = await resolveCommit(repositoryPath, baseRef);

  if (await refExists(repositoryPath, `refs/heads/${branch}`)) {
    throw new AppError(`Branch ${branch} already exists`, { code: 'branch_exists' });
  }

  ensureDir(path.dirname(worktreePath));

  // `git worktree add -b` creates the branch and checks it out in one step; it
  // leaves the main checkout, including any uncommitted work, untouched.
  await git(repositoryPath, ['worktree', 'add', worktreePath, '-b', branch, baseCommit]);

  return { worktreePath, branch, baseCommit, baseRef };
}

export interface LinkResult {
  linked: string[];
  failed: { path: string; error: string }[];
}

/**
 * Makes selected paths from the main checkout available inside the worktree.
 *
 * A fresh worktree has no `node_modules` and no untracked `.env.local`, which
 * is exactly what most typecheck/lint/test commands need. Directories become
 * junctions on Windows (no elevation required) or symlinks elsewhere; files are
 * copied, because a symlinked env file would be edited in place by the agent.
 */
export async function linkIntoWorktree(
  repositoryPath: string,
  worktreePath: string,
  relativePaths: readonly string[],
): Promise<LinkResult> {
  const linked: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const rel of relativePaths) {
    const clean = rel.trim().replace(/^[\\/]+/, '');
    if (!clean) continue;

    const source = path.resolve(repositoryPath, clean);
    const target = path.resolve(worktreePath, clean);

    if (!isInside(repositoryPath, source)) {
      failed.push({ path: clean, error: 'escapes the repository' });
      continue;
    }
    if (!isInside(worktreePath, target)) {
      failed.push({ path: clean, error: 'escapes the worktree' });
      continue;
    }
    if (!fs.existsSync(source)) {
      failed.push({ path: clean, error: 'not present in the repository' });
      continue;
    }
    if (fs.existsSync(target)) {
      // Tracked content already checked out; do not clobber it.
      continue;
    }

    try {
      const stat = await fsp.stat(source);
      ensureDir(path.dirname(target));
      if (stat.isDirectory()) {
        await fsp.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await fsp.copyFile(source, target);
      }
      linked.push(clean);
    } catch (err) {
      failed.push({ path: clean, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { linked, failed };
}

/**
 * Unlinks the junctions and symlinks `linkIntoWorktree` created.
 *
 * Done before the worktree directory is deleted. A junction pointing at the
 * main checkout's `node_modules` has to be unlinked rather than followed, and
 * removing the link here rather than trusting a recursive deleter to recognise
 * a reparse point keeps the developer's own dependencies out of reach.
 *
 * Copied files (`.env.local` and friends) are not symlinks, so they are left
 * for the deletion itself.
 */
export async function unlinkWorktreeLinks(
  worktreePath: string,
  relativePaths: readonly string[],
): Promise<string[]> {
  const unlinked: string[] = [];

  for (const rel of relativePaths) {
    const clean = rel.trim().replace(/^[\\/]+/, '');
    if (!clean) continue;

    const target = path.resolve(worktreePath, clean);
    if (!isInside(worktreePath, target)) continue;

    try {
      const stat = await fsp.lstat(target);
      if (!stat.isSymbolicLink()) continue;
      try {
        await fsp.unlink(target);
      } catch {
        // Windows directory junctions report as symlinks but need rmdir.
        await fsp.rmdir(target);
      }
      unlinked.push(clean);
    } catch {
      // Absent or unreadable: nothing to unlink.
    }
  }

  return unlinked;
}

/** Drops Git's metadata for worktree directories that no longer exist. */
export async function pruneWorktrees(repositoryPath: string): Promise<void> {
  await git(repositoryPath, ['worktree', 'prune'], { allowFailure: true });
}

export interface RemoveWorktreeOptions {
  /** Discards uncommitted changes. Off by default. */
  force?: boolean;
  /** Deletes the branch too, if Git agrees it holds nothing unmerged. */
  deleteBranch?: boolean;
  /**
   * Directory the worktree must live under. Defaults to the run worktree root;
   * a landing worktree passes `landingsDir()`.
   */
  root?: string;
  /**
   * Branch the worktree must have checked out. A recorded path now holding a
   * different branch belongs to something else, so it is left alone.
   */
  expectBranch?: string | null;
  /** Paths linked in by `linkIntoWorktree`, unlinked before deletion. */
  linkedPaths?: readonly string[];
}

export interface RemoveWorktreeResult {
  removed: boolean;
  branchDeleted: boolean;
  reason?: string;
}

/**
 * Removes a cockpit worktree and, optionally, its branch.
 *
 * Four things it will not do: touch a path outside the data directory, remove
 * a directory that has some other branch checked out, discard uncommitted
 * changes unless forced, or delete a branch holding unmerged commits.
 */
export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
  branch: string | null,
  opts: RemoveWorktreeOptions = {},
): Promise<RemoveWorktreeResult> {
  const {
    force = false,
    deleteBranch = false,
    root = worktreesDir(),
    expectBranch = null,
    linkedPaths = [],
  } = opts;

  if (!isInside(root, worktreePath)) {
    return { removed: false, branchDeleted: false, reason: `path outside ${root}` };
  }

  const exists = fs.existsSync(worktreePath);

  if (exists && expectBranch) {
    // A stale recorded path could now hold another run's worktree. Checking
    // what is actually checked out is what keeps this run's cleanup from
    // reaching anything that is not this run's.
    const head = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      allowFailure: true,
    });
    const checkedOut = head.stdout.trim();
    if (head.exitCode === 0 && checkedOut && checkedOut !== expectBranch) {
      return {
        removed: false,
        branchDeleted: false,
        reason: `worktree is on ${checkedOut}, not ${expectBranch}`,
      };
    }
  }

  if (!force && exists) {
    // Refuse to discard work the user has not seen.
    try {
      if (await isDirty(worktreePath)) {
        return { removed: false, branchDeleted: false, reason: 'worktree has uncommitted changes' };
      }
    } catch {
      // Not a valid worktree any more; the prune below will clean up.
    }
  }

  if (exists) await unlinkWorktreeLinks(worktreePath, linkedPaths);

  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const res = await git(repositoryPath, args, { allowFailure: true });

  if (res.exitCode !== 0) {
    await pruneWorktrees(repositoryPath);
    if (fs.existsSync(worktreePath)) {
      return { removed: false, branchDeleted: false, reason: res.stderr.trim() || 'git refused' };
    }
  }

  let branchDeleted = false;
  if (deleteBranch && branch) {
    // -d, never -D: git refuses if the branch holds unmerged commits, which is
    // the behaviour we want. Losing a run's work silently is not acceptable.
    const del = await git(repositoryPath, ['branch', '-d', branch], { allowFailure: true });
    branchDeleted = del.exitCode === 0;
  }

  return { removed: true, branchDeleted };
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  prunable: boolean;
}

export async function listWorktrees(repositoryPath: string): Promise<WorktreeEntry[]> {
  const res = await git(repositoryPath, ['worktree', 'list', '--porcelain'], {
    allowFailure: true,
  });
  if (res.exitCode !== 0) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  const flush = () => {
    if (current.path) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? null,
        prunable: current.prunable ?? false,
      });
    }
    current = {};
  };

  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      continue;
    }
    if (trimmed.startsWith('worktree ')) current.path = trimmed.slice('worktree '.length);
    else if (trimmed.startsWith('HEAD ')) current.head = trimmed.slice('HEAD '.length);
    else if (trimmed.startsWith('branch ')) {
      current.branch = trimmed.slice('branch '.length).replace('refs/heads/', '');
    } else if (trimmed.startsWith('prunable')) current.prunable = true;
  }
  flush();

  return entries;
}
