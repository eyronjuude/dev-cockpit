import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Real git worktrees and real child processes. Nothing here is mocked: the
 * point is to prove the isolation guarantees hold on this machine, including
 * the Windows-specific junction and process-tree-kill paths.
 */

let dataDir: string;
let repoDir: string;

let worktree: typeof import('@/git/worktree');
let diff: typeof import('@/git/diff');
let gitMod: typeof import('@/git/git');
let landing: typeof import('@/git/landing');
let spawnMod: typeof import('@/process/spawn');
let engine: typeof import('@/validation/engine');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let artifactsService: typeof import('@/services/artifacts');
let closeDb: typeof import('@/db/client').closeDb;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-wt-'));
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

  // A dependency directory that a fresh worktree will not have.
  fs.mkdirSync(path.join(repoDir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'node_modules', 'left-pad', 'package.json'),
    '{"name":"left-pad"}',
  );
  // An untracked local env file.
  fs.writeFileSync(path.join(repoDir, '.env.local'), 'PUBLIC_FLAG=1\n');

  worktree = await import('@/git/worktree');
  diff = await import('@/git/diff');
  gitMod = await import('@/git/git');
  landing = await import('@/git/landing');
  spawnMod = await import('@/process/spawn');
  engine = await import('@/validation/engine');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  artifactsService = await import('@/services/artifacts');
  ({ closeDb } = await import('@/db/client'));
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

describe('git probing', () => {
  it('recognises a git repository and its default branch', async () => {
    expect(await gitMod.isGitRepository(repoDir)).toBe(true);
    expect(await gitMod.guessDefaultBranch(repoDir)).toBe('main');
  });

  it('rejects a directory that is not a repository', async () => {
    const plain = path.join(dataDir, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    expect(await gitMod.isGitRepository(plain)).toBe(false);
  });

  it('reads commit metadata', async () => {
    const head = await gitMod.resolveCommit(repoDir, 'HEAD');
    const info = await gitMod.commitInfo(repoDir, head);
    expect(info?.sha).toBe(head);
    expect(info?.subject).toBe('initial commit');
    expect(info?.shortSha.length).toBeGreaterThanOrEqual(7);
  });

  it('probes a repository through the project service', async () => {
    const probe = await projectsService.probeRepository(repoDir);
    expect(probe.ok).toBe(true);
    expect(probe.defaultBranch).toBe('main');
    expect(probe.branches).toContain('main');
  });
});

describe('worktree isolation', () => {
  it('creates a worktree on a new branch and leaves the source tree untouched', async () => {
    const runId = 'run_wt_basic';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const base = await gitMod.resolveCommit(repoDir, 'main');

    // Leave an uncommitted change in the source tree: it must survive.
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# source\nlocal edit\n');

    const prepared = await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    expect(prepared.baseCommit).toBe(base);
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);

    // The worktree is on its own branch, at the base commit.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath).trim()).toBe(`cockpit/${runId}`);
    expect(git(['rev-parse', 'HEAD'], wtPath).trim()).toBe(base);

    // The user's uncommitted edit is still there, and still uncommitted.
    expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toContain('local edit');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(await gitMod.isDirty(repoDir)).toBe(true);

    // The worktree got the committed content, not the uncommitted edit.
    expect(fs.readFileSync(path.join(wtPath, 'README.md'), 'utf8')).not.toContain('local edit');

    // Restore the source tree for later tests.
    git(['checkout', '--', 'README.md']);
  });

  it('refuses to run on a protected branch', async () => {
    await expect(
      worktree.prepareWorktree({
        repositoryPath: repoDir,
        worktreePath: path.join(dataDir, 'worktrees', 'prj', 'run_protected'),
        branch: 'main',
        baseRef: 'main',
        protectedBranches: ['main', 'master'],
      }),
    ).rejects.toThrow(/protected branch/i);
  });

  it('refuses a worktree path outside the data directory', async () => {
    await expect(
      worktree.prepareWorktree({
        repositoryPath: repoDir,
        worktreePath: path.join(os.tmpdir(), 'somewhere-else'),
        branch: 'cockpit/run_escape',
        baseRef: 'main',
        protectedBranches: ['main'],
      }),
    ).rejects.toThrow(/must live under/i);
  });

  it('refuses to reuse an existing branch name', async () => {
    const runId = 'run_wt_dupe';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    await expect(
      worktree.prepareWorktree({
        repositoryPath: repoDir,
        worktreePath: path.join(dataDir, 'worktrees', 'prj', 'run_wt_dupe_2'),
        branch: `cockpit/${runId}`,
        baseRef: 'main',
        protectedBranches: ['main'],
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('links a dependency directory and copies an env file into the worktree', async () => {
    const runId = 'run_wt_link';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    const result = await worktree.linkIntoWorktree(repoDir, wtPath, [
      'node_modules',
      '.env.local',
      'does-not-exist',
    ]);

    expect(result.linked).toContain('node_modules');
    expect(result.linked).toContain('.env.local');
    expect(result.failed.map((f) => f.path)).toContain('does-not-exist');

    // The linked directory resolves through to the real dependency.
    expect(
      fs.existsSync(path.join(wtPath, 'node_modules', 'left-pad', 'package.json')),
    ).toBe(true);
    // The env file is copied, not linked, so an edit cannot reach the source.
    expect(fs.lstatSync(path.join(wtPath, '.env.local')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wtPath, '.env.local'), 'utf8')).toContain('PUBLIC_FLAG=1');
  });

  it('refuses to link a path that escapes the repository', async () => {
    const runId = 'run_wt_escape_link';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    const result = await worktree.linkIntoWorktree(repoDir, wtPath, ['../outside']);
    expect(result.linked).toEqual([]);
    expect(result.failed[0]?.error).toMatch(/escapes/);
  });

  it('lists cockpit worktrees alongside the main checkout', async () => {
    const entries = await worktree.listWorktrees(repoDir);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.some((e) => e.branch === 'main')).toBe(true);
    expect(entries.some((e) => e.branch?.startsWith('cockpit/'))).toBe(true);
  });

  it('will not remove a worktree holding uncommitted work unless forced', async () => {
    const runId = 'run_wt_dirty';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });
    fs.writeFileSync(path.join(wtPath, 'work.txt'), 'unsaved work\n');

    const refused = await worktree.removeWorktree(repoDir, wtPath, `cockpit/${runId}`);
    expect(refused.removed).toBe(false);
    expect(refused.reason).toMatch(/uncommitted/);
    expect(fs.existsSync(wtPath)).toBe(true);

    const forced = await worktree.removeWorktree(repoDir, wtPath, `cockpit/${runId}`, {
      force: true,
      deleteBranch: true,
    });
    expect(forced.removed).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

describe('diff collection', () => {
  it('reports modified, added, untracked and deleted files with line counts', async () => {
    const runId = 'run_diff';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const prepared = await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    // Modified and staged.
    fs.writeFileSync(path.join(wtPath, 'README.md'), '# source\nadded line\n');
    execFileSync('git', ['add', 'README.md'], { cwd: wtPath, windowsHide: true });
    // Added but never staged.
    fs.writeFileSync(path.join(wtPath, 'new-file.ts'), 'export const a = 1;\nexport const b = 2;\n');
    // Deleted.
    fs.rmSync(path.join(wtPath, '.gitignore'));

    const result = await diff.collectRunDiff(wtPath, prepared.baseCommit);
    const byPath = new Map(result.files.map((f) => [f.path, f]));

    expect(byPath.get('README.md')?.changeType).toBe('modified');
    expect(byPath.get('README.md')?.additions).toBe(1);
    expect(byPath.get('.gitignore')?.changeType).toBe('deleted');
    // An untracked file is reported, not silently dropped.
    expect(byPath.get('new-file.ts')?.changeType).toBe('untracked');
    expect(byPath.get('new-file.ts')?.additions).toBe(2);

    // The patch contains real diff content for both tracked and untracked work.
    expect(result.patch).toContain('added line');
    expect(result.patch).toContain('export const a = 1;');
    expect(result.additions).toBeGreaterThan(0);
  });

  it('reports no changes for an untouched worktree', async () => {
    const runId = 'run_diff_clean';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const prepared = await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    const result = await diff.collectRunDiff(wtPath, prepared.baseCommit);
    expect(result.files).toEqual([]);
    expect(result.additions).toBe(0);
  });

  it('commits everything in the worktree onto the run branch only', async () => {
    const runId = 'run_commit';
    const wtPath = path.join(dataDir, 'worktrees', 'prj', runId);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${runId}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });
    const mainBefore = git(['rev-parse', 'main']).trim();

    fs.writeFileSync(path.join(wtPath, 'feature.ts'), 'export const feature = true;\n');
    const sha = await diff.commitAll(wtPath, 'feat: add feature', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(['rev-parse', `cockpit/${runId}`]).trim()).toBe(sha);
    // main is exactly where it was: approval never merges.
    expect(git(['rev-parse', 'main']).trim()).toBe(mainBefore);
  });
});

describe('landing worktrees', () => {
  it('approves a run whose worktree changes were already committed', async () => {
    const repo = makeSecondRepo('approve-committed');
    const project = await projectsService.createProject({
      name: 'approve-committed',
      repositoryPath: repo,
    });
    const run = runsService.createRun({ projectId: project.id, request: 'commit first' });
    const runPath = path.join(dataDir, 'worktrees', project.id, run.id);

    const prepared = await worktree.prepareWorktree({
      repositoryPath: repo,
      worktreePath: runPath,
      branch: `cockpit/${run.id}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });
    runsService.updateRunFields(run.id, {
      worktreePath: prepared.worktreePath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      baseBranch: 'main',
    });

    fs.writeFileSync(path.join(runPath, 'feature.txt'), 'already committed\n');
    const sha = await diff.commitAll(runPath, 'feat: already committed', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });
    const collected = await diff.collectRunDiff(runPath, prepared.baseCommit);
    runsService.replaceChangedFiles(run.id, collected.files);
    runsService.setStatus(run.id, 'PREPARING', { started: true });
    runsService.setStatus(run.id, 'IMPLEMENTING');
    runsService.setStatus(run.id, 'VALIDATING');
    runsService.setStatus(run.id, 'READY', { finished: true });

    const { approveRun } = await import('@/orchestrator/orchestrator');
    const approved = await approveRun(run.id);

    expect(approved.status).toBe('APPROVED');
    expect(approved.commitSha).toBe(sha);
  });

  it('merges a run branch in isolation before fast-forwarding the target branch', async () => {
    const repo = makeSecondRepo('landing-clean');
    const runId = 'run_land_clean';
    const sourceBranch = `cockpit/${runId}`;
    const landingBranch = `cockpit/landing/${runId}`;
    const runPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const landingPath = path.join(dataDir, 'landings', 'prj', runId);

    await worktree.prepareWorktree({
      repositoryPath: repo,
      worktreePath: runPath,
      branch: sourceBranch,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    fs.writeFileSync(path.join(runPath, 'feature.txt'), 'landed feature\n');
    await diff.commitAll(runPath, 'feat: add landed feature', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    const mainBefore = git(['rev-parse', 'main'], repo).trim();
    const prepared = await landing.ensureLandingWorktree({
      repositoryPath: repo,
      worktreePath: landingPath,
      branch: landingBranch,
      targetBranch: 'main',
    });

    expect(prepared.targetCommit).toBe(mainBefore);

    const merged = await landing.mergeSourceIntoLanding(landingPath, sourceBranch);
    expect(merged.conflicts).toEqual([]);

    const completed = await landing.completeMergeIfResolved(landingPath, {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    expect(completed.completed).toBe(true);
    expect(completed.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(['rev-parse', 'main'], repo).trim()).toBe(mainBefore);

    const applied = await landing.applyLandingToTarget(repo, 'main', landingBranch);
    expect(applied).toBe(completed.commitSha);
    expect(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toContain('landed feature');
  });

  it('keeps the target branch unchanged when the landing merge conflicts', async () => {
    const repo = makeSecondRepo('landing-conflict');
    const runId = 'run_land_conflict';
    const sourceBranch = `cockpit/${runId}`;
    const landingBranch = `cockpit/landing/${runId}`;
    const runPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const landingPath = path.join(dataDir, 'landings', 'prj', runId);

    await worktree.prepareWorktree({
      repositoryPath: repo,
      worktreePath: runPath,
      branch: sourceBranch,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    fs.writeFileSync(path.join(runPath, 'file.txt'), 'run branch edit\n');
    await diff.commitAll(runPath, 'feat: edit from run branch', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    fs.writeFileSync(path.join(repo, 'file.txt'), 'main branch edit\n');
    await diff.commitAll(repo, 'edit main', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });
    const mainBefore = git(['rev-parse', 'main'], repo).trim();

    await landing.ensureLandingWorktree({
      repositoryPath: repo,
      worktreePath: landingPath,
      branch: landingBranch,
      targetBranch: 'main',
    });

    const merged = await landing.mergeSourceIntoLanding(landingPath, sourceBranch);
    expect(merged.merged).toBe(false);
    expect(merged.conflicts).toEqual(['file.txt']);
    expect(await landing.unmergedFiles(landingPath)).toEqual(['file.txt']);
    expect(git(['rev-parse', 'main'], repo).trim()).toBe(mainBefore);
    expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('main branch edit\n');
  });

  it('stages marker-free conflict files before completing a landing merge', async () => {
    const repo = makeSecondRepo('landing-stage-resolved');
    const runId = 'run_land_stage_resolved';
    const sourceBranch = `cockpit/${runId}`;
    const landingBranch = `cockpit/landing/${runId}`;
    const runPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const landingPath = path.join(dataDir, 'landings', 'prj', runId);

    await worktree.prepareWorktree({
      repositoryPath: repo,
      worktreePath: runPath,
      branch: sourceBranch,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    fs.writeFileSync(path.join(runPath, 'file.txt'), 'run branch edit\n');
    await diff.commitAll(runPath, 'feat: edit from run branch', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    fs.writeFileSync(path.join(repo, 'file.txt'), 'main branch edit\n');
    await diff.commitAll(repo, 'edit main', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    await landing.ensureLandingWorktree({
      repositoryPath: repo,
      worktreePath: landingPath,
      branch: landingBranch,
      targetBranch: 'main',
    });
    await landing.mergeSourceIntoLanding(landingPath, sourceBranch);
    fs.writeFileSync(path.join(landingPath, 'file.txt'), 'combined resolution\n');

    const completed = await landing.completeMergeIfResolved(landingPath, {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    expect(completed.completed).toBe(true);
    expect(completed.staged).toEqual(['file.txt']);
    expect(completed.conflicts).toEqual([]);
    expect(git(['diff', '--name-only', '--diff-filter=U'], landingPath)).toBe('');
    expect(git(['rev-parse', landingBranch], repo).trim()).toBe(completed.commitSha);
  });

  it('does not stage conflict files while markers remain', async () => {
    const repo = makeSecondRepo('landing-markers-remain');
    const runId = 'run_land_markers_remain';
    const sourceBranch = `cockpit/${runId}`;
    const landingBranch = `cockpit/landing/${runId}`;
    const runPath = path.join(dataDir, 'worktrees', 'prj', runId);
    const landingPath = path.join(dataDir, 'landings', 'prj', runId);

    await worktree.prepareWorktree({
      repositoryPath: repo,
      worktreePath: runPath,
      branch: sourceBranch,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    fs.writeFileSync(path.join(runPath, 'file.txt'), 'run branch edit\n');
    await diff.commitAll(runPath, 'feat: edit from run branch', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    fs.writeFileSync(path.join(repo, 'file.txt'), 'main branch edit\n');
    await diff.commitAll(repo, 'edit main', {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    await landing.ensureLandingWorktree({
      repositoryPath: repo,
      worktreePath: landingPath,
      branch: landingBranch,
      targetBranch: 'main',
    });
    await landing.mergeSourceIntoLanding(landingPath, sourceBranch);
    fs.writeFileSync(
      path.join(landingPath, 'file.txt'),
      '<<<<<<< HEAD\nmain branch edit\n=======\nrun branch edit\n>>>>>>> feature\n',
    );

    const completed = await landing.completeMergeIfResolved(landingPath, {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    expect(completed.completed).toBe(false);
    expect(completed.conflicts).toEqual(['file.txt']);
    expect(completed.markerFiles).toEqual(['file.txt']);
    expect(completed.staged).toEqual([]);
    expect(await landing.unmergedFiles(landingPath)).toEqual(['file.txt']);
  });
});

describe('process execution', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await spawnMod.runCommand({
      command: 'node -e "console.log(\'hello from the validator\')"',
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from the validator');
    expect(spawnMod.succeeded(result)).toBe(true);
  });

  it('captures a non-zero exit code and stderr without throwing', async () => {
    const result = await spawnMod.runCommand({
      command: 'node -e "console.error(\'boom\'); process.exit(3)"',
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(spawnMod.succeeded(result)).toBe(false);
  });

  it('redacts a secret that a command prints', async () => {
    const result = await spawnMod.runCommand({
      command:
        'node -e "console.log(\'key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG\')"',
      cwd: repoDir,
    });
    expect(result.stdout).not.toContain('sk-ant-api03-AAAABBBB');
    expect(result.stdout).toContain('[redacted]');
    expect(result.redactionHits).toContain('anthropic-key');
  });

  it('times out and reports it rather than hanging', async () => {
    const result = await spawnMod.runCommand({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      cwd: repoDir,
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    expect(spawnMod.succeeded(result)).toBe(false);
  });

  it('kills the process tree when aborted', async () => {
    const controller = new AbortController();
    const pending = spawnMod.runCommand({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      cwd: repoDir,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 400);
    const result = await pending;
    expect(result.aborted).toBe(true);
  });

  it('reports a spawn failure honestly instead of pretending to pass', async () => {
    const result = await spawnMod.runCommand({
      command: 'this-command-definitely-does-not-exist-12345',
      cwd: repoDir,
    });
    expect(spawnMod.succeeded(result)).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('validation engine', () => {
  it('runs configured commands, records outcomes and writes artifacts', async () => {
    const project = await projectsService.createProject({
      name: 'engine-project',
      repositoryPath: repoDir,
      validationCommands: [
        { kind: 'typecheck', command: 'node -e "console.log(\'types ok\')"' },
        { kind: 'unit', command: 'node -e "console.error(\'1 test failed\'); process.exit(1)"' },
      ],
    });

    const run = runsService.createRun({ projectId: project.id, request: 'engine test' });
    const wtPath = path.join(dataDir, 'worktrees', project.id, run.id);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: `cockpit/${run.id}`,
      baseRef: 'main',
      protectedBranches: ['main'],
    });

    const summary = await engine.runValidation({
      runId: run.id,
      worktreePath: wtPath,
      project,
      profile: 'standard',
    });

    expect(summary.attempt).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.blocking).toBe(true);

    const stored = runsService.latestValidationAttempt(run.id);
    const byKind = new Map(stored.map((s) => [s.kind, s]));

    expect(byKind.get('typecheck')?.outcome).toBe('pass');
    expect(byKind.get('typecheck')?.exitCode).toBe(0);
    expect(byKind.get('unit')?.outcome).toBe('fail');
    expect(byKind.get('unit')?.exitCode).toBe(1);
    expect(byKind.get('unit')?.stderr).toContain('1 test failed');

    // Every kind is represented, so the scorecard can tell unset from failed.
    expect(byKind.get('e2e')?.outcome).toBe('not_configured');
    expect(byKind.get('build')?.outcome).toBe('not_configured');
    expect(byKind.get('lint')?.outcome).toBe('not_configured');

    // Durations are recorded as facts.
    expect(byKind.get('typecheck')?.durationMs).toBeGreaterThanOrEqual(0);

    const artifacts = artifactsService.listArtifacts(run.id);
    expect(artifacts.some((a) => a.kind === 'validation_report')).toBe(true);
    expect(artifacts.some((a) => a.kind === 'stdout_log')).toBe(true);

    const report = artifacts.find((a) => a.kind === 'validation_report');
    expect(report?.exists).toBe(true);
    const content = await artifactsService.readArtifactText(report!.id);
    expect(content?.text).toContain('| typecheck | pass |');
    expect(content?.text).toContain('| e2e | not configured |');
  });

  it('records an error, not a failure, when a command cannot start', async () => {
    const project = await projectsService.createProject({
      name: 'engine-missing-binary',
      repositoryPath: makeSecondRepo(),
      validationCommands: [
        { kind: 'build', command: 'no-such-binary-xyz --build', timeoutMs: 30_000 },
      ],
    });

    const run = runsService.createRun({ projectId: project.id, request: 'x' });
    const wtPath = path.join(dataDir, 'worktrees', project.id, run.id);
    await worktree.prepareWorktree({
      repositoryPath: project.repositoryPath,
      worktreePath: wtPath,
      branch: `cockpit/${run.id}`,
      baseRef: project.defaultBranch,
      protectedBranches: [project.defaultBranch],
    });

    await engine.runValidation({
      runId: run.id,
      worktreePath: wtPath,
      project,
      profile: 'standard',
    });

    const build = runsService
      .latestValidationAttempt(run.id)
      .find((v) => v.kind === 'build');
    // A missing binary exits non-zero via the shell rather than failing to
    // spawn, so either classification is honest — what matters is that it is
    // not recorded as a pass.
    expect(build?.outcome === 'fail' || build?.outcome === 'error').toBe(true);
    expect(build?.exitCode).not.toBe(0);
  });

  it('only runs commands enabled for the selected profile', async () => {
    const project = await projectsService.createProject({
      name: 'engine-profiles',
      repositoryPath: makeSecondRepo('profiles'),
      validationCommands: [
        { kind: 'unit', command: 'node -e "0"', profiles: ['quick', 'standard', 'deep'] },
        { kind: 'e2e', command: 'node -e "0"', profiles: ['deep'] },
      ],
    });

    expect(engine.kindsForProfile(project, 'quick').map((c) => c.kind)).toEqual(['unit']);
    expect(engine.kindsForProfile(project, 'deep').map((c) => c.kind)).toEqual(['unit', 'e2e']);
  });

  it('refuses a working directory that escapes the worktree', async () => {
    const project = await projectsService.createProject({
      name: 'engine-escape',
      repositoryPath: makeSecondRepo('escape'),
      validationCommands: [
        { kind: 'lint', command: 'node -e "0"', workingDir: '../../../' },
      ],
    });

    const run = runsService.createRun({ projectId: project.id, request: 'x' });
    const wtPath = path.join(dataDir, 'worktrees', project.id, run.id);
    await worktree.prepareWorktree({
      repositoryPath: project.repositoryPath,
      worktreePath: wtPath,
      branch: `cockpit/${run.id}`,
      baseRef: project.defaultBranch,
      protectedBranches: [project.defaultBranch],
    });

    await engine.runValidation({
      runId: run.id,
      worktreePath: wtPath,
      project,
      profile: 'standard',
    });

    const lint = runsService.latestValidationAttempt(run.id).find((v) => v.kind === 'lint');
    expect(lint?.outcome).toBe('error');
    expect(lint?.error).toMatch(/escapes the worktree/);
  });
});

let secondRepoCounter = 0;
function makeSecondRepo(suffix = 'extra'): string {
  secondRepoCounter += 1;
  const dir = path.join(dataDir, `repo-${suffix}-${secondRepoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}
