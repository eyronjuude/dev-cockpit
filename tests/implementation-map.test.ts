import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deriveStages,
  describeImplementationMap,
  groupChangedFiles,
  renderImplementationMap,
  type ImplementationMapInput,
  type MapFile,
  type MapRun,
  type MapStage,
} from '@/visualisation/implementation-map';

/**
 * The renderer is pure, so most of this drives it directly with fixture data.
 * The service half gets a real SQLite database in a temporary directory, the
 * same way the rest of the suite does.
 */

let dataDir: string;
let mapService: typeof import('@/services/implementation-map');
let runsService: typeof import('@/services/runs');
let artifactsService: typeof import('@/services/artifacts');
let projectsService: typeof import('@/services/projects');
let closeDb: typeof import('@/db/client').closeDb;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-map-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  runsService = await import('@/services/runs');
  artifactsService = await import('@/services/artifacts');
  projectsService = await import('@/services/projects');
  mapService = await import('@/services/implementation-map');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function baseInput(): ImplementationMapInput {
  return {
    run: {
      id: 'run_fixture',
      title: 'Add a health endpoint',
      request: 'Add a health endpoint that returns 200.',
      status: 'READY',
      statusReason: 'validation passed',
      profile: 'standard',
      branch: 'cockpit/run_fixture',
      baseBranch: 'main',
      baseCommit: 'abcdef1234567890',
      spec: '# Goal\n\nAdd a health endpoint.',
      specProvider: 'codex-cli',
      transformerProvider: 'codex-cli',
      reviewerProvider: 'none',
      costUsd: 0.1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
    },
    projectName: 'Demo project',
    iterations: [{ kind: 'initial', status: 'completed', numTurns: 4 }],
    changedFiles: [
      {
        path: 'src/app/health.ts',
        changeType: 'added',
        additions: 40,
        deletions: 0,
        binary: false,
      },
      {
        path: 'src/app/router.ts',
        changeType: 'modified',
        additions: 6,
        deletions: 2,
        binary: false,
      },
    ],
    validations: [
      { kind: 'typecheck', outcome: 'pass', blocking: true, exitCode: 0, durationMs: 1700 },
      { kind: 'lint', outcome: 'pass', blocking: true, exitCode: 0, durationMs: 861 },
      { kind: 'unit', outcome: 'pass', blocking: true, exitCode: 0, durationMs: 1200 },
      {
        kind: 'integration',
        outcome: 'not_configured',
        blocking: false,
        exitCode: null,
        durationMs: null,
      },
      { kind: 'e2e', outcome: 'not_configured', blocking: false, exitCode: null, durationMs: null },
      {
        kind: 'build',
        outcome: 'not_configured',
        blocking: false,
        exitCode: null,
        durationMs: null,
      },
    ],
    findings: [],
    events: [
      { type: 'transform.completed', message: 'Specification ready (codex-cli, 4.1s)' },
      { type: 'worktree.prepared', message: 'Worktree ready on cockpit/run_fixture' },
    ],
    generatedAt: '2026-01-01T00:01:00.000Z',
  };
}

function withRun(patch: Partial<MapRun>): ImplementationMapInput {
  const base = baseInput();
  return { ...base, run: { ...base.run, ...patch } };
}

function stageOf(stages: readonly MapStage[], key: string): MapStage {
  const found = stages.find((s) => s.key === key);
  if (!found) throw new Error(`No stage ${key}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Stage derivation
 * ------------------------------------------------------------------ */

describe('deriveStages', () => {
  it('covers the whole pipeline in order', () => {
    const stages = deriveStages(baseInput());
    expect(stages.map((s) => s.key)).toEqual([
      'request',
      'specification',
      'worktree',
      'implementation',
      'changes',
      'validation',
      'review',
      'verdict',
    ]);
  });

  it('marks a run that went all the way through as done', () => {
    const stages = deriveStages(baseInput());
    expect(stageOf(stages, 'implementation').state).toBe('done');
    expect(stageOf(stages, 'changes').state).toBe('done');
    expect(stageOf(stages, 'validation').state).toBe('done');
    expect(stageOf(stages, 'verdict').state).toBe('done');
    expect(stageOf(stages, 'verdict').badge).toBe('Ready for review');
  });

  it('shows where a run that failed before implementing stopped', () => {
    const base = withRun({ status: 'FAILED', statusReason: 'error' });
    const stages = deriveStages({
      ...base,
      iterations: [],
      changedFiles: [],
      validations: [],
      events: [],
    });

    expect(stageOf(stages, 'implementation').state).toBe('pending');
    expect(stageOf(stages, 'changes').state).toBe('pending');
    expect(stageOf(stages, 'validation').state).toBe('pending');
    expect(stageOf(stages, 'verdict').state).toBe('failed');
    expect(stageOf(stages, 'verdict').badge).toBe('Failed');
  });

  it('calls a run that changed nothing "no change", never "failed"', () => {
    const stages = deriveStages({ ...baseInput(), changedFiles: [] });
    const changes = stageOf(stages, 'changes');

    expect(changes.state).toBe('empty');
    expect(changes.badge).toBe('no change');
    // The whole point of the separate state: an empty result is not a failure.
    expect(changes.tone).toBe('idle');
  });

  it('does not let an unconfigured check look like a failure', () => {
    const stages = deriveStages({
      ...baseInput(),
      validations: baseInput().validations.map((v) => ({
        ...v,
        outcome: 'not_configured' as const,
        blocking: false,
      })),
    });
    const validation = stageOf(stages, 'validation');

    expect(validation.state).toBe('skipped');
    expect(validation.tone).toBe('idle');
  });

  it('fails validation on a blocking failure', () => {
    const base = baseInput();
    const stages = deriveStages({
      ...base,
      validations: base.validations.map((v) =>
        v.kind === 'lint' ? { ...v, outcome: 'fail' as const, exitCode: 1 } : v,
      ),
    });

    expect(stageOf(stages, 'validation').state).toBe('failed');
  });

  it('names an advisory failure without letting it fail the stage', () => {
    const base = baseInput();
    const stages = deriveStages({
      ...base,
      validations: base.validations.map((v) =>
        v.kind === 'lint' ? { ...v, outcome: 'fail' as const, blocking: false, exitCode: 1 } : v,
      ),
    });
    const validation = stageOf(stages, 'validation');

    expect(validation.state).toBe('done');
    expect(validation.detail).toContain('advisory');
  });

  it('says why the specification step was skipped', () => {
    const base = withRun({ transformerProvider: 'none', spec: null, specProvider: null });
    const stages = deriveStages({
      ...base,
      events: [{ type: 'transform.skipped', message: 'No transformer configured' }],
    });

    expect(stageOf(stages, 'specification').state).toBe('skipped');
    expect(stageOf(stages, 'specification').detail).toContain('no transformer configured');
  });

  it('keeps the recorded reason a review was skipped', () => {
    const message = 'The Quick profile skips independent review';
    const base = baseInput();
    const stages = deriveStages({
      ...base,
      events: [...base.events, { type: 'review.skipped', message }],
    });

    expect(stageOf(stages, 'review').state).toBe('skipped');
    expect(stageOf(stages, 'review').detail).toBe(message);
  });

  it('counts blocking findings when a review ran', () => {
    const base = baseInput();
    const stages = deriveStages({
      ...base,
      findings: [{ severity: 'high' }, { severity: 'low' }, { severity: 'critical' }],
      events: [...base.events, { type: 'review.completed', message: 'Review finished' }],
    });

    expect(stageOf(stages, 'review').state).toBe('done');
    expect(stageOf(stages, 'review').detail).toBe('3 findings, 2 blocking');
  });
});

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

describe('groupChangedFiles', () => {
  it('groups by directory, heaviest first, and normalises separators', () => {
    const groups = groupChangedFiles([
      { path: 'README.md', changeType: 'modified', additions: 1, deletions: 0, binary: false },
      {
        path: 'src\\services\\runs.ts',
        changeType: 'modified',
        additions: 90,
        deletions: 10,
        binary: false,
      },
      {
        path: 'src/services/artifacts.ts',
        changeType: 'modified',
        additions: 4,
        deletions: 1,
        binary: false,
      },
    ]);

    expect(groups.map((g) => g.dir)).toEqual(['src/services', '(repository root)']);
    const services = groups[0]!;
    expect(services.additions).toBe(94);
    expect(services.deletions).toBe(11);
    // Heaviest file first inside the group, too.
    expect(services.files.map((f) => f.path)).toEqual([
      'src/services/runs.ts',
      'src/services/artifacts.ts',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Any `&` that does not start an entity would make the SVG unparseable. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

/** Built rather than typed, so this file holds no control bytes of its own. */
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);

describe('renderImplementationMap', () => {
  it('produces a self-contained SVG carrying its own description', () => {
    const svg = renderImplementationMap(baseInput());

    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>');
    expect(svg).toContain('<desc>');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);

    const height = /height="(\d+)" viewBox/.exec(svg);
    expect(height).not.toBeNull();
    expect(Number(height![1])).toBeGreaterThan(400);
  });

  it('escapes text instead of letting it become markup', () => {
    const svg = renderImplementationMap(
      withRun({ title: 'Fix <script>alert("x")</script> & the "quoted" bit' }),
    );

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(BARE_AMPERSAND.test(svg)).toBe(false);
  });

  it('leaves no bare ampersand anywhere in an ordinary map', () => {
    expect(BARE_AMPERSAND.test(renderImplementationMap(baseInput()))).toBe(false);
  });

  it('drops control characters that XML cannot represent', () => {
    const svg = renderImplementationMap({
      ...baseInput(),
      changedFiles: [
        {
          path: `src/we${BELL}ird${NUL}.ts`,
          changeType: 'added',
          additions: 3,
          deletions: 0,
          binary: false,
        },
      ],
    });

    expect(svg).not.toContain(BELL);
    expect(svg).not.toContain(NUL);
    expect(svg).toContain('weird.ts');
  });

  it('caps the file rows and says how many it left out', () => {
    const many: MapFile[] = Array.from({ length: 60 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      changeType: 'added' as const,
      additions: index + 1,
      deletions: 0,
      binary: false,
    }));
    const svg = renderImplementationMap({ ...baseInput(), changedFiles: many });

    expect(svg).toContain('+ 20 more files not drawn');
  });

  it('still draws a map when a run changed nothing', () => {
    const svg = renderImplementationMap({ ...baseInput(), changedFiles: [] });

    expect(svg).toContain('No file changed against the base commit.');
    expect(svg).toContain('>no change<');
  });

  it('reports a binary file rather than claiming zero lines changed', () => {
    const svg = renderImplementationMap({
      ...baseInput(),
      changedFiles: [
        {
          path: 'docs/screenshot.png',
          changeType: 'added',
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ],
    });

    expect(svg).toContain('>binary<');
  });
});

describe('describeImplementationMap', () => {
  it('states the status, every check and the change totals', () => {
    const description = describeImplementationMap(baseInput());

    expect(description).toContain('Status Ready for review');
    expect(description).toContain('2 files changed, 46 lines added and 2 removed');
    for (const kind of ['typecheck', 'lint', 'unit', 'integration', 'e2e', 'build']) {
      expect(description).toContain(kind);
    }
    expect(description).toContain('integration not configured');
  });
});

/* ------------------------------------------------------------------ *
 * Recording the artifact
 * ------------------------------------------------------------------ */

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

async function makeProject(name: string) {
  return projectsService.createProject({ name, repositoryPath: makeRepo(name) });
}

describe('recordImplementationMap', () => {
  it('records an inline-viewable artifact with the file on disk', async () => {
    const project = await makeProject('map-record');
    const run = runsService.createRun({
      projectId: project.id,
      request: 'Add a health endpoint.',
    });
    runsService.replaceChangedFiles(run.id, [
      {
        path: 'src/app.ts',
        previousPath: null,
        changeType: 'modified',
        additions: 12,
        deletions: 3,
        binary: false,
      },
    ]);

    const artifact = await mapService.recordImplementationMap(run.id);

    expect(artifact).not.toBeNull();
    expect(artifact!.kind).toBe('implementation_map');
    expect(artifact!.mimeType).toBe('image/svg+xml');
    expect(artifact!.exists).toBe(true);
    expect(artifact!.inlineViewable).toBe(true);
    expect(artifact!.bytes).toBeGreaterThan(0);
    expect(typeof artifact!.meta.description).toBe('string');
    expect(fs.readFileSync(artifact!.filePath, 'utf8')).toContain('<svg');
  });

  it('numbers successive passes instead of overwriting the first', async () => {
    const project = await makeProject('map-passes');
    const run = runsService.createRun({ projectId: project.id, request: 'x' });

    await mapService.recordImplementationMap(run.id);
    await mapService.recordImplementationMap(run.id);

    const maps = artifactsService
      .listArtifacts(run.id)
      .filter((a) => a.kind === 'implementation_map');

    expect(maps).toHaveLength(2);
    // Two rows written in the same millisecond have no defined order, so the
    // assertion is on the set rather than on which came back first.
    expect(maps.map((m) => m.label).sort()).toEqual([
      'Implementation map',
      'Implementation map (pass 2)',
    ]);
    expect(new Set(maps.map((m) => m.filePath)).size).toBe(2);
    expect(maps.every((m) => fs.existsSync(m.filePath))).toBe(true);
  });

  it('still records a map for a run that failed before implementing', async () => {
    const project = await makeProject('map-failed');
    const run = runsService.createRun({ projectId: project.id, request: 'x' });
    runsService.setStatus(run.id, 'PREPARING');
    runsService.setStatus(run.id, 'FAILED', { reason: 'no worktree', finished: true });

    const artifact = await mapService.recordImplementationMap(run.id);
    const svg = fs.readFileSync(artifact!.filePath, 'utf8');

    expect(svg).toContain('>Failed<');
    expect(svg).toContain('No file changed against the base commit.');
  });

  it('does not throw when the run is gone', async () => {
    await expect(
      mapService.tryRecordImplementationMap('run_does_not_exist'),
    ).resolves.toBeUndefined();
  });
});
