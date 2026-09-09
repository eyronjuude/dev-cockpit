import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentOutcome, AgentStartInput, ImplementationAgent } from '@/agents/types';
import type { ValidationKind } from '@/domain/types';

let dataDir: string;
let worktree: typeof import('@/git/worktree');
let diff: typeof import('@/git/diff');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let artifactsService: typeof import('@/services/artifacts');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let closeDb: typeof import('@/db/client').closeDb;

const author = { name: 'Test', email: 'test@example.com' };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function normaliseLines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-landing-ai-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  worktree = await import('@/git/worktree');
  diff = await import('@/git/diff');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
  artifactsService = await import('@/services/artifacts');
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

function makeRepo(name: string, fileText = 'base\n'): string {
  const repo = path.join(dataDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', author.email], repo);
  git(['config', 'user.name', author.name], repo);
  fs.writeFileSync(path.join(repo, 'file.txt'), fileText);
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'initial commit'], repo);
  return repo;
}

async function makeApprovedRun(
  name: string,
  runText: string,
  validationCommands: { kind: ValidationKind; command: string }[] = [],
) {
  const repo = makeRepo(name);
  const project = await projectsService.createProject({
    name,
    repositoryPath: repo,
    validationCommands,
  });
  const run = runsService.createRun({
    projectId: project.id,
    request: `Change file for ${name}`,
  });
  const runPath = path.join(dataDir, 'worktrees', project.id, run.id);
  const prepared = await worktree.prepareWorktree({
    repositoryPath: repo,
    worktreePath: runPath,
    branch: run.branch ?? `cockpit/${run.id}`,
    baseRef: 'main',
    protectedBranches: project.protectedBranches,
  });

  fs.writeFileSync(path.join(runPath, 'file.txt'), runText);
  const commitSha = await diff.commitAll(runPath, 'feat: edit file', author);
  const changed = await diff.collectRunDiff(runPath, prepared.baseCommit);

  runsService.updateRunFields(run.id, {
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    baseBranch: 'main',
    commitSha,
  });
  runsService.replaceChangedFiles(run.id, changed.files);
  runsService.setStatus(run.id, 'PREPARING', { started: true });
  runsService.setStatus(run.id, 'IMPLEMENTING');
  runsService.setStatus(run.id, 'VALIDATING');
  runsService.setStatus(run.id, 'READY', { finished: true });
  await orchestrator.approveRun(run.id, { createCommit: false });

  return { repo, project, run: runsService.requireRun(run.id), runPath };
}

function successOutcome(finalText: string): AgentOutcome {
  return {
    ok: true,
    sessionId: 'fake-session',
    exitCode: 0,
    finalText,
    numTurns: 1,
    durationMs: 5,
    costUsd: null,
    errorMessage: null,
    cancelled: false,
    timedOut: false,
    deniedTools: [],
    rawLogPath: null,
  };
}

function fakeAgent(options: {
  available?: boolean;
  edit?: (input: AgentStartInput) => void | Promise<void>;
}): ImplementationAgent {
  return {
    id: 'claude-code',
    label: 'Fake Agent',
    async checkAvailability() {
      return options.available === false
        ? { available: false, detail: 'not installed in test', version: null }
        : { available: true, detail: 'fake agent', version: 'test' };
    },
    async startRun(input) {
      await options.edit?.(input);
      await input.onEvent({ kind: 'text', text: 'Fake agent repaired the landing worktree.' });
      return successOutcome('Fake agent repaired the landing worktree.');
    },
    async continueRun(input) {
      await options.edit?.(input);
      return successOutcome('Fake agent continued the landing repair.');
    },
    async cancelRun() {
      return false;
    },
    getStatus(iterationId) {
      return { running: false, iterationId, pid: null, startedAt: null, sessionId: null };
    },
  };
}

async function waitForIdle(runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (orchestrator.isRunActive(runId)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('landing assistance', () => {
  it('automatically asks the agent to resolve landing merge conflicts', async () => {
    const validationCommand =
      'node -e "const fs=require(\'fs\'); const text=fs.readFileSync(\'file.txt\',\'utf8\'); if (!text.includes(\'run branch edit\')) process.exit(1)"';
    const { repo, run } = await makeApprovedRun(
      'auto-conflict',
      'run branch edit\n',
      [{ kind: 'unit', command: validationCommand }],
    );

    fs.writeFileSync(path.join(repo, 'file.txt'), 'main branch edit\n');
    await diff.commitAll(repo, 'chore: edit main', author);

    const restore = orchestrator.registerAgent(
      fakeAgent({
        edit: (input) => {
          expect(input.prompt).toContain('resolving Git merge conflicts');
          fs.writeFileSync(
            path.join(input.worktreePath, 'file.txt'),
            'main branch edit\nrun branch edit\n',
          );
        },
      }),
    );

    try {
      orchestrator.landRun(run.id);
      await waitForIdle(run.id);
    } finally {
      restore();
    }

    expect(runsService.requireRun(run.id).status).toBe('LANDED');
    expect(normaliseLines(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'))).toBe(
      'main branch edit\nrun branch edit\n',
    );

    const types = eventsService.listEvents(run.id).map((event) => event.type);
    expect(types).toContain('landing.resolution_started');
    expect(types).toContain('landing.resolution_completed');
    expect(types).toContain('landing.applied');
  });

  it('lets the agent repair failed landing validation once before applying', async () => {
    const validationCommand =
      'node -e "const fs=require(\'fs\'); const text=fs.readFileSync(\'file.txt\',\'utf8\'); if (!text.includes(\'fixed by landing repair\')) process.exit(1)"';
    const { repo, run } = await makeApprovedRun(
      'validation-repair',
      'broken landing content\n',
      [{ kind: 'unit', command: validationCommand }],
    );

    const restore = orchestrator.registerAgent(
      fakeAgent({
        edit: (input) => {
          expect(input.prompt).toContain('landing validation failed');
          fs.writeFileSync(path.join(input.worktreePath, 'file.txt'), 'fixed by landing repair\n');
        },
      }),
    );

    try {
      orchestrator.landRun(run.id);
      await waitForIdle(run.id);
    } finally {
      restore();
    }

    expect(runsService.requireRun(run.id).status).toBe('LANDED');
    expect(normaliseLines(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'))).toBe(
      'fixed by landing repair\n',
    );

    const types = eventsService.listEvents(run.id).map((event) => event.type);
    expect(types).toContain('landing.validation_failed');
    expect(types).toContain('landing.repair_started');
    expect(types).toContain('landing.repair_committed');
    expect(types).toContain('landing.applied');
  });

  it('records manual instructions when the agent cannot resolve a landing conflict', async () => {
    const { repo, run } = await makeApprovedRun(
      'manual-fallback',
      'run branch edit\n',
    );

    fs.writeFileSync(path.join(repo, 'file.txt'), 'main branch edit\n');
    await diff.commitAll(repo, 'chore: edit main', author);

    const restore = orchestrator.registerAgent(fakeAgent({ available: false }));

    try {
      orchestrator.landRun(run.id);
      await waitForIdle(run.id);
    } finally {
      restore();
    }

    expect(runsService.requireRun(run.id).status).toBe('MERGE_CONFLICT');
    expect(normaliseLines(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'))).toBe(
      'main branch edit\n',
    );

    const events = eventsService.listEvents(run.id);
    expect(events.map((event) => event.type)).toContain('landing.manual_instructions');
    expect(
      events.some(
        (event) =>
          event.type === 'artifact.created' &&
          event.message.includes('Manual landing repair instructions'),
      ),
    ).toBe(true);
  });

  it('centres manual instructions on the target checkout when that checkout is dirty', async () => {
    const { repo, run } = await makeApprovedRun(
      'target-dirty-fallback',
      'run branch edit\n',
    );

    fs.writeFileSync(path.join(repo, 'local-note.txt'), 'uncommitted local work\n');

    orchestrator.landRun(run.id);
    await waitForIdle(run.id);

    expect(runsService.requireRun(run.id).status).toBe('LANDING_FAILED');

    const manualArtifact = artifactsService
      .listArtifacts(run.id)
      .filter((artifact) => artifact.label === 'Manual landing repair instructions')
      .at(-1);
    expect(manualArtifact).toBeDefined();

    const content = normaliseLines(fs.readFileSync(manualArtifact!.filePath, 'utf8'));
    expect(content).toContain('Open the original repository checkout and inspect its state.');
    expect(content).toContain('git status --short --branch');
    expect(content).toContain('Preserve or clear local work in the original checkout.');
    expect(content).not.toContain(
      'Leave any repair edits in the landing worktree. Dev Cockpit will commit',
    );
  });
});
