import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RunStatus } from '@/domain/types';

/**
 * Reclaiming a finished run's worktrees, against a real repository.
 *
 * The three things worth proving are the three ways this could go wrong:
 * it must reach both of the run's worktrees, it must not reach anything that
 * is not the run's, and it must not silently destroy work — an uncommitted
 * change or an unmerged branch has to survive a cleanup that was not forced.
 */

let dataDir: string;
let repoDir: string;

let worktree: typeof import('@/git/worktree');
let landing: typeof import('@/git/landing');
let gitMod: typeof import('@/git/git');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let worktreesService: typeof import('@/services/worktrees');
let paths: typeof import('@/core/paths');
let ids: typeof import('@/core/ids');
let closeDb: typeof import('@/db/client').closeDb;

let projectId: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** Walks a fresh run to a finished status through the real transition table. */
function runAt(status: RunStatus, title: string): string {
  const run = runsService.createRun({
    projectId,
    request: title,
    title,
    profile: 'standard',
    mode: 'build',
  });

  const route: Record<string, RunStatus[]> = {
    REJECTED: ['PREPARING', 'IMPLEMENTING', 'READY', 'REJECTED'],
    LANDED: ['PREPARING', 'IMPLEMENTING', 'READY', 'APPROVED', 'LANDING', 'LANDED'],
    FAILED: ['PREPARING', 'FAILED'],
    READY: ['PREPARING', 'IMPLEMENTING', 'READY'],
  };

  for (const step of route[status] ?? []) {
    runsService.setStatus(run.id, step);
  }
  return run.id;
}

/** Gives a run a real worktree at the path the cleanup will look for. */
async function attachWorktree(runId: string): Promise<string> {
  const wtPath = paths.runWorktreeDir(projectId, runId);
  await worktree.prepareWorktree({
    repositoryPath: repoDir,
    worktreePath: wtPath,
    branch: ids.runBranchName(runId),
    baseRef: 'main',
    protectedBranches: ['main'],
  });
  runsService.updateRunFields(runId, { worktreePath: wtPath });
  return wtPath;
}

async function attachLandingWorktree(runId: string): Promise<string> {
  const landingPath = paths.runLandingDir(projectId, runId);
  await landing.ensureLandingWorktree({
    repositoryPath: repoDir,
    worktreePath: landingPath,
    branch: ids.landingBranchName(runId),
    targetBranch: 'main',
  });
  return landingPath;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-clean-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  repoDir = path.join(dataDir, 'source-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# source\n');
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial commit']);

  // Dependencies the run worktree will hold a junction to.
  fs.mkdirSync(path.join(repoDir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'node_modules', 'left-pad', 'package.json'),
    '{"name":"left-pad"}',
  );

  worktree = await import('@/git/worktree');
  landing = await import('@/git/landing');
  gitMod = await import('@/git/git');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
  worktreesService = await import('@/services/worktrees');
  paths = await import('@/core/paths');
  ids = await import('@/core/ids');
  ({ closeDb } = await import('@/db/client'));

  const project = await projectsService.createProject({
    name: 'Cleanup fixture',
    repositoryPath: repoDir,
    linkPaths: ['node_modules'],
  });
  projectId = project.id;
});

afterAll(() => {
  closeDb?.();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows sometimes holds a handle briefly; the temp directory is disposable.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

describe('cleanup policy', () => {
  it('defaults a new project to reclaiming worktrees', () => {
    expect(projectsService.requireProject(projectId).cleanUpWorktreeOnFinish).toBe(true);
  });

  it('lists both worktrees a run owns, on disk or not', async () => {
    const runId = runAt('REJECTED', 'lists worktrees');
    await attachWorktree(runId);

    const found = worktreesService.listRunWorktrees(runId);
    expect(found.map((w) => w.kind).sort()).toEqual(['landing', 'run']);
    expect(found.find((w) => w.kind === 'run')?.exists).toBe(true);
    // Landing was never attempted, so its directory is absent rather than missing.
    expect(found.find((w) => w.kind === 'landing')?.exists).toBe(false);
  });

  it('refuses to touch the worktrees of a run that is still going', async () => {
    const runId = runAt('READY', 'still going');
    const wtPath = await attachWorktree(runId);

    await expect(worktreesService.cleanUpRunWorktrees(runId)).rejects.toThrow(/only be removed/);
    expect(fs.existsSync(wtPath)).toBe(true);
  });
});

describe('reclaiming a rejected run', () => {
  it('removes the run and landing worktrees and keeps the unmerged branch', async () => {
    const runId = runAt('REJECTED', 'rejected run');
    const wtPath = await attachWorktree(runId);
    const landingPath = await attachLandingWorktree(runId);

    // A commit that never reached main: the branch must survive.
    fs.writeFileSync(path.join(wtPath, 'feature.ts'), 'export const x = 1;\n');
    git(['add', '-A'], wtPath);
    git(['commit', '-qm', 'feature work'], wtPath);

    const report = await worktreesService.cleanUpRunWorktrees(runId, { deleteBranches: true });

    expect(report.removed).toBe(2);
    expect(report.kept).toBe(0);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(landingPath)).toBe(false);

    // `git branch -d` refuses an unmerged branch, which is the whole point.
    expect(await gitMod.refExists(repoDir, `refs/heads/${ids.runBranchName(runId)}`)).toBe(true);
    expect(report.targets.find((t) => t.kind === 'run')?.branchDeleted).toBe(false);

    // The run screen must stop offering to open a directory that is gone.
    expect(runsService.requireRun(runId).worktreePath).toBeNull();
  });

  it('keeps a worktree holding uncommitted work unless forced', async () => {
    const runId = runAt('REJECTED', 'dirty run');
    const wtPath = await attachWorktree(runId);
    fs.writeFileSync(path.join(wtPath, 'unsaved.ts'), 'export const draft = true;\n');

    const kept = await worktreesService.cleanUpRunWorktrees(runId);
    expect(kept.removed).toBe(0);
    expect(kept.kept).toBe(1);
    expect(kept.targets.find((t) => t.kind === 'run')?.reason).toMatch(/uncommitted/);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(runsService.requireRun(runId).worktreePath).toBe(wtPath);

    const forced = await worktreesService.cleanUpRunWorktrees(runId, { force: true });
    expect(forced.removed).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('unlinks a junction rather than deleting what it points at', async () => {
    const runId = runAt('REJECTED', 'linked run');
    const wtPath = await attachWorktree(runId);

    const linked = await worktree.linkIntoWorktree(repoDir, wtPath, ['node_modules']);
    expect(linked.linked).toContain('node_modules');

    await worktreesService.cleanUpRunWorktrees(runId, { force: true });

    expect(fs.existsSync(wtPath)).toBe(false);
    // The developer's own dependencies are untouched.
    expect(
      fs.existsSync(path.join(repoDir, 'node_modules', 'left-pad', 'package.json')),
    ).toBe(true);
  });

  it('records what it did and what it left alone', async () => {
    const runId = runAt('REJECTED', 'event run');
    const wtPath = await attachWorktree(runId);
    fs.writeFileSync(path.join(wtPath, 'unsaved.ts'), 'export const draft = true;\n');

    await worktreesService.cleanUpRunWorktrees(runId);

    const event = eventsService
      .listEvents(runId)
      .filter((e) => e.type === 'worktree.removed')
      .at(-1);
    expect(event).toBeDefined();
    expect(event?.message).toMatch(/uncommitted/);
    const payload = event?.payload as { removed: number; kept: number; automatic: boolean };
    expect(payload.kept).toBe(1);
    expect(payload.automatic).toBe(false);
  });
});

describe('reclaiming a landed run', () => {
  it('deletes the branch once its commits are on the target', async () => {
    const runId = runAt('LANDED', 'landed run');
    const wtPath = await attachWorktree(runId);
    const branch = ids.runBranchName(runId);

    fs.writeFileSync(path.join(wtPath, `${runId}.ts`), 'export const shipped = true;\n');
    git(['add', '-A'], wtPath);
    git(['commit', '-qm', 'shipped'], wtPath);
    git(['merge', '--no-ff', '--no-edit', '-q', branch]);

    const report = await worktreesService.cleanUpFinishedRunWorktrees(runId);

    expect(report?.removed).toBe(1);
    expect(report?.targets.find((t) => t.kind === 'run')?.branchDeleted).toBe(true);
    expect(await gitMod.refExists(repoDir, `refs/heads/${branch}`)).toBe(false);
  });

  it('does nothing when the project has the policy off', async () => {
    projectsService.updateProject(projectId, { cleanUpWorktreeOnFinish: false });

    const runId = runAt('LANDED', 'policy off');
    const wtPath = await attachWorktree(runId);

    expect(await worktreesService.cleanUpFinishedRunWorktrees(runId)).toBeNull();
    expect(fs.existsSync(wtPath)).toBe(true);

    projectsService.updateProject(projectId, { cleanUpWorktreeOnFinish: true });
  });

  it('leaves a run that has not landed yet alone', async () => {
    const runId = runAt('READY', 'awaiting landing');
    const wtPath = await attachWorktree(runId);

    expect(await worktreesService.cleanUpFinishedRunWorktrees(runId)).toBeNull();
    expect(fs.existsSync(wtPath)).toBe(true);
  });
});

describe('worktrees belonging to something else', () => {
  it('will not remove a directory that has another branch checked out', async () => {
    const runId = runAt('REJECTED', 'stale path');
    const otherId = runAt('READY', 'the other run');

    // A recorded path that now holds a different run's worktree: exactly the
    // shape of a stale id reused after a restore.
    const otherPath = await attachWorktree(otherId);
    runsService.updateRunFields(runId, { worktreePath: otherPath });

    const report = await worktreesService.cleanUpRunWorktrees(runId, { force: true });

    expect(report.removed).toBe(0);
    expect(report.targets.find((t) => t.kind === 'run')?.reason).toMatch(/is on cockpit\//);
    expect(fs.existsSync(otherPath)).toBe(true);
  });

  it('will not remove a worktree outside the data directory', async () => {
    const outside = path.join(dataDir, 'outside-worktree');
    await gitMod.git(repoDir, ['worktree', 'add', outside, '-b', 'outside-branch', 'main']);

    const result = await worktree.removeWorktree(repoDir, outside, 'outside-branch', {
      force: true,
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/outside/);
    expect(fs.existsSync(outside)).toBe(true);
  });
});
