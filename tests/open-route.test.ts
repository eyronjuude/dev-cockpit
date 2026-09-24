import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SpawnPlan } from '@/process/exec';

/**
 * The "Open worktree" / "Open landing worktree" buttons both post to this one
 * route, disambiguated by `target`. What's worth proving here is the part
 * `tests/exec.test.ts` cannot reach: which directory each `target` resolves
 * to, and that a missing run or a missing directory surfaces as a clean
 * `AppError` response rather than an unhandled exception. The actual spawn is
 * mocked out — `resolveExecutable`/`spawnDetached` already have their own
 * unit tests, and a route test has no business launching a real process.
 */

const planSpawn = vi.fn(
  (file: string, args: readonly string[]): SpawnPlan => ({
    file,
    args: [...args],
    windowsVerbatimArguments: false,
    describe: `${file} ${args.join(' ')}`,
  }),
);
const spawnDetached = vi.fn(async (plan: SpawnPlan) => plan.describe);

vi.mock('@/process/exec', () => ({
  planSpawn: (file: string, args: readonly string[]) => planSpawn(file, args),
  spawnDetached: (plan: SpawnPlan) => spawnDetached(plan),
}));

let dataDir: string;
let repoDir: string;

let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let paths: typeof import('@/core/paths');
let closeDb: typeof import('@/db/client').closeDb;
let POST: typeof import('@/app/api/runs/[runId]/open/route').POST;

let projectId: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function openRequest(body: unknown, origin: string | null = 'http://127.0.0.1:3000'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return new Request('http://127.0.0.1:3000/api/runs/x/open', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function callOpen(runId: string, body: unknown, origin?: string | null) {
  return POST(openRequest(body, origin), { params: Promise.resolve({ runId }) });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-open-route-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  repoDir = path.join(dataDir, 'source-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# source\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial commit']);

  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  paths = await import('@/core/paths');
  ({ closeDb } = await import('@/db/client'));
  ({ POST } = await import('@/app/api/runs/[runId]/open/route'));

  const project = await projectsService.createProject({
    name: 'Open route fixture',
    repositoryPath: repoDir,
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

beforeEach(() => {
  planSpawn.mockClear();
  spawnDetached.mockClear();
});

function makeRun(worktreePath: string | null): string {
  const run = runsService.createRun({
    projectId,
    request: 'open route fixture run',
    title: 'open route fixture run',
    profile: 'standard',
    mode: 'build',
  });
  if (worktreePath !== null) {
    runsService.updateRunFields(run.id, { worktreePath });
  }
  return run.id;
}

describe('POST /api/runs/[runId]/open', () => {
  it('rejects a request with no Origin header', async () => {
    const runId = makeRun(repoDir);
    const response = await callOpen(runId, { target: 'worktree' }, null);
    expect(response.status).toBe(403);
  });

  it('opens the run worktree and launches the configured open command', async () => {
    const wtPath = path.join(dataDir, 'worktree-a');
    fs.mkdirSync(wtPath, { recursive: true });
    const runId = makeRun(wtPath);
    projectsService.updateProject(projectId, { openCommand: 'code {path}' });

    const response = await callOpen(runId, { target: 'worktree' });
    const payload = (await response.json()) as { opened: boolean; path: string };

    expect(response.status).toBe(200);
    expect(payload.opened).toBe(true);
    expect(payload.path).toBe(wtPath);
    expect(planSpawn).toHaveBeenCalledWith('code', [wtPath]);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('falls back to the platform opener when no open command is configured', async () => {
    const wtPath = path.join(dataDir, 'worktree-b');
    fs.mkdirSync(wtPath, { recursive: true });
    const runId = makeRun(wtPath);
    projectsService.updateProject(projectId, { openCommand: null });

    const response = await callOpen(runId, { target: 'worktree' });
    expect(response.status).toBe(200);

    const expectedOpener =
      process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    expect(planSpawn).toHaveBeenCalledWith(expectedOpener, [wtPath]);
  });

  it('opens the landing worktree directory for target "landing"', async () => {
    const runId = makeRun(repoDir);
    const landingPath = paths.runLandingDir(projectId, runId);
    fs.mkdirSync(landingPath, { recursive: true });

    const response = await callOpen(runId, { target: 'landing' });
    const payload = (await response.json()) as { opened: boolean; path: string };

    expect(response.status).toBe(200);
    expect(payload.path).toBe(landingPath);
  });

  it('opens the repository directory for target "repository"', async () => {
    const runId = makeRun(null);

    const response = await callOpen(runId, { target: 'repository' });
    const payload = (await response.json()) as { opened: boolean; path: string };

    expect(response.status).toBe(200);
    expect(payload.path).toBe(repoDir);
  });

  it('rejects target "worktree" when the run has no worktree yet', async () => {
    const runId = makeRun(null);

    const response = await callOpen(runId, { target: 'worktree' });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/no worktree yet/);
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects target "landing" when landing was never attempted', async () => {
    const runId = makeRun(repoDir);

    const response = await callOpen(runId, { target: 'landing' });
    const payload = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('missing_path');
    expect(payload.error).toMatch(/no longer exists/);
  });

  it('reports a missing directory instead of throwing when the worktree was removed on disk', async () => {
    const goneWtPath = path.join(dataDir, 'worktree-removed');
    const runId = makeRun(goneWtPath);

    const response = await callOpen(runId, { target: 'worktree' });
    const payload = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('missing_path');
    expect(payload.error).toContain(goneWtPath);
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('surfaces a spawn failure as a clean error rather than crashing', async () => {
    const wtPath = path.join(dataDir, 'worktree-c');
    fs.mkdirSync(wtPath, { recursive: true });
    const runId = makeRun(wtPath);
    projectsService.updateProject(projectId, { openCommand: 'not-a-real-editor {path}' });
    spawnDetached.mockRejectedValueOnce(new Error('Could not launch "not-a-real-editor": ENOENT'));

    const response = await callOpen(runId, { target: 'worktree' });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/ENOENT/);
  });
});
