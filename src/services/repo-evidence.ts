import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import { VALIDATION_KINDS, type ValidationKind } from '@/domain/types';

/**
 * What a repository says about itself, and the project setup that follows.
 *
 * Two layers, deliberately separated:
 *
 *  - `collectRepoEvidence` reads manifests and returns facts. No inference, no
 *    model, no shell, no network. Everything it reports is something a file on
 *    disk actually says.
 *  - `proposeProjectSetup` turns those facts into commands. Still no model:
 *    a `build` script in `package.json` next to a `pnpm-lock.yaml` implies
 *    `pnpm build` with no judgement required.
 *
 * The optional model layer in `src/advisors` refines the second step. It never
 * replaces the first, because a model cannot read files here — the read-only
 * query used for it runs with no tools at all (`src/agents/claude-query.ts`).
 *
 * Bounded on purpose. Script values are capped and counted because they end up
 * inside a prompt, and a repository is untrusted input.
 */

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Script values reach a model prompt, so both the count and the length are capped. */
const MAX_SCRIPTS = 40;
const MAX_SCRIPT_VALUE = 200;
const MAX_MAKE_TARGETS = 30;
/** A manifest big enough to exceed this is not a manifest worth parsing. */
const MAX_MANIFEST_BYTES = 512 * 1024;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export const ECOSYSTEMS = [
  'node',
  'python',
  'rust',
  'go',
  'ruby',
  'java',
  'php',
  'elixir',
  'dotnet',
  'make',
] as const;

export type Ecosystem = (typeof ECOSYSTEMS)[number];

export interface RepoScript {
  name: string;
  value: string;
}

export interface RepoEvidence {
  repositoryPath: string;
  /** Every ecosystem with a manifest present, most significant first. */
  ecosystems: Ecosystem[];
  /** From `packageManager`, else inferred from the lockfile. Null when unknown. */
  packageManager: string | null;
  /** How the package manager was determined, for honest reporting. */
  packageManagerSource: 'packageManager field' | 'lockfile' | 'default' | null;
  manifests: string[];
  lockfiles: string[];
  /** `package.json` scripts, `pyproject` scripts, capped. */
  scripts: RepoScript[];
  makeTargets: string[];
  /** Tooling config files found, e.g. `tsconfig.json`, `playwright.config.ts`. */
  toolingConfigs: string[];
  monorepo: boolean;
  monorepoMarkers: string[];
  /**
   * Directories a fresh worktree will not have but the checks need, e.g.
   * `node_modules`. Used both to propose `linkPaths` and to tell whether a
   * worktree was ever provisioned.
   */
  dependencyDirs: string[];
  /**
   * Set when the build tool refuses dependencies reached through a symlink.
   * Turbopack is the known case, and it changes the whole recommendation.
   */
  rejectsLinkedDependencies: boolean;
  notes: string[];
}

export interface ProposedValidationCommand {
  kind: ValidationKind;
  command: string;
  workingDir: string | null;
}

export interface SetupProposal {
  packageManager: string | null;
  setupCommand: string | null;
  developmentCommand: string | null;
  linkPaths: string[];
  validationCommands: ProposedValidationCommand[];
  /** Why this proposal looks the way it does. Shown to the user verbatim. */
  notes: string | null;
  confidence: 'high' | 'low';
}

/* ------------------------------------------------------------------ *
 * Small filesystem helpers
 * ------------------------------------------------------------------ */

function exists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

function isDir(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads a manifest, or null when absent, unreadable or implausibly large. */
function readManifest(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** Top-level entries only, so a huge repository cannot make this expensive. */
function topLevel(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return [];
  }
}

const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

/* ------------------------------------------------------------------ *
 * Detection tables
 * ------------------------------------------------------------------ */

const MANIFESTS: { file: string; ecosystem: Ecosystem }[] = [
  { file: 'package.json', ecosystem: 'node' },
  { file: 'pyproject.toml', ecosystem: 'python' },
  { file: 'requirements.txt', ecosystem: 'python' },
  { file: 'Pipfile', ecosystem: 'python' },
  { file: 'setup.py', ecosystem: 'python' },
  { file: 'setup.cfg', ecosystem: 'python' },
  { file: 'Cargo.toml', ecosystem: 'rust' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'Gemfile', ecosystem: 'ruby' },
  { file: 'pom.xml', ecosystem: 'java' },
  { file: 'build.gradle', ecosystem: 'java' },
  { file: 'build.gradle.kts', ecosystem: 'java' },
  { file: 'composer.json', ecosystem: 'php' },
  { file: 'mix.exs', ecosystem: 'elixir' },
  { file: 'Makefile', ecosystem: 'make' },
  { file: 'justfile', ecosystem: 'make' },
];

/** Lockfile to package manager. Order matters: the first match wins. */
const LOCKFILES: { file: string; manager: string; ecosystem: Ecosystem }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', ecosystem: 'node' },
  { file: 'bun.lockb', manager: 'bun', ecosystem: 'node' },
  { file: 'yarn.lock', manager: 'yarn', ecosystem: 'node' },
  { file: 'package-lock.json', manager: 'npm', ecosystem: 'node' },
  { file: 'uv.lock', manager: 'uv', ecosystem: 'python' },
  { file: 'poetry.lock', manager: 'poetry', ecosystem: 'python' },
  { file: 'Pipfile.lock', manager: 'pipenv', ecosystem: 'python' },
  { file: 'Cargo.lock', manager: 'cargo', ecosystem: 'rust' },
  { file: 'Gemfile.lock', manager: 'bundler', ecosystem: 'ruby' },
  { file: 'composer.lock', manager: 'composer', ecosystem: 'php' },
];

const TOOLING_CONFIGS = [
  'tsconfig.json',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'jest.config.ts',
  'jest.config.js',
  'playwright.config.ts',
  'playwright.config.js',
  'cypress.config.ts',
  'eslint.config.mjs',
  'eslint.config.js',
  '.eslintrc.json',
  'ruff.toml',
  'pytest.ini',
  'tox.ini',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
];

const MONOREPO_MARKERS = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];

/* ------------------------------------------------------------------ *
 * Manifest parsing
 * ------------------------------------------------------------------ */

interface PackageJsonFacts {
  scripts: RepoScript[];
  packageManager: string | null;
  hasWorkspaces: boolean;
  dependencyNames: string[];
}

function parsePackageJson(text: string): PackageJsonFacts {
  const empty: PackageJsonFacts = {
    scripts: [],
    packageManager: null,
    hasWorkspaces: false,
    dependencyNames: [],
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const obj = parsed as Record<string, unknown>;

  const scripts: RepoScript[] = [];
  const rawScripts = obj.scripts;
  if (rawScripts && typeof rawScripts === 'object') {
    for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (scripts.length >= MAX_SCRIPTS) break;
      if (typeof value !== 'string') continue;
      scripts.push({ name, value: clip(value, MAX_SCRIPT_VALUE) });
    }
  }

  // `packageManager` is `pnpm@10.2.0`; only the name is useful here.
  let packageManager: string | null = null;
  if (typeof obj.packageManager === 'string') {
    const name = obj.packageManager.trim().split('@')[0]?.trim();
    if (name) packageManager = name;
  }

  const dependencyNames: string[] = [];
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = obj[field];
    if (deps && typeof deps === 'object') {
      dependencyNames.push(...Object.keys(deps as Record<string, unknown>));
    }
  }

  return {
    scripts,
    packageManager,
    hasWorkspaces: Array.isArray(obj.workspaces) || typeof obj.workspaces === 'object',
    dependencyNames,
  };
}

/**
 * Pulls script names out of a `pyproject.toml`.
 *
 * Deliberately not a TOML parser: there is no TOML dependency in this project
 * and adding one to read two table headers would be the wrong trade. This
 * recognises the two script tables and stops there, so anything it cannot
 * understand simply produces no scripts rather than a wrong answer.
 */
function parsePyprojectScripts(text: string): RepoScript[] {
  const scripts: RepoScript[] = [];
  let inScriptTable = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inScriptTable = line === '[project.scripts]' || line === '[tool.poetry.scripts]';
      continue;
    }
    if (!inScriptTable || !line || line.startsWith('#')) continue;

    const match = /^([A-Za-z0-9_.-]+)\s*=\s*["'](.+?)["']\s*$/.exec(line);
    if (!match) continue;
    if (scripts.length >= MAX_SCRIPTS) break;
    scripts.push({ name: match[1]!, value: clip(match[2]!, MAX_SCRIPT_VALUE) });
  }

  return scripts;
}

/** Target names from a Makefile. Ignores pattern rules and variables. */
function parseMakeTargets(text: string): string[] {
  const targets: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(raw);
    if (!match) continue;
    const name = match[1]!;
    if (targets.includes(name)) continue;
    if (targets.length >= MAX_MAKE_TARGETS) break;
    targets.push(name);
  }
  return targets;
}

function pyprojectManager(text: string): string | null {
  if (/^\s*\[tool\.poetry\]/m.test(text)) return 'poetry';
  if (/^\s*\[tool\.uv\]/m.test(text)) return 'uv';
  return null;
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * Reads a repository's manifests and reports what is there.
 *
 * Never throws for an unreadable or missing file: an absent manifest is a fact
 * about the repository, not an error. A path that is not a directory at all
 * comes back as empty evidence with a note saying so.
 */
export function collectRepoEvidence(repositoryPath: string): RepoEvidence {
  const evidence: RepoEvidence = {
    repositoryPath,
    ecosystems: [],
    packageManager: null,
    packageManagerSource: null,
    manifests: [],
    lockfiles: [],
    scripts: [],
    makeTargets: [],
    toolingConfigs: [],
    monorepo: false,
    monorepoMarkers: [],
    dependencyDirs: [],
    rejectsLinkedDependencies: false,
    notes: [],
  };

  let entries: string[];
  try {
    if (!fs.statSync(repositoryPath).isDirectory()) {
      evidence.notes.push('That path is not a directory.');
      return evidence;
    }
    entries = topLevel(repositoryPath);
  } catch {
    evidence.notes.push('That path could not be read.');
    return evidence;
  }

  const present = new Set(entries);
  const ecosystems = new Set<Ecosystem>();

  for (const { file, ecosystem } of MANIFESTS) {
    if (!present.has(file)) continue;
    evidence.manifests.push(file);
    ecosystems.add(ecosystem);
  }

  for (const { file, manager, ecosystem } of LOCKFILES) {
    if (!present.has(file)) continue;
    evidence.lockfiles.push(file);
    ecosystems.add(ecosystem);
    if (!evidence.packageManager) {
      evidence.packageManager = manager;
      evidence.packageManagerSource = 'lockfile';
    }
  }

  for (const config of TOOLING_CONFIGS) {
    if (present.has(config)) evidence.toolingConfigs.push(config);
  }

  for (const marker of MONOREPO_MARKERS) {
    if (present.has(marker)) evidence.monorepoMarkers.push(marker);
  }

  /* Node */
  if (present.has('package.json')) {
    const text = readManifest(repositoryPath, 'package.json');
    if (text) {
      const facts = parsePackageJson(text);
      evidence.scripts.push(...facts.scripts);
      if (facts.packageManager) {
        // An explicit field beats a lockfile guess.
        evidence.packageManager = facts.packageManager;
        evidence.packageManagerSource = 'packageManager field';
      }
      if (facts.hasWorkspaces) evidence.monorepoMarkers.push('package.json workspaces');
      evidence.dependencyDirs.push('node_modules');

      // Turbopack refuses to resolve through a symlink that leaves the
      // workspace root, so linking node_modules cannot serve its build.
      // Verified against Next 16.3.4: "Symlink [project]/node_modules is
      // invalid, it points out of the filesystem root".
      const usesNext = facts.dependencyNames.includes('next');
      if (usesNext) {
        evidence.rejectsLinkedDependencies = true;
        evidence.notes.push(
          'Next.js builds with Turbopack, which refuses dependencies reached through a link out of the project root. This project needs a setup command rather than a linked node_modules.',
        );
      }
    }
  }

  /* Python */
  if (present.has('pyproject.toml')) {
    const text = readManifest(repositoryPath, 'pyproject.toml');
    if (text) {
      evidence.scripts.push(...parsePyprojectScripts(text));
      const manager = pyprojectManager(text);
      if (manager && evidence.packageManagerSource !== 'packageManager field') {
        evidence.packageManager = manager;
        evidence.packageManagerSource = 'lockfile';
      }
    }
  }
  if (ecosystems.has('python')) {
    if (!evidence.packageManager) {
      evidence.packageManager = 'pip';
      evidence.packageManagerSource = 'default';
    }
    for (const dir of ['.venv', 'venv']) {
      if (isDir(repositoryPath, dir)) evidence.dependencyDirs.push(dir);
    }
    if (evidence.dependencyDirs.length === 0) evidence.dependencyDirs.push('.venv');
  }

  /* Make */
  if (present.has('Makefile')) {
    const text = readManifest(repositoryPath, 'Makefile');
    if (text) evidence.makeTargets.push(...parseMakeTargets(text));
  }

  /* Other ecosystems' dependency directories */
  if (ecosystems.has('rust')) evidence.dependencyDirs.push('target');
  if (ecosystems.has('ruby')) evidence.dependencyDirs.push('vendor/bundle');
  if (ecosystems.has('php')) evidence.dependencyDirs.push('vendor');
  if (ecosystems.has('elixir')) evidence.dependencyDirs.push('deps');

  // Node first when present: it is the case with the most to configure.
  evidence.ecosystems = ECOSYSTEMS.filter((e) => ecosystems.has(e));
  evidence.monorepo = evidence.monorepoMarkers.length > 0;

  if (evidence.manifests.length === 0) {
    evidence.notes.push('No recognised manifest at the repository root.');
  }

  return evidence;
}

/* ------------------------------------------------------------------ *
 * Proposal
 * ------------------------------------------------------------------ */

/** `pnpm build` / `npm run build` — npm and bun need `run`, pnpm and yarn do not. */
function scriptRunner(manager: string, script: string): string {
  switch (manager) {
    case 'pnpm':
    case 'yarn':
      return `${manager} ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/** The first script whose name matches one of `candidates`, in that order. */
function pickScript(scripts: RepoScript[], candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (scripts.some((s) => s.name === candidate)) return candidate;
  }
  return null;
}

const NODE_SCRIPT_CANDIDATES: Record<ValidationKind, readonly string[]> = {
  typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
  lint: ['lint', 'eslint'],
  unit: ['test:unit', 'test', 'unit'],
  integration: ['test:integration', 'integration'],
  e2e: ['test:e2e', 'e2e'],
  build: ['build', 'compile'],
};

function proposeNode(evidence: RepoEvidence, proposal: SetupProposal): void {
  const manager = evidence.packageManager ?? 'npm';
  proposal.packageManager = manager;

  for (const kind of VALIDATION_KINDS) {
    const script = pickScript(evidence.scripts, NODE_SCRIPT_CANDIDATES[kind]);
    // Only ever propose a script the manifest actually declares.
    if (!script) continue;
    // `test` is the unit slot; do not also offer it as the integration suite.
    if (kind === 'integration' && script === 'test') continue;
    proposal.validationCommands.push({
      kind,
      command: scriptRunner(manager, script),
      workingDir: null,
    });
  }

  // Playwright is usually not wired to a script, but the config proves it is there.
  const hasE2e = proposal.validationCommands.some((c) => c.kind === 'e2e');
  const playwright = evidence.toolingConfigs.some((c) => c.startsWith('playwright.config'));
  if (!hasE2e && playwright) {
    proposal.validationCommands.push({
      kind: 'e2e',
      command: 'npx playwright test',
      workingDir: null,
    });
  }

  const dev = pickScript(evidence.scripts, ['dev', 'start', 'serve']);
  if (dev) proposal.developmentCommand = scriptRunner(manager, dev);

  if (evidence.rejectsLinkedDependencies) {
    // Linking is the cheap option everywhere else, but Turbopack rejects it.
    proposal.setupCommand = installCommand(manager);
    proposal.linkPaths = [];
  } else {
    proposal.linkPaths = ['node_modules'];
    proposal.setupCommand = null;
  }
}

/** The install this manager should run in a fresh worktree. */
function installCommand(manager: string): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm install --prefer-offline';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    case 'uv':
      return 'uv sync';
    case 'poetry':
      return 'poetry install';
    case 'pipenv':
      return 'pipenv install --dev';
    case 'pip':
      return 'pip install -r requirements.txt';
    case 'bundler':
      return 'bundle install';
    case 'composer':
      return 'composer install';
    default:
      return 'npm install --prefer-offline';
  }
}

function proposePython(evidence: RepoEvidence, proposal: SetupProposal): void {
  const manager = evidence.packageManager ?? 'pip';
  proposal.packageManager ??= manager;
  proposal.setupCommand ??= installCommand(manager);

  // uv and poetry run tools through the project environment.
  const prefix = manager === 'uv' ? 'uv run ' : manager === 'poetry' ? 'poetry run ' : '';
  const has = (kind: ValidationKind) => proposal.validationCommands.some((c) => c.kind === kind);

  const pytest =
    evidence.toolingConfigs.includes('pytest.ini') ||
    evidence.toolingConfigs.includes('tox.ini') ||
    evidence.manifests.includes('pyproject.toml');
  if (pytest && !has('unit')) {
    proposal.validationCommands.push({
      kind: 'unit',
      command: `${prefix}pytest`,
      workingDir: null,
    });
  }

  if (evidence.toolingConfigs.includes('ruff.toml') && !has('lint')) {
    proposal.validationCommands.push({
      kind: 'lint',
      command: `${prefix}ruff check .`,
      workingDir: null,
    });
  }

  // A venv holds absolute paths in pyvenv.cfg and in script shebangs, so a
  // linked one points its interpreter back at the original checkout. An
  // install is the honest default; linking is left to the user.
  proposal.notes ??=
    'Python environments are installed rather than linked: a virtualenv records absolute paths, so a linked one would point back at your checkout.';
}

function proposeSimple(
  evidence: RepoEvidence,
  proposal: SetupProposal,
  spec: {
    manager: string;
    commands: Partial<Record<ValidationKind, string>>;
    linkPath?: string;
  },
): void {
  proposal.packageManager ??= spec.manager;
  const has = (kind: ValidationKind) => proposal.validationCommands.some((c) => c.kind === kind);
  for (const kind of VALIDATION_KINDS) {
    const command = spec.commands[kind];
    if (!command || has(kind)) continue;
    proposal.validationCommands.push({ kind, command, workingDir: null });
  }
  if (spec.linkPath && !proposal.linkPaths.includes(spec.linkPath)) {
    proposal.linkPaths.push(spec.linkPath);
  }
}

/**
 * Turns evidence into a draft project configuration.
 *
 * Every command proposed is backed by something in the evidence — a declared
 * script, or a config file that proves the tool is present. A kind with no
 * backing is left out, because a blank command means "not configured", which
 * the scorecard reports as such and never as a failure. Guessing here would
 * turn an honest blank into a false red.
 */
export function proposeProjectSetup(evidence: RepoEvidence): SetupProposal {
  const proposal: SetupProposal = {
    packageManager: null,
    setupCommand: null,
    developmentCommand: null,
    linkPaths: [],
    validationCommands: [],
    notes: null,
    confidence: 'low',
  };

  if (evidence.ecosystems.includes('node')) proposeNode(evidence, proposal);
  if (evidence.ecosystems.includes('python')) proposePython(evidence, proposal);

  if (evidence.ecosystems.includes('rust')) {
    proposeSimple(evidence, proposal, {
      manager: 'cargo',
      commands: {
        build: 'cargo build',
        unit: 'cargo test',
        lint: 'cargo clippy -- -D warnings',
      },
      linkPath: 'target',
    });
  }

  if (evidence.ecosystems.includes('go')) {
    proposeSimple(evidence, proposal, {
      manager: 'go',
      commands: { build: 'go build ./...', unit: 'go test ./...', lint: 'go vet ./...' },
    });
  }

  if (evidence.ecosystems.includes('ruby')) {
    proposeSimple(evidence, proposal, {
      manager: 'bundler',
      commands: { unit: 'bundle exec rspec' },
    });
    proposal.setupCommand ??= installCommand('bundler');
  }

  if (evidence.ecosystems.includes('elixir')) {
    proposeSimple(evidence, proposal, {
      manager: 'mix',
      commands: { unit: 'mix test', build: 'mix compile' },
      linkPath: 'deps',
    });
    proposal.setupCommand ??= 'mix deps.get';
  }

  // Make is a fallback: only offer targets that exist, and only for kinds
  // nothing better already filled.
  if (evidence.ecosystems.includes('make') && evidence.makeTargets.length > 0) {
    const has = (kind: ValidationKind) => proposal.validationCommands.some((c) => c.kind === kind);
    const makeFor: Partial<Record<ValidationKind, readonly string[]>> = {
      build: ['build', 'all'],
      unit: ['test', 'tests'],
      lint: ['lint'],
      typecheck: ['typecheck'],
      e2e: ['e2e'],
      integration: ['integration'],
    };
    for (const kind of VALIDATION_KINDS) {
      if (has(kind)) continue;
      const target = makeFor[kind]?.find((t) => evidence.makeTargets.includes(t));
      if (target) {
        proposal.validationCommands.push({ kind, command: `make ${target}`, workingDir: null });
      }
    }
  }

  // Confidence is about how well-evidenced the proposal is, not how complete.
  const strongEvidence =
    evidence.lockfiles.length > 0 ||
    evidence.packageManagerSource === 'packageManager field' ||
    evidence.scripts.length > 0;
  proposal.confidence =
    strongEvidence && proposal.validationCommands.length > 0 ? 'high' : 'low';

  if (evidence.monorepo) {
    const marker = evidence.monorepoMarkers.join(', ');
    proposal.notes = [
      proposal.notes,
      `This looks like a workspace (${marker}). Commands run at the repository root; set a working directory per check if a package needs one.`,
    ]
      .filter(Boolean)
      .join(' ');
    // A root-level guess is weaker in a monorepo.
    proposal.confidence = 'low';
  }

  if (evidence.notes.length > 0) {
    proposal.notes = [proposal.notes, ...evidence.notes].filter(Boolean).join(' ');
  }

  return proposal;
}

/* ------------------------------------------------------------------ *
 * Worktree dependency readiness
 * ------------------------------------------------------------------ */

export interface DependencyReadiness {
  /** False only when we are confident dependencies are needed and absent. */
  ready: boolean;
  /** The directories checked, relative to the worktree. */
  expected: string[];
  missing: string[];
}

/**
 * Whether a worktree looks like it has the dependencies its checks will need.
 *
 * Structural rather than output-matching: it asks whether the directories the
 * ecosystem needs are present, which is a question with a real answer. It
 * cannot catch every case — Turbopack rejects a `node_modules` that is present
 * but linked — so a `ready: true` is not a promise that validation will pass.
 * A `ready: false` is reliable, and that is the direction that matters: it is
 * the difference between a check that failed and a check that never had a
 * chance.
 */
export function checkDependencyReadiness(
  repositoryPath: string,
  worktreePath: string,
): DependencyReadiness {
  const evidence = collectRepoEvidence(repositoryPath);
  const expected = evidence.dependencyDirs;

  if (expected.length === 0) return { ready: true, expected: [], missing: [] };

  // Any one of the expected directories is enough: `.venv` or `venv`, not both.
  const missing = expected.filter((dir) => !exists(worktreePath, dir));
  const ready = missing.length < expected.length;

  return { ready, expected, missing: ready ? [] : missing };
}
