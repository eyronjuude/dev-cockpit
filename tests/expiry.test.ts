import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_WORKTREE_RETENTION_DAYS,
  dueAt,
  expiredTargets,
  isExpirable,
  planExpiry,
  retentionStart,
  RETENTION_OFF,
  type RetentionPolicy,
} from '@/domain/expiry';
import { RUN_STATUSES, type RunStatus } from '@/domain/types';

/**
 * Run expiry: the policy, then the sweep that acts on it.
 *
 * The policy half is pure, so it is tested by stating dates rather than
 * arranging them. The sweep half runs against a real repository and real
 * worktrees, because the three things that could go wrong are all about the
 * filesystem: it must reclaim a spent checkout, it must refuse one holding
 * uncommitted work even though the window has passed, and it must not touch
 * the two things a run cannot get back — its history and the developer's own
 * attached files.
 */

/* ------------------------------------------------------------------ *
 * The policy
 * ------------------------------------------------------------------ */

const FINISHED_AT = '2026-01-01T00:00:00.000Z';

const run = (overrides: Partial<Parameters<typeof planExpiry>[0]> = {}) => ({
  status: 'LANDED' as RunStatus,
  finishedAt: FINISHED_AT,
  updatedAt: FINISHED_AT,
  createdAt: '2025-12-31T00:00:00.000Z',
  ...overrides,
});

const policy = (worktrees: number, artifacts: number): RetentionPolicy => ({
  worktreeRetentionDays: worktrees,
  artifactRetentionDays: artifacts,
});

/** Days after the fixture's finish time. */
const at = (days: number) => new Date(Date.parse(FINISHED_AT) + days * 86_400_000);

describe('retention policy', () => {
  it('expires each target once its own window has elapsed', () => {
    const p = policy(7, 30);

    expect(expiredTargets(planExpiry(run(), p, at(6.9)))).toEqual([]);
    expect(expiredTargets(planExpiry(run(), p, at(7)))).toEqual(['worktrees']);
    expect(expiredTargets(planExpiry(run(), p, at(29)))).toEqual(['worktrees']);
    expect(expiredTargets(planExpiry(run(), p, at(30)))).toEqual(['worktrees', 'artifacts']);
  });

  it('reports when each target is due, before it is', () => {
    const plan = planExpiry(run(), policy(7, 30), at(1));

    expect(dueAt(plan, 'worktrees')).toBe('2026-01-08T00:00:00.000Z');
    expect(dueAt(plan, 'artifacts')).toBe('2026-01-31T00:00:00.000Z');
    expect(plan.reason).toContain('2026-01-08T00:00:00.000Z');
  });

  it('treats a zero window as keeping that target forever', () => {
    const plan = planExpiry(run(), policy(RETENTION_OFF, 30), at(10_000));

    expect(expiredTargets(plan)).toEqual(['artifacts']);
    expect(dueAt(plan, 'worktrees')).toBeNull();
  });

  it('never expires a run that is not over, however old', () => {
    const unfinished: RunStatus[] = [
      'DRAFT',
      'PREPARING',
      'IMPLEMENTING',
      'PAUSED',
      'VALIDATING',
      'REVIEWING',
      'NEEDS_CHANGES',
      'READY',
      'APPROVED',
      'LANDING',
      'MERGE_CONFLICT',
      'LANDING_FAILED',
    ];

    for (const status of unfinished) {
      const plan = planExpiry(run({ status }), policy(1, 1), at(10_000));
      expect(expiredTargets(plan), status).toEqual([]);
      expect(plan.eligibleFrom, status).toBeNull();
      expect(plan.reason, status).toContain(status);
    }
  });

  it('expires every finished status, including the reworkable ones', () => {
    // FAILED and CANCELLED can be picked back up, which is why they get a
    // window rather than the immediate cleanup LANDED and REJECTED get.
    for (const status of RUN_STATUSES.filter(isExpirable)) {
      expect(expiredTargets(planExpiry(run({ status }), policy(7, 30), at(31))), status).toEqual([
        'worktrees',
        'artifacts',
      ]);
    }
    expect(RUN_STATUSES.filter(isExpirable)).toEqual([
      'LANDED',
      'REJECTED',
      'FAILED',
      'CANCELLED',
    ]);
  });

  it('starts the clock at finishedAt, falling back rather than never expiring', () => {
    expect(retentionStart(run())).toBe(FINISHED_AT);
    expect(retentionStart(run({ finishedAt: null }))).toBe(FINISHED_AT);
    expect(
      retentionStart(run({ finishedAt: null, updatedAt: null as unknown as string })),
    ).toBe('2025-12-31T00:00:00.000Z');
  });

  it('refuses to read a negative window as an immediate expiry', () => {
    const plan = planExpiry(run(), policy(-5, 30), at(1));
    expect(expiredTargets(plan)).toEqual([]);
    expect(plan.targets.find((t) => t.target === 'worktrees')?.retentionDays).toBe(RETENTION_OFF);
  });

  it('defaults worktrees to a shorter window than artifacts', () => {
    // The whole reason there are two: a checkout costs orders of magnitude
    // more disk than the logs describing it.
    expect(DEFAULT_WORKTREE_RETENTION_DAYS).toBeLessThan(DEFAULT_ARTIFACT_RETENTION_DAYS);
  });
});

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

let dataDir: string;
let repoDir: string;

let worktree: typeof import('@/git/worktree');
let gitMod: typeof import('@/git/git');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let artifactsService: typeof import('@/services/artifacts');
let attachmentsService: typeof import('@/services/attachments');
let expiryService: typeof import('@/services/expiry');
let paths: typeof import('@/core/paths');
let ids: typeof import('@/core/ids');
let closeDb: typeof import('@/db/client').closeDb;

let projectId: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** Walks a fresh run to a finished status through the real transition table. */
function runAt(status: RunStatus, title: string): string {
  const created = runsService.createRun({
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
    runsService.setStatus(created.id, step);
  }
  return created.id;
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
  runsService.updateRunFields(runId, { worktreePath: wtPath });
  return wtPath;
}

async function attachArtifact(runId: string, fileName = 'output.log'): Promise<string> {
  const artifact = await artifactsService.writeTextArtifact({
    runId,
    kind: 'stdout_log',
    fileName,
    content: 'a'.repeat(2_048),
  });
  return artifact.filePath;
}

/** The run's only artifact, asserted to exist so the test reads as one claim. */
function soleArtifact(runId: string) {
  const found = artifactsService.listArtifacts(runId);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The most recently created run in the fixture project. */
function newestRunId(): string {
  const found = runsService.listRuns({ projectId });
  expect(found.length).toBeGreaterThan(0);
  return found[0]!.id;
}

/** Far enough past every default window that both targets are released. */
const LONG_AFTER = new Date(Date.now() + 400 * 86_400_000);

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-expiry-'));
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
  gitMod = await import('@/git/git');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
  artifactsService = await import('@/services/artifacts');
  attachmentsService = await import('@/services/attachments');
  expiryService = await import('@/services/expiry');
  paths = await import('@/core/paths');
  ids = await import('@/core/ids');
  ({ closeDb } = await import('@/db/client'));

  const project = await projectsService.createProject({
    name: 'Expiry fixture',
    repositoryPath: repoDir,
    // Off, so the sweep is the only thing reclaiming anything in here.
    cleanUpWorktreeOnFinish: false,
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

describe('retention defaults', () => {
  it('gives a new project both default windows', () => {
    const project = projectsService.requireProject(projectId);
    expect(project.worktreeRetentionDays).toBe(DEFAULT_WORKTREE_RETENTION_DAYS);
    expect(project.artifactRetentionDays).toBe(DEFAULT_ARTIFACT_RETENTION_DAYS);
    expect(expiryService.retentionEnabled(projectsService.retentionPolicy(project))).toBe(true);
  });
});

describe('sweeping an expired run', () => {
  it('reclaims the worktree and expires the artifacts, keeping the record', async () => {
    const runId = runAt('LANDED', 'expired run');
    const wtPath = await attachWorktree(runId);
    const artifactPath = await attachArtifact(runId);

    // Committed, and merged, so nothing here is unfinished work.
    fs.writeFileSync(path.join(wtPath, 'shipped.ts'), 'export const shipped = true;\n');
    git(['add', '-A'], wtPath);
    git(['commit', '-qm', 'shipped'], wtPath);
    git(['merge', '--no-ff', '--no-edit', '-q', ids.runBranchName(runId)]);

    const report = await expiryService.sweepExpiredRuns({ now: LONG_AFTER });

    expect(report.dryRun).toBe(false);
    expect(report.affected).toBe(1);
    expect(report.worktreesRemoved).toBe(1);
    expect(report.worktreesKept).toBe(0);
    expect(report.artifactsExpired).toBe(1);
    expect(report.bytesReclaimed).toBe(2_048);
    expect(report.errors).toEqual([]);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(runsService.requireRun(runId).worktreePath).toBeNull();

    // The run itself is intact: the artifact row survives and says why it is
    // empty, and the branch is gone only because its commits reached main.
    const artifact = soleArtifact(runId);
    expect(artifact.expiredAt).not.toBeNull();
    expect(artifact.exists).toBe(false);
    expect(artifact.bytes).toBe(2_048);
    expect(await gitMod.refExists(repoDir, `refs/heads/${ids.runBranchName(runId)}`)).toBe(false);
  });

  it('records what it reclaimed against the run', async () => {
    // The run just swept is the newest, so it is first in the list.
    const events = eventsService
      .listEvents(newestRunId())
      .filter((e) => e.type === 'run.expired');

    expect(events).toHaveLength(1);
    const [event] = events as [(typeof events)[number]];
    expect(event.message).toMatch(/reclaimed/);

    const payload = event.payload as {
      targets: string[];
      artifactsExpired: number | null;
      dryRun: boolean;
      retentionDays: Record<string, number>;
    };
    expect(payload.targets).toEqual(['worktrees', 'artifacts']);
    expect(payload.artifactsExpired).toBe(1);
    expect(payload.dryRun).toBe(false);
    expect(payload.retentionDays.worktrees).toBe(DEFAULT_WORKTREE_RETENTION_DAYS);
  });

  it('says nothing on a second pass over the same run', async () => {
    const runId = newestRunId();
    const before = eventsService.listEvents(runId).length;

    const report = await expiryService.sweepExpiredRuns({ now: LONG_AFTER });

    expect(report.affected).toBe(0);
    expect(eventsService.listEvents(runId)).toHaveLength(before);
  });
});

describe('what expiry refuses to do', () => {
  it('keeps a worktree holding uncommitted work, however overdue', async () => {
    const runId = runAt('FAILED', 'unfinished work');
    const wtPath = await attachWorktree(runId);
    fs.writeFileSync(path.join(wtPath, 'draft.ts'), 'export const draft = true;\n');

    const report = await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });

    expect(report.worktreesRemoved).toBe(0);
    expect(report.worktreesKept).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, 'draft.ts'))).toBe(true);

    const outcome = report.runs.find((r) => r.runId === runId);
    expect(outcome?.worktrees?.targets.find((t) => t.kind === 'run')?.reason).toMatch(
      /uncommitted/,
    );

    // A refusal is worth noticing rather than filing silently under "done".
    const event = eventsService
      .listEvents(runId)
      .filter((e) => e.type === 'run.expired')
      .at(-1);
    expect(event?.level).toBe('notice');
    expect(event?.message).toMatch(/kept/);
  });

  it('records a refused worktree once rather than every sweep', async () => {
    const runId = runAt('FAILED', 'permanently dirty');
    const wtPath = await attachWorktree(runId);
    fs.writeFileSync(path.join(wtPath, 'draft.ts'), 'export const draft = true;\n');

    const expiredEvents = () =>
      eventsService.listEvents(runId).filter((e) => e.type === 'run.expired');

    await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });
    expect(expiredEvents()).toHaveLength(1);

    // The sweep runs every six hours. Being told the same refusal forty times
    // a week would bury everything else in the log.
    await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });
    await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });
    expect(expiredEvents()).toHaveLength(1);

    // It keeps trying, though: once the work is committed and merged, the next
    // sweep reclaims the directory and says so.
    git(['add', '-A'], wtPath);
    git(['commit', '-qm', 'saved the draft'], wtPath);
    git(['merge', '--no-ff', '--no-edit', '-q', ids.runBranchName(runId)]);

    const report = await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });

    expect(report.worktreesRemoved).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(expiredEvents()).toHaveLength(2);
  });

  it('leaves a run that is not over alone', async () => {
    const runId = runAt('READY', 'still waiting on the user');
    const wtPath = await attachWorktree(runId);
    await attachArtifact(runId);

    const report = await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });

    expect(report.runs.some((r) => r.runId === runId)).toBe(false);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(soleArtifact(runId).expiredAt).toBeNull();
  });

  it('leaves the developer’s attached files alone', async () => {
    const runId = runAt('READY', 'run with an attachment');
    const attachment = await attachmentsService.addAttachment({
      runId,
      fileName: 'server.log',
      data: new TextEncoder().encode('the log the developer handed over'),
    });
    await attachArtifact(runId);
    runsService.setStatus(runId, 'REJECTED');

    await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });

    // The artifact went; the input did not. Retention is about evidence a run
    // produced, and the app holds the only copy of an attachment.
    expect(soleArtifact(runId).expiredAt).not.toBeNull();
    expect(fs.existsSync(attachment.filePath)).toBe(true);
    expect(attachmentsService.listAttachments(runId)).toHaveLength(1);
  });

  it('skips a run the orchestrator is still working on', async () => {
    const runId = runAt('FAILED', 'process still winding down');
    const wtPath = await attachWorktree(runId);

    const report = await expiryService.sweepExpiredRuns({
      now: LONG_AFTER,
      projectId,
      isBusy: (id) => id === runId,
    });

    const outcome = report.runs.find((r) => r.runId === runId);
    expect(outcome?.skipped).toMatch(/still working/);
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it('honours a project that has turned retention off', async () => {
    projectsService.updateProject(projectId, {
      worktreeRetentionDays: 0,
      artifactRetentionDays: 0,
    });

    const runId = runAt('LANDED', 'kept forever');
    const wtPath = await attachWorktree(runId);
    await attachArtifact(runId);

    const report = await expiryService.sweepExpiredRuns({ now: LONG_AFTER, projectId });

    expect(report.affected).toBe(0);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(soleArtifact(runId).expiredAt).toBeNull();

    projectsService.updateProject(projectId, {
      worktreeRetentionDays: DEFAULT_WORKTREE_RETENTION_DAYS,
      artifactRetentionDays: DEFAULT_ARTIFACT_RETENTION_DAYS,
    });
  });
});

describe('previewing a sweep', () => {
  it('reports what would go and changes nothing', async () => {
    const runId = runAt('REJECTED', 'preview me');
    const wtPath = await attachWorktree(runId);
    const artifactPath = await attachArtifact(runId);

    const report = await expiryService.sweepExpiredRuns({
      now: LONG_AFTER,
      projectId,
      dryRun: true,
    });

    const outcome = report.runs.find((r) => r.runId === runId);
    expect(report.dryRun).toBe(true);
    expect(outcome?.worktreesOnDisk).toBe(1);
    expect(outcome?.bytesReclaimed).toBe(2_048);
    expect(outcome?.skipped).toMatch(/preview/);

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(soleArtifact(runId).expiredAt).toBeNull();
    expect(
      eventsService.listEvents(runId).filter((e) => e.type === 'run.expired'),
    ).toHaveLength(0);
  });
});
