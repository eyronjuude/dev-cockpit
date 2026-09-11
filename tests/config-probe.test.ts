import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SetupProposal } from '@/services/repo-evidence';

/**
 * The probe, the revision rule, and the undo behind them.
 *
 * `auto` mode is the only path where a model's shell commands are saved and
 * executed without a human reading them first. These tests are the guarantees
 * that makes acceptable: the checkout is disposable and really is removed, a
 * check that *failed* is never revised away, and every save can be undone.
 *
 * No model is called. The probe runs commands this file writes, and the
 * revision is applied directly, so what is under test is our rules rather than
 * a provider's behaviour.
 */

let dataDir: string;
let repoCounter = 0;

let probe: typeof import('@/advisors/probe');
let gitProbe: typeof import('@/git/probe');
let paths: typeof import('@/core/paths');
let projectsService: typeof import('@/services/projects');
let revisions: typeof import('@/services/config-revisions');
let closeDb: typeof import('@/db/client').closeDb;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-probe-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  probe = await import('@/advisors/probe');
  gitProbe = await import('@/git/probe');
  paths = await import('@/core/paths');
  projectsService = await import('@/services/projects');
  revisions = await import('@/services/config-revisions');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  closeDb?.();
  delete process.env.DEV_COCKPIT_DATA_DIR;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle briefly after a process tree is killed.
  }
});

function makeRepo(name: string): string {
  repoCounter += 1;
  const repo = path.join(dataDir, 'repos', `${name}-${repoCounter}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  return repo;
}

function proposal(overrides: Partial<SetupProposal> = {}): SetupProposal {
  return {
    packageManager: 'npm',
    setupCommand: null,
    developmentCommand: null,
    linkPaths: [],
    validationSteps: [],
    preview: { command: null, workingDir: null, readyPath: '/' },
    notes: null,
    confidence: 'high',
    ...overrides,
  };
}

function step(key: string, command: string, position = 0) {
  return {
    key,
    label: key,
    kind: null,
    command,
    workingDir: null,
    position,
    blocking: true,
  };
}

async function projectFor(name: string) {
  return projectsService.createProject({ name, repositoryPath: makeRepo(name) });
}

describe('the probe', () => {
  it('records a pass, a fail and an error as three different things', async () => {
    const project = await projectFor('probe-outcomes');
    const probeId = probe.createProbeRecord(project.id);

    const report = await probe.runConfigurationProbe({
      probeId,
      projectId: project.id,
      proposal: proposal({
        validationSteps: [
          step('ok', 'node -e "0"', 0),
          step('failing', 'node -e "process.exit(3)"', 10),
          step('broken', 'no-such-binary-xyz-abc', 20),
        ],
      }),
    });

    const byKey = new Map(report.steps.map((s) => [s.key, s]));
    expect(byKey.get('ok')?.outcome).toBe('pass');
    expect(byKey.get('failing')?.outcome).toBe('fail');
    expect(byKey.get('failing')?.exitCode).toBe(3);
    // A missing binary reaches the shell, which exits non-zero on some
    // platforms and fails to spawn on others. Either is honest; a pass is not.
    expect(byKey.get('broken')?.outcome).not.toBe('pass');
  });

  it('calls a configuration sound when a check ran and found something', async () => {
    // The distinction the whole revision rule rests on: a failing test is a
    // working pipeline reporting a real problem.
    const project = await projectFor('probe-sound');
    const probeId = probe.createProbeRecord(project.id);

    const report = await probe.runConfigurationProbe({
      probeId,
      projectId: project.id,
      proposal: proposal({ validationSteps: [step('failing', 'node -e "process.exit(1)"')] }),
    });

    expect(report.steps[0]?.outcome).toBe('fail');
    expect(report.configurationSound).toBe(true);
  });

  it('never touches the user checkout, and removes its own worktree', async () => {
    const project = await projectFor('probe-cleanup');
    const probeId = probe.createProbeRecord(project.id);

    await probe.runConfigurationProbe({
      probeId,
      projectId: project.id,
      // Writes a file. If the probe ran in the real checkout this would land there.
      proposal: proposal({
        validationSteps: [
          step('write', 'node -e "require(\'fs\').writeFileSync(\'probe-artifact.txt\',\'x\')"'),
        ],
      }),
    });

    expect(fs.existsSync(path.join(project.repositoryPath, 'probe-artifact.txt'))).toBe(false);
    expect(fs.existsSync(paths.probeWorktreeDir(project.id, probeId))).toBe(false);

    const branches = execFileSync('git', ['branch', '--list', 'cockpit/probe/*'], {
      cwd: project.repositoryPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(branches.trim()).toBe('');
  });

  it('removes the worktree even when a step throws the probe off course', async () => {
    const project = await projectFor('probe-cleanup-throw');
    const probeId = probe.createProbeRecord(project.id);

    await probe.runConfigurationProbe({
      probeId,
      projectId: project.id,
      // A working directory that escapes is recorded as an error rather than
      // thrown, but it exercises the same `finally`.
      proposal: proposal({
        validationSteps: [{ ...step('escape', 'node -e "0"'), workingDir: '../../..' }],
      }),
    });

    expect(fs.existsSync(paths.probeWorktreeDir(project.id, probeId))).toBe(false);
  });

  it('refuses to remove a path outside the probe root', async () => {
    const project = await projectFor('probe-guard');
    const result = await gitProbe.removeProbeWorktree({
      repositoryPath: project.repositoryPath,
      worktreePath: project.repositoryPath,
      branch: 'main',
    });
    expect(result.removed).toBe(false);
    expect(result.problems[0]).toMatch(/outside the probe root/);
    expect(fs.existsSync(project.repositoryPath)).toBe(true);
  });
});

describe('the feedback handed back to a model', () => {
  it('carries what could not run and withholds what merely failed', async () => {
    const project = await projectFor('probe-feedback');
    const probeId = probe.createProbeRecord(project.id);

    const report = await probe.runConfigurationProbe({
      probeId,
      projectId: project.id,
      proposal: proposal({
        validationSteps: [
          step('failing', 'node -e "process.exit(1)"', 0),
          step('broken', 'no-such-binary-xyz-abc', 10),
        ],
      }),
    });

    const feedback = probe.feedbackFrom(report);
    const keys = feedback.steps.map((s) => s.key);
    // Handing a failure to a model invites it to make the red go away, and the
    // red is usually the most valuable thing the probe found.
    expect(keys).not.toContain('failing');
    if (report.steps.find((s) => s.key === 'broken')?.outcome === 'error') {
      expect(keys).toContain('broken');
    }
  });
});

describe('applying a revision', () => {
  const report = {
    proposal: proposal(),
    setup: null,
    steps: [
      { key: 'passing', label: 'passing', command: 'a', outcome: 'pass' as const, exitCode: 0, durationMs: 1, error: null, excerpt: null },
      { key: 'failing', label: 'failing', command: 'b', outcome: 'fail' as const, exitCode: 1, durationMs: 1, error: null, excerpt: null },
      { key: 'broken', label: 'broken', command: 'c', outcome: 'error' as const, exitCode: null, durationMs: null, error: 'missing', excerpt: null },
    ],
    preview: null,
    configurationSound: false,
    notes: [],
  };

  const probed = proposal({
    validationSteps: [
      step('passing', 'a', 0),
      step('failing', 'b', 10),
      step('broken', 'c', 20),
    ],
  });

  it('corrects a step that could not run', () => {
    const revised = proposal({
      validationSteps: [step('broken', 'npx c', 20)],
    });
    const merged = probe.applyRevision(probed, revised, report);
    expect(merged.validationSteps.find((s) => s.key === 'broken')?.command).toBe('npx c');
  });

  it('leaves a step that ran and failed exactly as it was', () => {
    // A model asked to fix a red pipeline will reach for the failing check.
    // This is the guarantee that stops it, enforced rather than requested.
    const revised = proposal({
      validationSteps: [step('failing', 'node -e "0"', 10)],
    });
    const merged = probe.applyRevision(probed, revised, report);
    expect(merged.validationSteps.find((s) => s.key === 'failing')?.command).toBe('b');
  });

  it('leaves a step that passed alone, and cannot delete either', () => {
    const revised = proposal({ validationSteps: [] });
    const merged = probe.applyRevision(probed, revised, report);
    expect(merged.validationSteps.map((s) => s.key)).toEqual(['passing', 'failing', 'broken']);
  });

  it('keeps a genuinely new step, at the end where it reorders nothing', () => {
    const revised = proposal({
      validationSteps: [step('extra', 'node -e "0"', 0)],
    });
    const merged = probe.applyRevision(probed, revised, report);
    expect(merged.validationSteps.at(-1)?.key).toBe('extra');
    expect(merged.validationSteps.slice(0, 3).map((s) => s.key)).toEqual([
      'passing',
      'failing',
      'broken',
    ]);
  });
});

describe('configuration history', () => {
  it('restores the pipeline a revert names', async () => {
    const project = await projectFor('history-revert');
    projectsService.replaceValidationSteps(project.id, [
      { key: 'original', label: 'Original', kind: 'unit', command: 'npm test' },
    ]);

    const revisionId = revisions.recordRevision(project.id, 'user', 'before');
    expect(revisionId).not.toBeNull();

    projectsService.replaceValidationSteps(project.id, [
      { key: 'replacement', label: 'Replacement', kind: 'lint', command: 'npm run lint' },
    ]);
    expect(projectsService.requireProject(project.id).validationSteps[0]?.key).toBe('replacement');

    revisions.revertToRevision(project.id, revisionId!);
    const restored = projectsService.requireProject(project.id).validationSteps;
    expect(restored.map((s) => s.key)).toEqual(['original']);
    expect(restored[0]?.command).toBe('npm test');
  });

  it('makes a revert itself undoable', async () => {
    const project = await projectFor('history-undo-revert');
    projectsService.replaceValidationSteps(project.id, [
      { key: 'first', label: 'First', command: 'a' },
    ]);
    const first = revisions.recordRevision(project.id, 'user', 'first');

    projectsService.replaceValidationSteps(project.id, [
      { key: 'second', label: 'Second', command: 'b' },
    ]);
    revisions.revertToRevision(project.id, first!);

    // The revert recorded the configuration it replaced, so the thing reverted
    // away from is still reachable.
    const holdingSecond = revisions
      .listRevisions(project.id)
      .find((r) => r.snapshot.validationSteps.some((s) => s.key === 'second'));
    expect(holdingSecond).toBeDefined();
  });

  it('does not record a second revision for an unchanged configuration', async () => {
    const project = await projectFor('history-noop');
    projectsService.replaceValidationSteps(project.id, [
      { key: 'only', label: 'Only', command: 'a' },
    ]);

    expect(revisions.recordRevision(project.id, 'user', 'first')).not.toBeNull();
    // Pressing Save twice should not bury the revision worth going back to.
    expect(revisions.recordRevision(project.id, 'user', 'again')).toBeNull();
  });

  it('captures the preview configuration too, not only the pipeline', async () => {
    const project = await projectFor('history-preview');
    projectsService.updateProject(project.id, {
      developmentCommand: 'npm run dev',
      preview: { readyPath: '/healthz', autoStart: true },
    });
    const revisionId = revisions.recordRevision(project.id, 'user', 'with preview');

    projectsService.updateProject(project.id, {
      developmentCommand: 'npm start',
      preview: { readyPath: '/', autoStart: false },
    });

    revisions.revertToRevision(project.id, revisionId!);
    const restored = projectsService.requireProject(project.id);
    expect(restored.preview.command).toBe('npm run dev');
    expect(restored.preview.readyPath).toBe('/healthz');
    expect(restored.preview.autoStart).toBe(true);
  });
});
