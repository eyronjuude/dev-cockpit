import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Integration test over a real SQLite database in a temporary directory.
 * The data directory is set before any module that opens the database is
 * imported, so the whole persistence path is exercised rather than mocked.
 */

let dataDir: string;
let runs: typeof import('@/services/runs');
let projectsService: typeof import('@/services/projects');
let closeDb: typeof import('@/db/client').closeDb;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-readiness-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  runs = await import('@/services/runs');
  projectsService = await import('@/services/projects');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

/** A repository is needed because createProject probes the path with git. */
function makeRepo(name: string): string {
  const repo = path.join(dataDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return repo;
}

async function makeProject(
  name: string,
  overrides: Partial<Parameters<typeof projectsService.createProject>[0]> = {},
) {
  return projectsService.createProject({
    name,
    repositoryPath: makeRepo(name),
    ...overrides,
  });
}

function seedValidation(
  runId: string,
  attempt: number,
  entries: {
    kind: import('@/domain/types').ValidationKind;
    outcome: import('@/domain/types').ValidationOutcome;
    blocking?: boolean;
    exitCode?: number | null;
  }[],
) {
  for (const entry of entries) {
    runs.upsertValidationResult({
      id: `val_${runId}_${attempt}_${entry.kind}`,
      runId,
      attempt,
      kind: entry.kind,
      command: entry.outcome === 'not_configured' ? null : `run ${entry.kind}`,
      workingDir: null,
      outcome: entry.outcome,
      blocking: entry.blocking ?? true,
      exitCode: entry.exitCode ?? (entry.outcome === 'pass' ? 0 : 1),
    });
  }
}

describe('persistence', () => {
  it('creates a project, applies migrations and reads it back', async () => {
    const project = await makeProject('persist-basic');
    expect(project.id).toMatch(/^prj_/);
    expect(project.validationCommands).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'cockpit.db'))).toBe(true);

    const reloaded = projectsService.getProject(project.id);
    expect(reloaded?.name).toBe('persist-basic');
    // The default branch is always protected, whatever the caller passed.
    expect(reloaded?.protectedBranches).toContain(reloaded?.defaultBranch);
  });

  it('records a validation command and clears it with an empty string', async () => {
    const project = await makeProject('persist-commands');
    projectsService.upsertValidationCommand(project.id, {
      kind: 'unit',
      command: 'npm test',
    });
    expect(projectsService.getProject(project.id)?.validationCommands).toHaveLength(1);

    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: '' });
    expect(projectsService.getProject(project.id)?.validationCommands).toHaveLength(0);
  });

  it('creates a run in DRAFT with the request stored verbatim', async () => {
    const project = await makeProject('persist-run');
    const request = 'Add a health endpoint.\nIt should return 200.';
    const run = runs.createRun({ projectId: project.id, request, profile: 'standard' });

    expect(run.status).toBe('DRAFT');
    expect(run.request).toBe(request);
    expect(run.title).toBe('Add a health endpoint.');
    expect(run.branch).toBe(`cockpit/${run.id}`);
    expect(run.spec).toBeNull();
  });

  it('records provider choices per run so a settings change cannot rewrite history', async () => {
    const project = await makeProject('persist-providers');
    const run = runs.createRun({
      projectId: project.id,
      request: 'x',
      profile: 'deep',
      transformer: 'claude-cli',
      reviewer: 'anthropic-api',
    });
    expect(runs.runProviders(run.id)).toEqual({
      transformer: 'claude-cli',
      reviewer: 'anthropic-api',
    });
  });

  it('rejects an illegal status transition at the write path', async () => {
    const project = await makeProject('persist-transition');
    const run = runs.createRun({ projectId: project.id, request: 'x' });
    expect(() => runs.setStatus(run.id, 'READY')).toThrow(/Illegal run transition/);
    expect(runs.requireRun(run.id).status).toBe('DRAFT');
  });

  it('appends an event for every status change', async () => {
    const events = await import('@/services/events');
    const project = await makeProject('persist-events');
    const run = runs.createRun({ projectId: project.id, request: 'x' });

    runs.setStatus(run.id, 'PREPARING');
    runs.setStatus(run.id, 'IMPLEMENTING');

    const log = events.listEvents(run.id);
    const types = log.map((e) => e.type);
    expect(types).toContain('run.created');
    expect(types.filter((t) => t === 'run.status_changed')).toHaveLength(2);
    // Sequence numbers must be monotonic: SSE catch-up depends on it.
    for (let i = 1; i < log.length; i += 1) {
      expect(log[i]!.seq).toBeGreaterThan(log[i - 1]!.seq);
    }
  });

  it('serves events after a cursor for SSE catch-up', async () => {
    const events = await import('@/services/events');
    const project = await makeProject('persist-cursor');
    const run = runs.createRun({ projectId: project.id, request: 'x' });
    const before = events.maxSeq(run.id);

    runs.setStatus(run.id, 'PREPARING');
    const after = events.listEvents(run.id, { afterSeq: before });

    expect(after.length).toBeGreaterThan(0);
    expect(after.every((e) => e.seq > before)).toBe(true);
  });

  it('tracks iterations with increasing ordinals and records resume', async () => {
    const project = await makeProject('persist-iterations');
    const run = runs.createRun({ projectId: project.id, request: 'x' });

    const first = runs.createIteration({
      runId: run.id,
      kind: 'initial',
      prompt: 'do the thing',
      sessionId: null,
      resumed: false,
    });
    const second = runs.createIteration({
      runId: run.id,
      kind: 'change_request',
      prompt: 'fix the thing',
      sessionId: 'session-abc',
      resumed: true,
    });

    expect(first.ordinal).toBe(1);
    expect(second.ordinal).toBe(2);
    expect(second.resumed).toBe(true);
    expect(runs.latestIteration(run.id)?.id).toBe(second.id);
  });
});

describe('assessReadiness', () => {
  it('is not ready when nothing changed', async () => {
    const project = await makeProject('ready-nochange');
    const run = runs.createRun({ projectId: project.id, request: 'x' });
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'pass' }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), project);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('No files changed');
  });

  it('is ready when the only configured check passes and files changed', async () => {
    const project = await makeProject('ready-pass');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      {
        path: 'src/app.ts',
        previousPath: null,
        changeType: 'modified',
        additions: 4,
        deletions: 1,
        binary: false,
      },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'pass' }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.ready).toBe(true);
    expect(assessment.validationsPassed).toBe(1);
  });

  it('blocks on a failing check and says which one', async () => {
    const project = await makeProject('ready-fail');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'fail', exitCode: 1 }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(false);
    expect(assessment.validationsFailed).toBe(1);
    expect(assessment.reasons.some((r) => r.includes('unit failed'))).toBe(true);
  });

  it('treats a command that could not start as an error, not a test failure', async () => {
    const project = await makeProject('ready-error');
    projectsService.upsertValidationCommand(project.id, { kind: 'build', command: 'nope' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'build', outcome: 'error' }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons.some((r) => r.includes('build could not run'))).toBe(true);
  });

  it('does not block on a non-blocking check that failed', async () => {
    const project = await makeProject('ready-advisory');
    projectsService.upsertValidationCommand(project.id, {
      kind: 'e2e',
      command: 'npx playwright test',
      blocking: false,
    });
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [
      { kind: 'unit', outcome: 'pass' },
      { kind: 'e2e', outcome: 'fail', blocking: false },
    ]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(true);
  });

  it('does not treat an unconfigured check as a failure', async () => {
    const project = await makeProject('ready-notconfigured');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [
      { kind: 'unit', outcome: 'pass' },
      { kind: 'e2e', outcome: 'not_configured' },
      { kind: 'build', outcome: 'not_configured' },
    ]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(true);
    expect(assessment.validationsFailed).toBe(0);
  });

  it('blocks while a check is still running', async () => {
    const project = await makeProject('ready-running');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'running' }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('unit is still running');
  });

  it('requires validation to have run when the project demands it', async () => {
    const project = await makeProject('ready-requires');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);
    expect(withCommand.requireValidation).toBe(true);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    // No validation rows at all.

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('Validation has not run yet');
  });

  it('says so when a project requires validation but configured none', async () => {
    const project = await makeProject('ready-nocommands');
    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), project);
    expect(assessment.ready).toBe(false);
    expect(
      assessment.reasons.some((r) => r.includes('no validation commands configured')),
    ).toBe(true);
  });

  it('requires E2E for a UI change when the policy is on', async () => {
    const project = await makeProject('ready-e2e-policy', {
      requireE2eForUiChanges: true,
      uiPathPatterns: ['.tsx'],
    });
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      {
        path: 'src/components/Button.tsx',
        previousPath: null,
        changeType: 'modified',
        additions: 3,
        deletions: 0,
        binary: false,
      },
    ]);
    seedValidation(run.id, 1, [
      { kind: 'unit', outcome: 'pass' },
      { kind: 'e2e', outcome: 'not_configured' },
    ]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons.some((r) => r.includes('requires an E2E check'))).toBe(true);
  });

  it('does not require E2E when no UI file was touched', async () => {
    const project = await makeProject('ready-e2e-nonui', {
      requireE2eForUiChanges: true,
      uiPathPatterns: ['.tsx'],
    });
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      {
        path: 'src/lib/math.ts',
        previousPath: null,
        changeType: 'modified',
        additions: 3,
        deletions: 0,
        binary: false,
      },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'pass' }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(true);
  });

  it('uses only the latest validation attempt', async () => {
    const project = await makeProject('ready-latest-attempt');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'fail' }]);
    seedValidation(run.id, 2, [{ kind: 'unit', outcome: 'pass' }]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(true);
    expect(runs.nextValidationAttempt(run.id)).toBe(3);
  });

  it('does not block on review findings by default', async () => {
    const project = await makeProject('ready-findings-advisory');
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);
    expect(withCommand.reviewBlocksReady).toBe(false);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'pass' }]);
    runs.insertFindings(run.id, 1, 'claude-cli', [
      {
        severity: 'critical',
        title: 'Possible injection',
        detail: null,
        file: 'a.ts',
        line: 3,
        suggestion: null,
      },
    ]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    // A reviewer opinion is not a test result: by default it informs, not blocks.
    expect(assessment.ready).toBe(true);
    expect(assessment.blockingFindings).toBe(1);
  });

  it('blocks on a high-severity finding when the project opts in', async () => {
    const project = await makeProject('ready-findings-blocking', { reviewBlocksReady: true });
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'pass' }]);
    runs.insertFindings(run.id, 1, 'claude-cli', [
      { severity: 'high', title: 'Leaks a token', detail: null, file: 'a.ts', line: 1, suggestion: null },
    ]);

    const assessment = runs.assessReadiness(runs.requireRun(run.id), withCommand);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons.some((r) => r.includes('blocking review finding'))).toBe(true);
  });

  it('does not block on a low-severity finding even when review is blocking', async () => {
    const project = await makeProject('ready-findings-low', { reviewBlocksReady: true });
    projectsService.upsertValidationCommand(project.id, { kind: 'unit', command: 'npm test' });
    const withCommand = projectsService.requireProject(project.id);

    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);
    seedValidation(run.id, 1, [{ kind: 'unit', outcome: 'pass' }]);
    runs.insertFindings(run.id, 1, 'claude-cli', [
      { severity: 'low', title: 'Naming nit', detail: null, file: 'a.ts', line: 1, suggestion: null },
    ]);

    expect(runs.assessReadiness(runs.requireRun(run.id), withCommand).ready).toBe(true);
  });
});

describe('reconcileInterruptedRuns', () => {
  it('fails a run that was mid-flight when the process stopped', async () => {
    const project = await makeProject('reconcile');
    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.setStatus(run.id, 'PREPARING');
    runs.setStatus(run.id, 'IMPLEMENTING');
    const iteration = runs.createIteration({
      runId: run.id,
      kind: 'initial',
      prompt: 'p',
      sessionId: null,
      resumed: false,
    });

    const count = runs.reconcileInterruptedRuns();
    expect(count).toBeGreaterThanOrEqual(1);

    const after = runs.requireRun(run.id);
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('restarted');
    // The session and worktree are still recorded, so the run stays continuable.
    expect(after.iterations.find((i) => i.id === iteration.id)?.status).toBe('failed');
  });

  it('leaves a finished run alone', async () => {
    const project = await makeProject('reconcile-finished');
    const run = runs.createRun({ projectId: project.id, request: 'x' });
    runs.setStatus(run.id, 'PREPARING');
    runs.setStatus(run.id, 'IMPLEMENTING');
    runs.setStatus(run.id, 'VALIDATING');
    runs.setStatus(run.id, 'READY');

    runs.reconcileInterruptedRuns();
    expect(runs.requireRun(run.id).status).toBe('READY');
  });
});
