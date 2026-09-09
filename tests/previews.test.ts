import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;

let worktree: typeof import('@/git/worktree');
let paths: typeof import('@/core/paths');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let artifactsService: typeof import('@/services/artifacts');
let previewsService: typeof import('@/services/previews');
let closeDb: typeof import('@/db/client').closeDb;
let repoCounter = 0;

function makeRepo(name: string): string {
  repoCounter += 1;
  const repo = path.join(dataDir, 'repos', `${name}-${repoCounter}`);
  fs.mkdirSync(repo, { recursive: true });
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# source\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'initial commit']);
  return repo;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-preview-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  worktree = await import('@/git/worktree');
  paths = await import('@/core/paths');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
  artifactsService = await import('@/services/artifacts');
  previewsService = await import('@/services/previews');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(async () => {
  for (const run of runsService.listRuns({ limit: 100 })) {
    await previewsService.stopRunPreview(run.id, 'test cleanup').catch(() => false);
  }
  closeDb?.();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows can keep a process handle alive briefly after taskkill returns.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

async function runWithWorktree(
  name: string,
  developmentCommand?: string | null,
): Promise<ReturnType<typeof runsService.createRun>> {
  const repositoryPath = makeRepo(name);
  const project = await projectsService.createProject({
    name,
    repositoryPath,
    developmentCommand,
  });
  const run = runsService.createRun({ projectId: project.id, request: 'preview this' });
  const wtPath = paths.runWorktreeDir(project.id, run.id);
  const prepared = await worktree.prepareWorktree({
    repositoryPath,
    worktreePath: wtPath,
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
  return runsService.requireRun(run.id);
}

async function waitForReady(runId: string): Promise<import('@/domain/previews').PreviewView> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const preview = previewsService.getRunPreview(runId);
    if (preview.status === 'ready') return preview;
    if (preview.status === 'failed') throw new Error(preview.error ?? 'preview failed');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('preview did not become ready');
}

const SERVER_COMMAND =
  'node -e "const http=require(\'http\'); const port=Number(process.env.PORT); const server=http.createServer((req,res)=>res.end(\'preview ok\')); server.listen(port,\'127.0.0.1\',()=>console.log(\'ready \'+port));"';

describe('run previews', () => {
  it('starts the project development command in the run worktree and stops it', async () => {
    const run = await runWithWorktree('preview-ok', SERVER_COMMAND);

    const starting = await previewsService.startRunPreview(run.id);
    expect(starting.running).toBe(true);
    expect(starting.status).toBe('starting');
    expect(starting.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(starting.logArtifactId).toMatch(/^art_/);

    const ready = await waitForReady(run.id);
    expect(ready.running).toBe(true);
    expect(ready.url).not.toBeNull();

    const response = await fetch(ready.url!);
    await expect(response.text()).resolves.toBe('preview ok');

    expect(await previewsService.stopRunPreview(run.id, 'done testing')).toBe(true);
    const stopped = previewsService.getRunPreview(run.id);
    expect(stopped.running).toBe(false);
    expect(stopped.status).toBe('stopped');

    const events = eventsService.listEvents(run.id).map((event) => event.type);
    expect(events).toContain('preview.started');
    expect(events).toContain('preview.ready');
    expect(events).toContain('preview.stopped');

    const log = artifactsService.listArtifacts(run.id).find((artifact) => artifact.id === ready.logArtifactId);
    expect(log?.label).toBe('Preview server log');
    expect(log?.previewUrl).toBe(ready.url);
    expect(log?.bytes).toBeGreaterThan(0);
  });

  it('requires a configured development command', async () => {
    const run = await runWithWorktree('preview-no-command', null);
    await expect(previewsService.startRunPreview(run.id)).rejects.toThrow(/development command/);

    const preview = previewsService.getRunPreview(run.id);
    expect(preview.configured).toBe(false);
    expect(preview.status).toBe('not_configured');
  });

  it('requires a run worktree', async () => {
    const repositoryPath = makeRepo('preview-no-worktree');
    const project = await projectsService.createProject({
      name: 'preview-no-worktree',
      repositoryPath,
      developmentCommand: SERVER_COMMAND,
    });
    const run = runsService.createRun({ projectId: project.id, request: 'preview this' });

    await expect(previewsService.startRunPreview(run.id)).rejects.toThrow(/worktree/);
    expect(previewsService.getRunPreview(run.id).status).toBe('not_started');
  });
});
