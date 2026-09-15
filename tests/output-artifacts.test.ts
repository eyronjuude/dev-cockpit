import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Capturing a page a build run wrote.
 *
 * Real worktrees and a real database, like the other service suites: the point
 * of this module is the file read and the artifact row, and a mocked filesystem
 * would test neither.
 */

let dataDir: string;

let worktree: typeof import('@/git/worktree');
let paths: typeof import('@/core/paths');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let artifactsService: typeof import('@/services/artifacts');
let eventsService: typeof import('@/services/events');
let outputPages: typeof import('@/services/output-pages');
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-outputs-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  worktree = await import('@/git/worktree');
  paths = await import('@/core/paths');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  artifactsService = await import('@/services/artifacts');
  eventsService = await import('@/services/events');
  outputPages = await import('@/services/output-pages');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A build run with a prepared worktree and a recorded set of changed files. */
async function runWithFiles(
  name: string,
  files: Record<string, string>,
  changed: { path: string; changeType: string }[],
) {
  const repositoryPath = makeRepo(name);
  const project = await projectsService.createProject({ name, repositoryPath });
  const created = runsService.createRun({
    projectId: project.id,
    request: 'write me a report',
    mode: 'build',
  });

  const prepared = await worktree.prepareWorktree({
    repositoryPath,
    worktreePath: paths.runWorktreeDir(project.id, created.id),
    branch: `cockpit/${created.id}`,
    baseRef: 'main',
    protectedBranches: ['main'],
  });
  runsService.updateRunFields(created.id, {
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    baseBranch: 'main',
  });

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(prepared.worktreePath, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  runsService.replaceChangedFiles(
    created.id,
    changed.map((file) => ({
      path: file.path,
      previousPath: null,
      changeType: file.changeType as never,
      additions: 1,
      deletions: 0,
      binary: false,
    })),
  );

  return runsService.requireRun(created.id);
}

const PAGE = '<!doctype html><title>Report</title><style>body{color:red}</style><p>ok</p>';

describe('capturing a page a build run wrote', () => {
  it('copies a standalone page out of the worktree and records it', async () => {
    const run = await runWithFiles(
      'page-ok',
      { 'reports/plan.html': PAGE },
      [{ path: 'reports/plan.html', changeType: 'untracked' }],
    );

    const recorded = await outputPages.recordOutputPages(run);
    expect(recorded).toHaveLength(1);

    const pages = artifactsService
      .listArtifacts(run.id)
      .filter((artifact) => artifact.kind === 'html_page');

    expect(pages).toHaveLength(1);
    expect(pages[0]?.mimeType).toBe('text/html');
    expect(pages[0]?.meta.sourcePath).toBe('reports/plan.html');
    expect(pages[0]?.meta.selfContained).toBe(true);
    expect(pages[0]?.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(pages[0]!.filePath)).toBe(true);
    expect(pages[0]!.filePath.startsWith(path.resolve(dataDir))).toBe(true);
  });

  it('does not record the same page twice across two passes', async () => {
    const run = await runWithFiles(
      'page-idempotent',
      { 'plan.html': PAGE },
      [{ path: 'plan.html', changeType: 'added' }],
    );

    await outputPages.recordOutputPages(run);
    await outputPages.recordOutputPages(runsService.requireRun(run.id));

    const pages = artifactsService
      .listArtifacts(run.id)
      .filter((artifact) => artifact.kind === 'html_page');

    expect(pages).toHaveLength(1);
  });

  it('marks a page that refers to files beside it', async () => {
    const run = await runWithFiles(
      'page-relative',
      { 'plan.html': '<!doctype html><link rel="stylesheet" href="./plan.css"><p>ok</p>' },
      [{ path: 'plan.html', changeType: 'added' }],
    );

    await outputPages.recordOutputPages(run);
    const page = artifactsService
      .listArtifacts(run.id)
      .find((artifact) => artifact.kind === 'html_page');

    expect(page?.meta.selfContained).toBe(false);
  });

  it('ignores build output and files the development server serves', async () => {
    const run = await runWithFiles(
      'page-ignored',
      {
        'coverage/lcov-report/index.html': PAGE,
        'node_modules/pkg/readme.html': PAGE,
        'public/index.html': PAGE,
      },
      [
        { path: 'coverage/lcov-report/index.html', changeType: 'added' },
        { path: 'node_modules/pkg/readme.html', changeType: 'added' },
        { path: 'public/index.html', changeType: 'modified' },
      ],
    );

    expect(await outputPages.recordOutputPages(run)).toEqual([]);
  });

  it('says so rather than copying a page too large to preview', async () => {
    const huge = `<!doctype html><p>${'x'.repeat(6 * 1024 * 1024)}</p>`;
    const run = await runWithFiles(
      'page-huge',
      { 'huge.html': huge },
      [{ path: 'huge.html', changeType: 'added' }],
    );

    expect(await outputPages.recordOutputPages(run)).toEqual([]);

    const events = eventsService.listEvents(run.id);
    expect(events.some((event) => event.type === 'output.skipped')).toBe(true);
  });

  it('records nothing for a read-only run', async () => {
    const run = await runWithFiles(
      'page-read-only',
      { 'plan.html': PAGE },
      [{ path: 'plan.html', changeType: 'added' }],
    );
    runsService.switchRunMode(run.id, 'plan', 'testing the read-only guard');

    expect(await outputPages.recordOutputPages(runsService.requireRun(run.id))).toEqual([]);
  });
});
