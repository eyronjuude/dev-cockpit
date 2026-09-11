import 'server-only';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '@/core/errors';
import { ensureDir, isInside, probesDir } from '@/core/paths';
import { git, refExists, resolveCommit } from './git';

/**
 * Disposable checkouts for trying a proposed configuration out.
 *
 * Mirrors `ensureLandingWorktree` rather than `prepareWorktree`, and for the
 * same reason landing has its own: a probe is not a run, so borrowing the run
 * worktree root would put a directory into a tree that retention walks by run
 * id and cannot account for.
 *
 * Nothing here ever touches the user's own checkout. That is the whole point:
 * a probe executes commands a model wrote, and the isolation is what makes
 * that a reasonable thing to do.
 */

export interface ProbeWorktreeInput {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  /** Branch or commit the probe starts from, normally the default branch. */
  baseRef: string;
}

export interface ProbeWorktree {
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

export async function createProbeWorktree(input: ProbeWorktreeInput): Promise<ProbeWorktree> {
  const { repositoryPath, worktreePath, branch, baseRef } = input;

  if (!isInside(probesDir(), worktreePath)) {
    throw new AppError(`Probe worktree path must live under ${probesDir()}`, {
      code: 'unsafe_path',
    });
  }

  if (fs.existsSync(worktreePath)) {
    const entries = await fsp.readdir(worktreePath);
    if (entries.length > 0) {
      throw new AppError(`Probe path already exists and is not empty: ${worktreePath}`, {
        code: 'probe_exists',
      });
    }
  }

  const baseCommit = await resolveCommit(repositoryPath, baseRef);

  if (await refExists(repositoryPath, `refs/heads/${branch}`)) {
    throw new AppError(`Branch ${branch} already exists`, { code: 'branch_exists' });
  }

  ensureDir(path.dirname(worktreePath));
  await git(repositoryPath, ['worktree', 'add', worktreePath, '-b', branch, baseCommit]);

  return { worktreePath, branch, baseCommit };
}

/**
 * Removes a probe worktree and its branch, reporting rather than throwing.
 *
 * Never throws, because every caller runs it from a `finally`: a probe that
 * failed half-way is exactly the one whose cleanup matters, and letting the
 * cleanup throw would replace a useful error with a useless one. What it does
 * instead is return what it could not do, so the caller can say so.
 */
export async function removeProbeWorktree(input: {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
}): Promise<{ removed: boolean; problems: string[] }> {
  const { repositoryPath, worktreePath, branch } = input;
  const problems: string[] = [];

  if (!isInside(probesDir(), worktreePath)) {
    return { removed: false, problems: [`Refusing to remove ${worktreePath}: outside the probe root`] };
  }

  const remove = await git(repositoryPath, ['worktree', 'remove', '--force', worktreePath], {
    allowFailure: true,
  });
  if (remove.exitCode !== 0) {
    problems.push(`git worktree remove failed: ${remove.stderr.trim() || remove.stdout.trim()}`);
    // The directory may still be there whether or not git knew about it.
    try {
      await fsp.rm(worktreePath, { recursive: true, force: true });
    } catch (err) {
      problems.push(`Could not delete ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deleteBranch = await git(repositoryPath, ['branch', '-D', branch], {
    allowFailure: true,
  });
  if (deleteBranch.exitCode !== 0 && (await refExists(repositoryPath, `refs/heads/${branch}`))) {
    problems.push(`Could not delete branch ${branch}`);
  }

  // Clears any registration left behind by a directory that vanished on its
  // own — a reboot mid-probe, an antivirus quarantine.
  await git(repositoryPath, ['worktree', 'prune'], { allowFailure: true });

  return { removed: problems.length === 0, problems };
}

/**
 * Deletes probe directories left behind by a process that died mid-probe.
 *
 * A probe has no run row, so nothing in the retention sweep would ever find
 * these. Called at startup, where it costs one directory listing.
 */
export async function sweepAbandonedProbes(): Promise<number> {
  const root = probesDir();
  if (!fs.existsSync(root)) return 0;

  let removed = 0;
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    const probes = await fsp.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const probe of probes) {
      if (!probe.isDirectory()) continue;
      // Every probe is finished by the time the process restarts: a probe
      // holds no state across a restart, so anything still here is debris.
      try {
        await fsp.rm(path.join(projectDir, probe.name), { recursive: true, force: true });
        removed += 1;
      } catch {
        // Left for the next sweep rather than failing startup over it.
      }
    }
  }
  return removed;
}
