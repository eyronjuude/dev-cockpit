import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The landing queue read model.
 *
 * The orchestrator already serialises landings correctly — that is covered in
 * `landing-assistance.test.ts`. What is asserted here is that the view built on
 * top reports the same order the orchestrator will actually run, and that a run
 * owed a landing nobody has asked for yet still shows up.
 */

let dataDir: string;
let worktree: typeof import('@/git/worktree');
let diff: typeof import('@/git/diff');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let landingQueue: typeof import('@/services/landing-queue');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let closeDb: typeof import('@/db/client').closeDb;

const author = { name: 'Test', email: 'test@example.com' };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-landing-queue-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  worktree = await import('@/git/worktree');
  diff = await import('@/git/diff');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  landingQueue = await import('@/services/landing-queue');
  orchestrator = await import('@/orchestrator/orchestrator');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  closeDb?.();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold a git worktree handle after the test process exits.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

function makeRepo(name: string): string {
  const repo = path.join(dataDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', author.email], repo);
  git(['config', 'user.name', author.name], repo);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'initial commit'], repo);
  return repo;
}

type Project = Awaited<ReturnType<typeof projectsService.createProject>>;

async function makeApprovedRun(
  project: Project,
  filePath: string,
  fileText: string,
  baseBranch = 'main',
) {
  const run = runsService.createRun({
    projectId: project.id,
    request: `Change ${filePath}`,
  });
  const runPath = path.join(dataDir, 'worktrees', project.id, run.id);
  const prepared = await worktree.prepareWorktree({
    repositoryPath: project.repositoryPath,
    worktreePath: runPath,
    branch: run.branch ?? `cockpit/${run.id}`,
    baseRef: baseBranch,
    protectedBranches: project.protectedBranches,
  });

  const target = path.join(runPath, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fileText);
  const commitSha = await diff.commitAll(runPath, `feat: edit ${filePath}`, author);
  const changed = await diff.collectRunDiff(runPath, prepared.baseCommit);

  runsService.updateRunFields(run.id, {
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    baseBranch,
    commitSha,
  });
  runsService.replaceChangedFiles(run.id, changed.files);
  runsService.setStatus(run.id, 'PREPARING', { started: true });
  runsService.setStatus(run.id, 'IMPLEMENTING');
  runsService.setStatus(run.id, 'VALIDATING');
  runsService.setStatus(run.id, 'READY', { finished: true });
  await orchestrator.approveRun(run.id, { createCommit: false });

  return runsService.requireRun(run.id);
}

async function waitForIdle(runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (orchestrator.isRunActive(runId)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Flattens the grouped view, which is what most assertions care about. */
function entriesOf(view: ReturnType<typeof landingQueue.projectLandingQueue>) {
  return view.branches.flatMap((branch) => branch.entries);
}

describe('landing queue view', () => {
  it('lists an approved run nobody has asked to land yet', async () => {
    const repo = makeRepo('queue-pending');
    const project = await projectsService.createProject({
      name: 'queue-pending',
      repositoryPath: repo,
    });
    const run = await makeApprovedRun(project, 'pending.txt', 'pending\n');

    const view = landingQueue.projectLandingQueue(project);

    expect(view.liveCount).toBe(0);
    expect(view.pendingCount).toBe(1);
    expect(view.branches).toHaveLength(1);
    expect(view.branches[0]!.targetBranch).toBe('main');

    const entry = view.branches[0]!.entries[0]!;
    expect(entry.id).toBe(run.id);
    expect(entry.state).toBe('pending');
    expect(entry.position).toBeNull();
    expect(entry.status).toBe('APPROVED');
    expect(entry.stopped).toBe(false);
  });

  it('reports the landing run first and the queued one behind it', async () => {
    const repo = makeRepo('queue-order');
    const project = await projectsService.createProject({
      name: 'queue-order',
      repositoryPath: repo,
    });
    const first = await makeApprovedRun(project, 'first.txt', 'first\n');
    const second = await makeApprovedRun(project, 'second.txt', 'second\n');

    orchestrator.landRun(first.id);
    orchestrator.landRun(second.id);

    const view = landingQueue.projectLandingQueue(project);
    expect(view.liveCount).toBe(2);
    expect(view.pendingCount).toBe(0);
    expect(view.branches).toHaveLength(1);

    const [landingEntry, waitingEntry] = view.branches[0]!.entries;
    expect(landingEntry!.id).toBe(first.id);
    expect(landingEntry!.state).toBe('landing');
    expect(landingEntry!.position).toBe(0);
    expect(landingEntry!.mode).toBe('land');

    expect(waitingEntry!.id).toBe(second.id);
    expect(waitingEntry!.state).toBe('waiting');
    expect(waitingEntry!.position).toBe(1);

    await waitForIdle(first.id);
    await waitForIdle(second.id);

    // Both landed, so neither is owed a landing any more.
    const after = landingQueue.projectLandingQueue(project);
    expect(after.liveCount).toBe(0);
    expect(after.pendingCount).toBe(0);
    expect(after.branches).toHaveLength(0);
  });

  it('returns a cancelled queued landing to the pending backlog', async () => {
    const repo = makeRepo('queue-cancel');
    const project = await projectsService.createProject({
      name: 'queue-cancel',
      repositoryPath: repo,
    });
    const first = await makeApprovedRun(project, 'first.txt', 'first\n');
    const second = await makeApprovedRun(project, 'second.txt', 'second\n');

    orchestrator.landRun(first.id);
    orchestrator.landRun(second.id);
    expect(orchestrator.cancelRun(second.id)).toBe(true);

    const view = landingQueue.projectLandingQueue(project);
    const queued = entriesOf(view).find((entry) => entry.id === second.id);
    expect(queued?.state).toBe('pending');
    expect(queued?.position).toBeNull();
    expect(queued?.status).toBe('APPROVED');
    expect(view.liveCount).toBe(1);
    expect(view.pendingCount).toBe(1);

    await waitForIdle(first.id);
  });

  it('groups runs by the branch they land on, not by the project default', async () => {
    const repo = makeRepo('queue-branches');
    git(['branch', 'release'], repo);
    const project = await projectsService.createProject({
      name: 'queue-branches',
      repositoryPath: repo,
    });

    const onMain = await makeApprovedRun(project, 'main.txt', 'main\n');
    const onRelease = await makeApprovedRun(project, 'release.txt', 'release\n', 'release');

    const view = landingQueue.projectLandingQueue(project);
    expect(view.pendingCount).toBe(2);
    expect(view.branches.map((branch) => branch.targetBranch)).toEqual(['main', 'release']);
    expect(view.branches[0]!.entries.map((entry) => entry.id)).toEqual([onMain.id]);
    expect(view.branches[1]!.entries.map((entry) => entry.id)).toEqual([onRelease.id]);

    // Different targets do not contend, so both land at once rather than one
    // waiting on the other.
    orchestrator.landRun(onMain.id);
    orchestrator.landRun(onRelease.id);

    const live = landingQueue.projectLandingQueue(project);
    expect(entriesOf(live).map((entry) => entry.state)).toEqual(['landing', 'landing']);

    await waitForIdle(onMain.id);
    await waitForIdle(onRelease.id);
  });

  it('counts each project separately for the project list', async () => {
    const withBacklog = await projectsService.createProject({
      name: 'queue-counts-a',
      repositoryPath: makeRepo('queue-counts-a'),
    });
    const empty = await projectsService.createProject({
      name: 'queue-counts-b',
      repositoryPath: makeRepo('queue-counts-b'),
    });
    await makeApprovedRun(withBacklog, 'a.txt', 'a\n');

    const counts = landingQueue.landingQueueCounts([withBacklog, empty]);
    expect(counts.get(withBacklog.id)).toEqual({ live: 0, pending: 1, total: 1 });
    expect(counts.get(empty.id)).toEqual({ live: 0, pending: 0, total: 0 });
  });
});
