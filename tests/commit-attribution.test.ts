import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;
let worktree: typeof import('@/git/worktree');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let closeDb: typeof import('@/db/client').closeDb;
let previousGitConfigGlobal: string | undefined;
let previousGitConfigNoSystem: string | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function commitHeader(cwd: string): { name: string; email: string; subject: string; body: string } {
  const raw = git(['log', '-1', '--format=%an%n%ae%n%s%n%b'], cwd);
  const [name, email, subject, ...rest] = raw.split('\n');
  return { name: name ?? '', email: email ?? '', subject: subject ?? '', body: rest.join('\n') };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-commit-attribution-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  // The app's git() wrapper inherits process.env, so without this, a real
  // global git identity on the machine running these tests (common on a
  // developer box or a self-hosted runner) would make the "nothing
  // configured" case indistinguishable from "globally configured" — this
  // repo-local config always overrides it anyway, so isolating global config
  // only affects the deliberately-unconfigured test cases.
  previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  previousGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = path.join(dataDir, 'nonexistent-gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  worktree = await import('@/git/worktree');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
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
  if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  if (previousGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = previousGitConfigNoSystem;
});

/** A repo with a real git identity configured, distinct from the "Dev Cockpit" fallback. */
function makeRepo(name: string, identity: { name: string; email: string } | null): string {
  const repo = path.join(dataDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  if (identity) {
    git(['config', 'user.name', identity.name], repo);
    git(['config', 'user.email', identity.email], repo);
  }
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A'], repo);
  // The initial commit needs *some* identity to exist at all; supply one
  // ad hoc via -c so a deliberately unconfigured repo still gets one commit
  // to branch from, without that identity leaking into `localGitIdentity`'s
  // read of the repo's actual config.
  git(
    [
      '-c',
      'user.name=Scratch Setup',
      '-c',
      'user.email=scratch@example.com',
      'commit',
      '-qm',
      'initial commit',
    ],
    repo,
  );
  return repo;
}

/** Creates a project + run with a dirty (uncommitted) worktree, ready to approve. */
async function makeDirtyRun(projectName: string, repo: string, fileText: string) {
  const project = await projectsService.createProject({ name: projectName, repositoryPath: repo });
  const run = runsService.createRun({ projectId: project.id, request: `Change file for ${projectName}` });
  const runPath = path.join(dataDir, 'worktrees', project.id, run.id);
  const prepared = await worktree.prepareWorktree({
    repositoryPath: repo,
    worktreePath: runPath,
    branch: run.branch ?? `cockpit/${run.id}`,
    baseRef: 'main',
    protectedBranches: project.protectedBranches,
  });

  fs.writeFileSync(path.join(runPath, 'file.txt'), fileText);

  runsService.updateRunFields(run.id, {
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    baseBranch: 'main',
  });

  return { project, run: runsService.requireRun(run.id), runPath };
}

describe('commit author identity', () => {
  it("uses the repository's configured git identity instead of the Dev Cockpit placeholder", async () => {
    const repo = makeRepo('identity-configured', { name: 'Aaron Jude Tanael', email: 'aaron@twinklingtree.com' });
    const { run } = await makeDirtyRun('identity-configured', repo, 'changed\n');

    await orchestrator.approveRun(run.id);

    const header = commitHeader(run.worktreePath!);
    expect(header.name).toBe('Aaron Jude Tanael');
    expect(header.email).toBe('aaron@twinklingtree.com');
  });

  it('falls back to the Dev Cockpit identity when nothing is configured', async () => {
    const repo = makeRepo('identity-unset', null);
    const { run } = await makeDirtyRun('identity-unset', repo, 'changed\n');

    await orchestrator.approveRun(run.id);

    const header = commitHeader(run.worktreePath!);
    expect(header.name).toBe('Dev Cockpit');
    expect(header.email).toBe('dev-cockpit@localhost');
  });
});

describe('Conventional Commits formatting', () => {
  it('prefixes the default commit subject with feat: and adds a model co-author trailer', async () => {
    const repo = makeRepo('conventional-on', { name: 'Aaron Jude Tanael', email: 'aaron@twinklingtree.com' });
    const { run } = await makeDirtyRun('conventional-on', repo, 'changed\n');

    await orchestrator.approveRun(run.id);

    const header = commitHeader(run.worktreePath!);
    expect(header.subject.startsWith('feat: ')).toBe(true);
    expect(header.subject).toContain(run.title);
    expect(header.body).toContain('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
  });

  it('leaves the subject unprefixed when conventionalCommits is off', async () => {
    const repo = makeRepo('conventional-off', { name: 'Aaron Jude Tanael', email: 'aaron@twinklingtree.com' });
    const project = await projectsService.createProject({
      name: 'conventional-off',
      repositoryPath: repo,
      conventionalCommits: false,
    });
    const run = runsService.createRun({ projectId: project.id, request: 'Change file for conventional-off' });
    const runPath = path.join(dataDir, 'worktrees', project.id, run.id);
    const prepared = await worktree.prepareWorktree({
      repositoryPath: repo,
      worktreePath: runPath,
      branch: run.branch ?? `cockpit/${run.id}`,
      baseRef: 'main',
      protectedBranches: project.protectedBranches,
    });
    fs.writeFileSync(path.join(runPath, 'file.txt'), 'changed\n');
    runsService.updateRunFields(run.id, {
      worktreePath: prepared.worktreePath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      baseBranch: 'main',
    });

    await orchestrator.approveRun(run.id);

    const header = commitHeader(runPath);
    const reloaded = runsService.requireRun(run.id);
    expect(header.subject).toBe(reloaded.title);
    // The trailer is independent of the Conventional Commits toggle.
    expect(header.body).toContain('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
  });

  it("leaves an explicit user-typed commit message untouched (doesn't double-prefix or strip it)", async () => {
    const repo = makeRepo('explicit-message', { name: 'Aaron Jude Tanael', email: 'aaron@twinklingtree.com' });
    const { run } = await makeDirtyRun('explicit-message', repo, 'changed\n');

    await orchestrator.approveRun(run.id, { commitMessage: 'fix: hand-typed message' });

    const header = commitHeader(run.worktreePath!);
    expect(header.subject).toBe('fix: hand-typed message');
  });
});
