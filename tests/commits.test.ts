import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Recording a run's commits from its branch, against a real repository.
 *
 * The three things worth proving: every commit since the base is captured
 * with its own diff, recording again does not duplicate anything, and landing
 * marks every commit a run holds rather than only the newest one.
 */

let dataDir: string;
let repoDir: string;

let worktree: typeof import('@/git/worktree');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let commitsService: typeof import('@/services/commits');
let artifactsService: typeof import('@/services/artifacts');
let paths: typeof import('@/core/paths');
let ids: typeof import('@/core/ids');
let closeDb: typeof import('@/db/client').closeDb;

let projectId: string;
let baseCommit: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function createAttachedRun(): Promise<{ runId: string; worktreePath: string }> {
  const run = runsService.createRun({
    projectId,
    request: 'a run with commits',
    title: 'a run with commits',
    profile: 'standard',
    mode: 'build',
  });
  runsService.setStatus(run.id, 'PREPARING');
  runsService.setStatus(run.id, 'IMPLEMENTING');

  const worktreePath = paths.runWorktreeDir(projectId, run.id);
  await worktree.prepareWorktree({
    repositoryPath: repoDir,
    worktreePath,
    branch: ids.runBranchName(run.id),
    baseRef: 'main',
    protectedBranches: ['main'],
  });
  runsService.updateRunFields(run.id, { worktreePath, baseCommit });

  return { runId: run.id, worktreePath };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-commits-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  repoDir = path.join(dataDir, 'source-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# source\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial commit']);

  worktree = await import('@/git/worktree');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  commitsService = await import('@/services/commits');
  artifactsService = await import('@/services/artifacts');
  paths = await import('@/core/paths');
  ids = await import('@/core/ids');
  ({ closeDb } = await import('@/db/client'));

  const project = await projectsService.createProject({
    name: 'Commits fixture',
    repositoryPath: repoDir,
  });
  projectId = project.id;
  baseCommit = git(['rev-parse', 'HEAD']);
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

describe('recording commits', () => {
  it('captures every commit on the branch, oldest first, each with its own diff', async () => {
    const { runId, worktreePath } = await createAttachedRun();

    fs.writeFileSync(path.join(worktreePath, 'one.ts'), 'export const one = 1;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'add one'], worktreePath);

    fs.writeFileSync(path.join(worktreePath, 'two.ts'), 'export const two = 2;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'add two'], worktreePath);

    await commitsService.recordRunCommits(runId, worktreePath, baseCommit);

    const found = commitsService.listRunCommits(runId);
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.subject)).toEqual(['add one', 'add two']);
    expect(found.every((c) => c.landed)).toBe(false);
    expect(found.every((c) => c.additions === 1)).toBe(true);

    for (const commit of found) {
      expect(commit.diffArtifactId).not.toBeNull();
      const content = await artifactsService.readArtifactText(commit.diffArtifactId!);
      expect(content?.text).toContain(commit.subject === 'add one' ? 'one.ts' : 'two.ts');
    }

    // The run's own view carries the same commits.
    expect(runsService.requireRun(runId).commits).toHaveLength(2);
  });

  it('does not duplicate a commit already recorded', async () => {
    const { runId, worktreePath } = await createAttachedRun();

    fs.writeFileSync(path.join(worktreePath, 'once.ts'), 'export const once = true;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'add once'], worktreePath);

    await commitsService.recordRunCommits(runId, worktreePath, baseCommit);
    await commitsService.recordRunCommits(runId, worktreePath, baseCommit);

    expect(commitsService.listRunCommits(runId)).toHaveLength(1);
  });

  it('records nothing for a branch with no new commits', async () => {
    const { runId, worktreePath } = await createAttachedRun();

    await commitsService.recordRunCommits(runId, worktreePath, baseCommit);

    expect(commitsService.listRunCommits(runId)).toHaveLength(0);
  });
});

describe('landing', () => {
  it('marks every commit a run holds as landed, not only the newest', async () => {
    const { runId, worktreePath } = await createAttachedRun();

    fs.writeFileSync(path.join(worktreePath, 'a.ts'), 'export const a = 1;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'first'], worktreePath);
    fs.writeFileSync(path.join(worktreePath, 'b.ts'), 'export const b = 2;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'second'], worktreePath);

    await commitsService.recordRunCommits(runId, worktreePath, baseCommit);
    commitsService.markRunCommitsLanded(runId);

    const found = commitsService.listRunCommits(runId);
    expect(found).toHaveLength(2);
    expect(found.every((c) => c.landed)).toBe(true);
    expect(found.every((c) => c.landedAt !== null)).toBe(true);
  });
});

describe('restart', () => {
  it('forgets a run’s commits once it is restarted', async () => {
    const { runId, worktreePath } = await createAttachedRun();

    fs.writeFileSync(path.join(worktreePath, 'discarded.ts'), 'export const discarded = true;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'discarded work'], worktreePath);
    await commitsService.recordRunCommits(runId, worktreePath, baseCommit);
    expect(commitsService.listRunCommits(runId)).toHaveLength(1);

    runsService.resetRunForRestart(runId, {
      branch: ids.runAttemptBranchName(runId, 2),
      reason: 'test restart',
      worktreeRemoved: true,
      stoppedActiveWork: false,
    });

    expect(commitsService.listRunCommits(runId)).toHaveLength(0);
  });
});
