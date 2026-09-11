import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The pipeline, end to end, with real child processes.
 *
 * `validation-steps.test.ts` covers the rules in isolation. This covers what
 * the engine does with them: the order steps actually run in, what a skipped
 * step records, whether a retry really re-runs the command, and whether a
 * secret in a step's environment survives into a stored artifact.
 */

let dataDir: string;
let repoCounter = 0;

let worktree: typeof import('@/git/worktree');
let engine: typeof import('@/validation/engine');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let artifactsService: typeof import('@/services/artifacts');
let redact: typeof import('@/core/redact');
let closeDb: typeof import('@/db/client').closeDb;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-pipe-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  worktree = await import('@/git/worktree');
  engine = await import('@/validation/engine');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  artifactsService = await import('@/services/artifacts');
  redact = await import('@/core/redact');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  redact?.clearExtraSecrets();
  closeDb?.();
  delete process.env.DEV_COCKPIT_DATA_DIR;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeRepo(): string {
  repoCounter += 1;
  const dir = path.join(dataDir, `repo-${repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  return dir;
}

/** A project with a prepared worktree, ready to validate. */
async function prepared(
  name: string,
  steps: Parameters<typeof projectsService.createProject>[0]['validationSteps'],
) {
  const project = await projectsService.createProject({
    name,
    repositoryPath: makeRepo(),
    validationSteps: steps,
  });
  // Explicitly build: the project-wide default is plan, and a plan run's
  // readiness never looks at validation results.
  const run = runsService.createRun({ projectId: project.id, request: 'x', mode: 'build' });
  const worktreePath = path.join(dataDir, 'worktrees', project.id, run.id);
  await worktree.prepareWorktree({
    repositoryPath: project.repositoryPath,
    worktreePath,
    branch: `cockpit/${run.id}`,
    baseRef: project.defaultBranch,
    protectedBranches: [project.defaultBranch],
  });
  return { project: projectsService.requireProject(project.id), run, worktreePath };
}

/** Writes a marker file, so execution order is observable after the fact. */
const marker = (name: string) =>
  `node -e "require('fs').appendFileSync('order.txt','${name}\\n')"`;

describe('order', () => {
  it('runs steps in configured position, not the order of the six kinds', async () => {
    const { project, run, worktreePath } = await prepared('order', [
      { key: 'third', label: 'Third', kind: 'typecheck', command: marker('third'), position: 30 },
      { key: 'first', label: 'First', kind: 'build', command: marker('first'), position: 10 },
      { key: 'second', label: 'Second', kind: 'lint', command: marker('second'), position: 20 },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const order = fs.readFileSync(path.join(worktreePath, 'order.txt'), 'utf8');
    // `build` sorts last among the kinds and first here, which is the whole
    // point: position decides, not the kind.
    expect(order.trim().split(/\r?\n/)).toEqual(['first', 'second', 'third']);
  });
});

describe('two steps of one kind', () => {
  it('runs both and records a distinct result row for each', async () => {
    const { project, run, worktreePath } = await prepared('same-kind', [
      { key: 'lint-a', label: 'Lint A', kind: 'lint', command: 'node -e "0"', position: 0 },
      { key: 'lint-b', label: 'Lint B', kind: 'lint', command: 'node -e "process.exit(1)"', position: 10 },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const results = runsService.latestValidationAttempt(run.id);
    const lint = results.filter((r) => r.kind === 'lint');
    expect(lint).toHaveLength(2);
    expect(lint.find((r) => r.stepKey === 'lint-a')?.outcome).toBe('pass');
    expect(lint.find((r) => r.stepKey === 'lint-b')?.outcome).toBe('fail');
  });

  it('blocks readiness when one of two steps of a kind fails', async () => {
    const { project, run, worktreePath } = await prepared('same-kind-ready', [
      { key: 'unit-a', label: 'Unit A', kind: 'unit', command: 'node -e "0"', position: 0 },
      { key: 'unit-b', label: 'Unit B', kind: 'unit', command: 'node -e "process.exit(1)"', position: 10 },
    ]);
    runsService.replaceChangedFiles(run.id, [
      { path: 'a.ts', previousPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const assessment = runsService.assessReadiness(runsService.requireRun(run.id), project);
    expect(assessment.ready).toBe(false);
    // Named by label, because "unit failed" would not say which.
    expect(assessment.reasons.some((r) => r.includes('Unit B'))).toBe(true);
  });
});

describe('conditions', () => {
  it('records skipped, not failed, when no changed file matches', async () => {
    const { project, run, worktreePath } = await prepared('cond-skip', [
      {
        key: 'e2e',
        label: 'E2E',
        kind: 'e2e',
        command: 'node -e "process.exit(1)"',
        runWhen: 'changed_files_match',
        runWhenArg: 'src/ui/',
      },
    ]);

    await engine.runValidation({
      runId: run.id,
      worktreePath,
      project,
      profile: 'standard',
      changedPaths: ['docs/readme.md'],
    });

    const e2e = runsService.latestValidationAttempt(run.id).find((r) => r.stepKey === 'e2e');
    // The command exits non-zero. Had it run, this would be `fail`.
    expect(e2e?.outcome).toBe('skipped');
    expect(e2e?.error).toContain('src/ui/');
  });

  it('runs the same step when a changed file does match', async () => {
    const { project, run, worktreePath } = await prepared('cond-run', [
      {
        key: 'e2e',
        label: 'E2E',
        kind: 'e2e',
        command: 'node -e "0"',
        runWhen: 'changed_files_match',
        runWhenArg: 'src/ui/',
      },
    ]);

    await engine.runValidation({
      runId: run.id,
      worktreePath,
      project,
      profile: 'standard',
      changedPaths: ['src/ui/Button.tsx'],
    });

    expect(
      runsService.latestValidationAttempt(run.id).find((r) => r.stepKey === 'e2e')?.outcome,
    ).toBe('pass');
  });

  it('skips a dependent step after its dependency failed', async () => {
    const { project, run, worktreePath } = await prepared('cond-depends', [
      { key: 'build', label: 'Build', kind: 'build', command: 'node -e "process.exit(1)"', position: 0 },
      {
        key: 'e2e',
        label: 'E2E',
        kind: 'e2e',
        command: marker('should-not-run'),
        position: 10,
        runWhen: 'depends_on',
        runWhenArg: 'build',
      },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const results = runsService.latestValidationAttempt(run.id);
    expect(results.find((r) => r.stepKey === 'build')?.outcome).toBe('fail');
    expect(results.find((r) => r.stepKey === 'e2e')?.outcome).toBe('skipped');
    expect(fs.existsSync(path.join(worktreePath, 'order.txt'))).toBe(false);
  });

  it('does not skip an independent step after an earlier failure', async () => {
    // Fail-fast is opt-in. Running everything remains the default, because a
    // second failure is usually worth knowing about.
    const { project, run, worktreePath } = await prepared('cond-independent', [
      { key: 'build', label: 'Build', kind: 'build', command: 'node -e "process.exit(1)"', position: 0 },
      { key: 'lint', label: 'Lint', kind: 'lint', command: 'node -e "0"', position: 10 },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    expect(
      runsService.latestValidationAttempt(run.id).find((r) => r.stepKey === 'lint')?.outcome,
    ).toBe('pass');
  });

  it('refuses a pipeline whose dependencies form a cycle', async () => {
    await expect(
      projectsService.createProject({
        name: 'cond-cycle',
        repositoryPath: makeRepo(),
        validationSteps: [
          { key: 'a', label: 'A', command: 'node -e "0"', runWhen: 'depends_on', runWhenArg: 'b' },
          { key: 'b', label: 'B', command: 'node -e "0"', runWhen: 'depends_on', runWhenArg: 'a' },
        ],
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it('refuses a dependency on a step that is not in the pipeline', async () => {
    await expect(
      projectsService.createProject({
        name: 'cond-missing',
        repositoryPath: makeRepo(),
        validationSteps: [
          { key: 'a', label: 'A', command: 'node -e "0"', runWhen: 'depends_on', runWhenArg: 'ghost' },
        ],
      }),
    ).rejects.toThrow(/ghost/);
  });
});

describe('retries', () => {
  it('re-runs a step that could not start, and records the count', async () => {
    const { project, run, worktreePath } = await prepared('retry-error', [
      {
        key: 'missing',
        label: 'Missing binary',
        kind: 'build',
        // A shell reports a missing binary as a non-zero exit on some
        // platforms and a spawn error on others, so this asserts on the retry
        // count rather than on the classification.
        command: 'no-such-binary-xyz',
        retries: 2,
        retryOn: 'both',
      },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const artifacts = artifactsService.listArtifacts(run.id);
    const log = artifacts.find((a) => a.label.includes('Missing binary'));
    expect(log).toBeDefined();
    const content = await artifactsService.readArtifactText(log!.id);
    // A step that needed retries is not the same as one that passed first go.
    expect(content?.text).toContain('Retries used: 2 of 2');
  });

  it('does not retry a step that passed', async () => {
    const { project, run, worktreePath } = await prepared('retry-pass', [
      { key: 'once', label: 'Once', kind: 'unit', command: marker('run'), retries: 3, retryOn: 'both' },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const order = fs.readFileSync(path.join(worktreePath, 'order.txt'), 'utf8');
    expect(order.trim().split(/\r?\n/)).toEqual(['run']);
  });
});

describe('step environment', () => {
  it('passes configured values to the command', async () => {
    const { project, run, worktreePath } = await prepared('env-pass', [
      {
        key: 'echo',
        label: 'Echo',
        kind: 'unit',
        command: 'node -e "process.stdout.write(process.env.MY_FLAG || \'unset\')"',
        env: ['MY_FLAG=configured'],
      },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const result = runsService.latestValidationAttempt(run.id).find((r) => r.stepKey === 'echo');
    expect(result?.stdout).toContain('configured');
  });

  it('masks a secret-looking value in the stored row and in the artifact', async () => {
    const secret = 'super-secret-value-12345';
    const { project, run, worktreePath } = await prepared('env-secret', [
      {
        key: 'leak',
        label: 'Leak',
        kind: 'unit',
        command: 'node -e "process.stdout.write(process.env.MY_API_KEY || \'unset\')"',
        env: [`MY_API_KEY=${secret}`],
      },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const result = runsService.latestValidationAttempt(run.id).find((r) => r.stepKey === 'leak');
    expect(result?.stdout).not.toContain(secret);
    expect(result?.stdout).toContain('[redacted]');

    // The artifact holds the full stream, so it is the one that would leak.
    const log = artifactsService.listArtifacts(run.id).find((a) => a.label.includes('Leak'));
    const content = await artifactsService.readArtifactText(log!.id);
    expect(content?.text).not.toContain(secret);
  });
});

describe('coverage reporting', () => {
  it('still records a kind no step covers as not configured', async () => {
    const { project, run, worktreePath } = await prepared('coverage', [
      { key: 'unit', label: 'Unit', kind: 'unit', command: 'node -e "0"' },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const results = runsService.latestValidationAttempt(run.id);
    // A project that never set up E2E has not failed E2E.
    expect(results.find((r) => r.stepKey === 'e2e')?.outcome).toBe('not_configured');
    expect(results.filter((r) => r.outcome === 'not_configured')).toHaveLength(5);
  });

  it('reports no uncovered kind for a kind-less step, and still runs it', async () => {
    const { project, run, worktreePath } = await prepared('coverage-none', [
      { key: 'licences', label: 'Licences', kind: null, command: 'node -e "0"' },
    ]);

    await engine.runValidation({ runId: run.id, worktreePath, project, profile: 'standard' });

    const results = runsService.latestValidationAttempt(run.id);
    expect(results.find((r) => r.stepKey === 'licences')?.outcome).toBe('pass');
    // All six kinds remain uncovered: the step claims none of them.
    expect(results.filter((r) => r.outcome === 'not_configured')).toHaveLength(6);
  });
});
