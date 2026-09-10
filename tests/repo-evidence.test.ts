import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Repository detection and the proposal derived from it.
 *
 * Real fixture directories rather than a mocked filesystem, because the whole
 * value of this module is what it does with files that are actually there.
 * Nothing here calls a model: this is the deterministic layer, which is where
 * most of the correctness lives.
 */

let root: string;
let evidenceMod: typeof import('@/services/repo-evidence');

/** Writes a fixture repository and returns its path. */
function fixture(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const commandFor = (
  proposal: import('@/services/repo-evidence').SetupProposal,
  kind: string,
): string | undefined => proposal.validationCommands.find((c) => c.kind === kind)?.command;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-evidence-'));
  evidenceMod = await import('@/services/repo-evidence');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('repository evidence', () => {
  it('reads a pnpm Node project and proposes its declared scripts', () => {
    const dir = fixture('pnpm-node', {
      'package.json': JSON.stringify({
        name: 'thing',
        packageManager: 'pnpm@10.2.0',
        scripts: {
          dev: 'vite',
          build: 'vite build',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
        },
        devDependencies: { vite: '^5.0.0' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'tsconfig.json': '{}',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.ecosystems).toContain('node');
    expect(evidence.packageManager).toBe('pnpm');
    expect(evidence.packageManagerSource).toBe('packageManager field');
    expect(evidence.lockfiles).toContain('pnpm-lock.yaml');
    expect(evidence.dependencyDirs).toContain('node_modules');
    expect(evidence.rejectsLinkedDependencies).toBe(false);

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(commandFor(proposal, 'build')).toBe('pnpm build');
    expect(commandFor(proposal, 'lint')).toBe('pnpm lint');
    expect(commandFor(proposal, 'typecheck')).toBe('pnpm typecheck');
    expect(commandFor(proposal, 'unit')).toBe('pnpm test');
    expect(proposal.developmentCommand).toBe('pnpm dev');
    // Linking costs nothing, so it is preferred over an install.
    expect(proposal.linkPaths).toEqual(['node_modules']);
    expect(proposal.setupCommand).toBeNull();
    expect(proposal.confidence).toBe('high');
  });

  it('uses npm run for an npm project and infers the manager from the lockfile', () => {
    const dir = fixture('npm-node', {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'package-lock.json': '{}',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.packageManager).toBe('npm');
    expect(evidence.packageManagerSource).toBe('lockfile');

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(commandFor(proposal, 'build')).toBe('npm run build');
  });

  it('never proposes a script the manifest does not declare', () => {
    const dir = fixture('sparse-node', {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'package-lock.json': '{}',
    });

    const proposal = evidenceMod.proposeProjectSetup(evidenceMod.collectRepoEvidence(dir));

    // A blank check reports as "not configured"; a guessed one reports as a
    // failure. Only `build` exists here.
    expect(proposal.validationCommands.map((c) => c.kind)).toEqual(['build']);
    expect(commandFor(proposal, 'lint')).toBeUndefined();
    expect(commandFor(proposal, 'unit')).toBeUndefined();
  });

  it('proposes an install rather than a link for a Next.js project', () => {
    // Turbopack refuses to resolve dependencies through a link that leaves the
    // project root, so linking node_modules cannot serve its build.
    const dir = fixture('next-app', {
      'package.json': JSON.stringify({
        packageManager: 'pnpm@10.2.0',
        scripts: { build: 'next build', dev: 'next dev' },
        dependencies: { next: '^16.3.4' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'next.config.ts': 'export default {};',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.rejectsLinkedDependencies).toBe(true);

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(proposal.linkPaths).toEqual([]);
    expect(proposal.setupCommand).toBe('pnpm install --prefer-offline');
    expect(proposal.notes).toMatch(/Turbopack/);
  });

  it('offers playwright as the e2e check when only its config proves it is there', () => {
    const dir = fixture('playwright-app', {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'package-lock.json': '{}',
      'playwright.config.ts': 'export default {};',
    });

    const proposal = evidenceMod.proposeProjectSetup(evidenceMod.collectRepoEvidence(dir));
    expect(commandFor(proposal, 'e2e')).toBe('npx playwright test');
  });

  it('reads a uv Python project and installs rather than links', () => {
    const dir = fixture('uv-python', {
      'pyproject.toml': [
        '[project]',
        'name = "thing"',
        '',
        '[project.scripts]',
        'serve = "thing.cli:main"',
        '',
        '[tool.uv]',
        'dev-dependencies = []',
      ].join('\n'),
      'uv.lock': 'version = 1\n',
      'pytest.ini': '[pytest]\n',
      'ruff.toml': '',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.ecosystems).toContain('python');
    expect(evidence.packageManager).toBe('uv');
    expect(evidence.scripts.map((s) => s.name)).toContain('serve');

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(proposal.setupCommand).toBe('uv sync');
    expect(commandFor(proposal, 'unit')).toBe('uv run pytest');
    expect(commandFor(proposal, 'lint')).toBe('uv run ruff check .');
    // A venv records absolute paths, so it is installed, never linked.
    expect(proposal.linkPaths).toEqual([]);
  });

  it('falls back to pip for a bare requirements.txt project', () => {
    const dir = fixture('pip-python', {
      'requirements.txt': 'flask\n',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.packageManager).toBe('pip');
    expect(evidence.dependencyDirs).toContain('.venv');

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(proposal.setupCommand).toBe('pip install -r requirements.txt');
  });

  it('proposes cargo commands for a Rust project', () => {
    const dir = fixture('rust-crate', {
      'Cargo.toml': '[package]\nname = "thing"\n',
      'Cargo.lock': 'version = 3\n',
    });

    const proposal = evidenceMod.proposeProjectSetup(evidenceMod.collectRepoEvidence(dir));
    expect(commandFor(proposal, 'build')).toBe('cargo build');
    expect(commandFor(proposal, 'unit')).toBe('cargo test');
    expect(proposal.linkPaths).toContain('target');
  });

  it('uses Makefile targets only when they exist', () => {
    const dir = fixture('make-project', {
      Makefile: ['build:', '\tcc -o out main.c', '', 'test:', '\t./out --check', ''].join('\n'),
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.makeTargets).toEqual(['build', 'test']);

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(commandFor(proposal, 'build')).toBe('make build');
    expect(commandFor(proposal, 'unit')).toBe('make test');
    expect(commandFor(proposal, 'lint')).toBeUndefined();
  });

  it('flags a workspace and drops its confidence', () => {
    const dir = fixture('monorepo', {
      'package.json': JSON.stringify({ scripts: { build: 'turbo build' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.monorepo).toBe(true);

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(proposal.confidence).toBe('low');
    expect(proposal.notes).toMatch(/workspace/i);
  });

  it('reports an unrecognised repository honestly instead of guessing', () => {
    const dir = fixture('mystery', { 'notes.txt': 'hello' });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.manifests).toEqual([]);
    expect(evidence.notes.join(' ')).toMatch(/no recognised manifest/i);

    const proposal = evidenceMod.proposeProjectSetup(evidence);
    expect(proposal.validationCommands).toEqual([]);
    expect(proposal.confidence).toBe('low');
  });

  it('survives a path that is not a directory, and one that is not there', () => {
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');

    expect(evidenceMod.collectRepoEvidence(file).notes.join(' ')).toMatch(/not a directory/i);
    expect(
      evidenceMod.collectRepoEvidence(path.join(root, 'nope')).notes.join(' '),
    ).toMatch(/could not be read/i);
  });

  it('ignores a manifest that is not valid JSON rather than throwing', () => {
    const dir = fixture('broken-json', {
      'package.json': '{ this is not json',
      'package-lock.json': '{}',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    expect(evidence.ecosystems).toContain('node');
    expect(evidence.scripts).toEqual([]);
  });

  it('caps how much of a repository reaches a prompt', () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 80; i += 1) scripts[`script-${i}`] = 'x'.repeat(500);
    const dir = fixture('huge-scripts', {
      'package.json': JSON.stringify({ scripts }),
      'package-lock.json': '{}',
    });

    const evidence = evidenceMod.collectRepoEvidence(dir);
    // Script text is untrusted input bound for a model prompt, so both the
    // count and each value are bounded.
    expect(evidence.scripts.length).toBeLessThanOrEqual(40);
    for (const script of evidence.scripts) {
      expect(script.value.length).toBeLessThanOrEqual(201);
    }
  });
});

describe('worktree dependency readiness', () => {
  it('reports a Node worktree with no node_modules as not ready', () => {
    const repo = fixture('readiness-repo', {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'package-lock.json': '{}',
    });
    const worktree = fixture('readiness-worktree', { 'package.json': '{}' });

    const readiness = evidenceMod.checkDependencyReadiness(repo, worktree);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('node_modules');
  });

  it('reports it as ready once the dependencies are there', () => {
    const repo = fixture('readiness-repo-2', {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'package-lock.json': '{}',
    });
    const worktree = fixture('readiness-worktree-2', {
      'package.json': '{}',
      'node_modules/left-pad/package.json': '{}',
    });

    expect(evidenceMod.checkDependencyReadiness(repo, worktree).ready).toBe(true);
  });

  it('makes no claim about a repository with no recognised dependencies', () => {
    const repo = fixture('readiness-mystery', { 'notes.txt': 'x' });
    const worktree = fixture('readiness-mystery-wt', { 'notes.txt': 'x' });

    const readiness = evidenceMod.checkDependencyReadiness(repo, worktree);
    expect(readiness.ready).toBe(true);
    expect(readiness.expected).toEqual([]);
  });
});
