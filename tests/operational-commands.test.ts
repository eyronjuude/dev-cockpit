import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Operational commands: deliberate, explicitly-confirmed executions against
 * a real target, as distinct from a validation step.
 *
 * The three things worth proving are the three ways this could go wrong: a
 * `production` command must actually run in the main checkout and must
 * refuse a dirty or wrong-branch checkout; a `non_production` command must
 * run in the named run's own worktree and refuse to run without one; and
 * neither may run at all without explicit confirmation.
 */

let dataDir: string;
let repoDir: string;

let worktree: typeof import('@/git/worktree');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let operationalCommands: typeof import('@/services/operational-commands');
let paths: typeof import('@/core/paths');
let ids: typeof import('@/core/ids');
let closeDb: typeof import('@/db/client').closeDb;

let projectId: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

const nodeCheckEnv = (key: string, expected: string) =>
  `node -e "process.exit(process.env.${key}==='${expected}'?0:1)"`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-opcommands-'));
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
  operationalCommands = await import('@/services/operational-commands');
  paths = await import('@/core/paths');
  ids = await import('@/core/ids');
  ({ closeDb } = await import('@/db/client'));

  const project = await projectsService.createProject({
    name: 'Operational commands fixture',
    repositoryPath: repoDir,
    env: ['FOO=bar'],
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

describe('production target', () => {
  it('runs in the main checkout and sees the project env', async () => {
    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'Check env',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'production',
    });

    const result = await operationalCommands.runOperationalCommand(command.id, {
      confirmed: true,
    });

    expect(result.outcome).toBe('pass');
    expect(result.cwd).toBe(repoDir);
    expect(result.runId).toBeNull();
  });

  it('merges the command\'s own env over the project\'s', async () => {
    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'Check overridden env',
      command: nodeCheckEnv('FOO', 'baz'),
      target: 'production',
      env: ['FOO=baz'],
    });

    const result = await operationalCommands.runOperationalCommand(command.id, {
      confirmed: true,
    });

    expect(result.outcome).toBe('pass');
  });

  it('refuses without explicit confirmation', async () => {
    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'Unconfirmed',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'production',
    });

    await expect(
      operationalCommands.runOperationalCommand(command.id, { confirmed: false }),
    ).rejects.toThrow(/confirmation/);
  });

  it('refuses a dirty main checkout', async () => {
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'uncommitted');
    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'Should not run',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'production',
    });

    try {
      await expect(
        operationalCommands.runOperationalCommand(command.id, { confirmed: true }),
      ).rejects.toThrow(/uncommitted changes/);
    } finally {
      fs.rmSync(path.join(repoDir, 'dirty.txt'));
    }
  });

  it('refuses a runId on a production command', async () => {
    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'No run allowed',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'production',
    });

    await expect(
      operationalCommands.runOperationalCommand(command.id, { confirmed: true, runId: 'run_x' }),
    ).rejects.toThrow(/not a run/);
  });
});

describe('non_production target', () => {
  it('runs inside the named run\'s own worktree', async () => {
    const run = runsService.createRun({
      projectId,
      request: 'Borrow a worktree',
      title: 'Borrow a worktree',
      profile: 'standard',
      mode: 'build',
    });

    const wtPath = paths.runWorktreeDir(projectId, run.id);
    await worktree.prepareWorktree({
      repositoryPath: repoDir,
      worktreePath: wtPath,
      branch: ids.runBranchName(run.id),
      baseRef: 'main',
      protectedBranches: ['main'],
    });
    runsService.updateRunFields(run.id, { worktreePath: wtPath });

    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'Check env in worktree',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'non_production',
    });

    const result = await operationalCommands.runOperationalCommand(command.id, {
      confirmed: true,
      runId: run.id,
    });

    expect(result.outcome).toBe('pass');
    expect(result.cwd).toBe(wtPath);
    expect(result.runId).toBe(run.id);
  });

  it('refuses without a runId', async () => {
    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'Needs a run',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'non_production',
    });

    await expect(
      operationalCommands.runOperationalCommand(command.id, { confirmed: true }),
    ).rejects.toThrow(/needs a run/);
  });

  it('refuses a run with no worktree', async () => {
    const run = runsService.createRun({
      projectId,
      request: 'No worktree',
      title: 'No worktree',
      profile: 'standard',
      mode: 'build',
    });

    const command = operationalCommands.createOperationalCommand(projectId, {
      label: 'No worktree run',
      command: nodeCheckEnv('FOO', 'bar'),
      target: 'non_production',
    });

    await expect(
      operationalCommands.runOperationalCommand(command.id, { confirmed: true, runId: run.id }),
    ).rejects.toThrow(/no worktree/);
  });
});
