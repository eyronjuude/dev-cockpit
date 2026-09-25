import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentOutcome, ImplementationAgent } from '@/agents/types';
import type { RunStatus } from '@/domain/types';

/**
 * The project's teardown command, run as a worktree is removed.
 *
 * Per-run env tokens give each worktree its own scratch database, and
 * nothing dropped them. The teardown is the other half of the setup command:
 * it runs inside the worktree, with the same resolved env, just before the
 * directory goes.
 *
 * What has to hold: it runs for every worktree actually removed, never for
 * one that is kept, and a failing teardown never keeps a worktree alive.
 */

let dataDir: string;
let repoDir: string;
let teardownLog: string;

let worktree: typeof import('@/git/worktree');
let landing: typeof import('@/git/landing');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let worktreesService: typeof import('@/services/worktrees');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let paths: typeof import('@/core/paths');
let ids: typeof import('@/core/ids');
let closeDb: typeof import('@/db/client').closeDb;

let projectId: string;

/** Records the resolved URL and where it ran, one line per teardown. */
const RECORDING_TEARDOWN =
  'node -e "require(\'fs\').appendFileSync(process.env.TEARDOWN_LOG, process.env.DATABASE_URL + \'|\' + process.cwd() + \'\\n\')"';

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function teardowns(): { url: string; cwd: string }[] {
  if (!fs.existsSync(teardownLog)) return [];
  return fs
    .readFileSync(teardownLog, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [url, cwd] = line.split('|');
      return { url: url ?? '', cwd: cwd ?? '' };
    });
}

function runAt(status: RunStatus, title: string): string {
  const run = runsService.createRun({ projectId, request: title, title, mode: 'build' });
  const route: Record<string, RunStatus[]> = {
    REJECTED: ['PREPARING', 'IMPLEMENTING', 'READY', 'REJECTED'],
    FAILED: ['PREPARING', 'FAILED'],
  };
  for (const step of route[status] ?? []) runsService.setStatus(run.id, step);
  return run.id;
}

async function attachWorktree(runId: string): Promise<string> {
  const wtPath = paths.runWorktreeDir(projectId, runId);
  await worktree.prepareWorktree({
    repositoryPath: repoDir,
    worktreePath: wtPath,
    branch: ids.runBranchName(runId),
    baseRef: 'main',
    protectedBranches: ['main'],
  });
  runsService.updateRunFields(runId, { worktreePath: wtPath, branch: ids.runBranchName(runId) });
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

function teardownEvents(runId: string) {
  return eventsService.listEvents(runId).filter((e) => e.type === 'worktree.teardown');
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-teardown-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;
  teardownLog = path.join(dataDir, 'teardown.log');

  repoDir = path.join(dataDir, 'source-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# source\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial commit']);

  worktree = await import('@/git/worktree');
  landing = await import('@/git/landing');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
  worktreesService = await import('@/services/worktrees');
  orchestrator = await import('@/orchestrator/orchestrator');
  paths = await import('@/core/paths');
  ids = await import('@/core/ids');
  ({ closeDb } = await import('@/db/client'));

  const project = await projectsService.createProject({
    name: 'Teardown fixture',
    repositoryPath: repoDir,
    teardownCommand: RECORDING_TEARDOWN,
    env: ['DATABASE_URL=postgres://localhost/app_{runId}_{worktree}', `TEARDOWN_LOG=${teardownLog}`],
  });
  projectId = project.id;
});

beforeEach(() => {
  fs.rmSync(teardownLog, { force: true });
  projectsService.updateProject(projectId, { teardownCommand: RECORDING_TEARDOWN });
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

describe('teardown command', () => {
  it('is stored on the project', () => {
    expect(projectsService.requireProject(projectId).teardownCommand).toBe(RECORDING_TEARDOWN);
  });

  it('runs inside each worktree removed, with its own resolved env', async () => {
    const runId = runAt('REJECTED', 'both worktrees');
    const runPath = await attachWorktree(runId);
    const landingPath = await attachLandingWorktree(runId);

    const report = await worktreesService.cleanUpRunWorktrees(runId);

    expect(report.removed).toBe(2);
    expect(teardowns()).toEqual([
      { url: `postgres://localhost/app_${runId}_run`, cwd: runPath },
      { url: `postgres://localhost/app_${runId}_landing`, cwd: landingPath },
    ]);
    expect(teardownEvents(runId).map((e) => e.payload)).toMatchObject([
      { worktreeKind: 'run', exitCode: 0 },
      { worktreeKind: 'landing', exitCode: 0 },
    ]);
  });

  it('does not run for a worktree the cleanup keeps', async () => {
    const runId = runAt('REJECTED', 'dirty worktree');
    const runPath = await attachWorktree(runId);
    fs.writeFileSync(path.join(runPath, 'unsaved.txt'), 'work in progress\n');

    const report = await worktreesService.cleanUpRunWorktrees(runId);

    expect(report.kept).toBe(1);
    expect(fs.existsSync(runPath)).toBe(true);
    // The worktree survived, so its database has to as well.
    expect(teardowns()).toEqual([]);
    expect(teardownEvents(runId)).toHaveLength(0);
  });

  it('removes the worktree even when the teardown fails', async () => {
    projectsService.updateProject(projectId, { teardownCommand: 'node -e "process.exit(3)"' });
    const runId = runAt('FAILED', 'failing teardown');
    const runPath = await attachWorktree(runId);

    const report = await worktreesService.cleanUpRunWorktrees(runId);

    expect(report.removed).toBe(1);
    expect(fs.existsSync(runPath)).toBe(false);
    const [event] = teardownEvents(runId);
    expect(event?.level).toBe('notice');
    expect(event?.payload).toMatchObject({ worktreeKind: 'run', exitCode: 3 });
  });

  it('does nothing when no teardown command is configured', async () => {
    projectsService.updateProject(projectId, { teardownCommand: null });
    const runId = runAt('REJECTED', 'no teardown');
    await attachWorktree(runId);

    const report = await worktreesService.cleanUpRunWorktrees(runId);

    expect(report.removed).toBe(1);
    expect(teardowns()).toEqual([]);
    expect(teardownEvents(runId)).toHaveLength(0);
  });

  it('runs before a restart discards the worktree, so attempt 2 starts clean', async () => {
    const fakeOutcome: AgentOutcome = {
      ok: true,
      sessionId: 'sess-teardown',
      exitCode: 0,
      finalText: 'Done.',
      numTurns: 1,
      durationMs: 5,
      costUsd: 0,
      usage: null,
      errorMessage: null,
      cancelled: false,
      timedOut: false,
      deniedTools: [],
      rawLogPath: null,
    };
    const agent: ImplementationAgent = {
      id: 'claude-code',
      label: 'Teardown Test Agent',
      async checkAvailability() {
        return { available: true, detail: 'fake agent', version: 'test' };
      },
      async startRun(input) {
        fs.writeFileSync(path.join(input.worktreePath, 'agent.txt'), 'written\n');
        return fakeOutcome;
      },
      async continueRun() {
        return fakeOutcome;
      },
      async cancelRun() {
        return false;
      },
      getStatus(iterationId) {
        return { running: false, iterationId, pid: null, startedAt: null, sessionId: null };
      },
    };

    const waitForIdle = async (runId: string) => {
      const deadline = Date.now() + 60_000;
      while (orchestrator.isRunActive(runId)) {
        if (Date.now() > deadline) throw new Error(`run ${runId} did not go idle`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    const created = runsService.createRun({ projectId, request: 'restart me', mode: 'build' });
    const restore = orchestrator.registerAgent(agent);
    let firstPath: string | null = null;
    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
      firstPath = runsService.requireRun(created.id).worktreePath;
      expect(firstPath).not.toBeNull();

      // Restart starts attempt 2 itself; wait for it so nothing outlives the test.
      await orchestrator.restartRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    // Exactly one: attempt 1's, before its worktree went. Attempt 2's worktree
    // is still in use, so its database is too.
    expect(teardowns()).toEqual([
      { url: `postgres://localhost/app_${created.id}_run`, cwd: firstPath },
    ]);
  });
});
