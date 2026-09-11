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
  preview?: Parameters<typeof projectsService.createProject>[0]['preview'],
): Promise<ReturnType<typeof runsService.createRun>> {
  const repositoryPath = makeRepo(name);
  const project = await projectsService.createProject({
    name,
    repositoryPath,
    developmentCommand,
    preview,
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

describe('preview configuration', () => {
  it('gives up waiting and says why, rather than showing `starting` forever', async () => {
    // V1 polled indefinitely, so a server that never bound left the preview on
    // `starting` with no exit but stopping it and nothing saying what happened.
    const run = await runWithWorktree(
      'preview-never-binds',
      // Occupies the process without ever listening.
      'node -e "setTimeout(()=>{}, 60000)"',
      { readyTimeoutMs: 2_000 },
    );

    await previewsService.startRunPreview(run.id);

    const deadline = Date.now() + 15_000;
    let preview = previewsService.getRunPreview(run.id);
    while (Date.now() < deadline && preview.status === 'starting') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      preview = previewsService.getRunPreview(run.id);
    }

    expect(preview.status).not.toBe('starting');
    expect(preview.error).toMatch(/did not answer/);
    await previewsService.stopRunPreview(run.id, 'test cleanup').catch(() => false);
  }, 30_000);

  it('probes the configured ready path rather than the root', async () => {
    // A server that 404s everything except /healthz. If the probe used `/` it
    // would still see a response and call it ready, which is why this asserts
    // on the recorded probe URL as well as the outcome.
    const command =
      'node -e "const http=require(\'http\');http.createServer((req,res)=>{if(req.url===\'/healthz\'){res.end(\'ok\')}else{res.statusCode=404;res.end()}}).listen(Number(process.env.PORT),\'127.0.0.1\')"';

    const run = await runWithWorktree('preview-ready-path', command, {
      readyPath: '/healthz',
      readyTimeoutMs: 10_000,
    });

    await previewsService.startRunPreview(run.id);
    const ready = await waitForReady(run.id);

    expect(ready.readyUrl).toMatch(/\/healthz$/);
    expect(ready.url).not.toMatch(/healthz/);
    await previewsService.stopRunPreview(run.id, 'test cleanup');
  }, 30_000);

  it('passes configured environment through and keeps a secret out of the log', async () => {
    const secret = 'preview-secret-value-98765';
    const command =
      'node -e "const http=require(\'http\');console.log(\'token=\'+process.env.MY_TOKEN);http.createServer((req,res)=>res.end(\'ok\')).listen(Number(process.env.PORT),\'127.0.0.1\')"';

    const run = await runWithWorktree('preview-env', command, {
      env: [`MY_TOKEN=${secret}`],
      readyTimeoutMs: 10_000,
    });

    await previewsService.startRunPreview(run.id);
    const ready = await waitForReady(run.id);

    const log = artifactsService
      .listArtifacts(run.id)
      .find((artifact) => artifact.id === ready.logArtifactId);
    const content = await artifactsService.readArtifactText(log!.id);
    // The value reached the process, and did not reach the stored log.
    expect(content?.text).toContain('token=');
    expect(content?.text).not.toContain(secret);

    await previewsService.stopRunPreview(run.id, 'test cleanup');
  }, 30_000);

  it('restarts with a new process and a new generation', async () => {
    const run = await runWithWorktree('preview-restart', SERVER_COMMAND, {
      readyTimeoutMs: 10_000,
    });

    await previewsService.startRunPreview(run.id);
    const first = await waitForReady(run.id);

    const restarted = await previewsService.restartRunPreview(run.id);
    expect(restarted.running).toBe(true);
    // The generation is what the Preview tab keys its iframe on, so a restart
    // that did not bump it would leave the dead server's last paint on screen.
    expect(restarted.generation).toBeGreaterThan(first.generation);
    expect(restarted.pid).not.toBe(first.pid);

    await waitForReady(run.id);
    await previewsService.stopRunPreview(run.id, 'test cleanup');
  }, 40_000);

  it('refuses a working directory that escapes the worktree', async () => {
    const run = await runWithWorktree('preview-escape', SERVER_COMMAND, {
      workingDir: '../../../',
    });
    await expect(previewsService.startRunPreview(run.id)).rejects.toThrow(/escapes the worktree/);
  });

  it('reports a fixed port that is already taken instead of moving quietly', async () => {
    const net = await import('node:net');
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as { port: number }).port;

    try {
      const run = await runWithWorktree('preview-port-taken', SERVER_COMMAND, {
        portStrategy: 'fixed',
        fixedPort: taken,
      });
      await expect(previewsService.startRunPreview(run.id)).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('uses the fixed port when it is free', async () => {
    const net = await import('node:net');
    const finder = net.createServer();
    await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
    const port = (finder.address() as { port: number }).port;
    await new Promise<void>((resolve) => finder.close(() => resolve()));

    const run = await runWithWorktree('preview-port-fixed', SERVER_COMMAND, {
      portStrategy: 'fixed',
      fixedPort: port,
      readyTimeoutMs: 10_000,
    });

    const started = await previewsService.startRunPreview(run.id);
    expect(started.port).toBe(port);
    await waitForReady(run.id);
    await previewsService.stopRunPreview(run.id, 'test cleanup');
  }, 30_000);
});
