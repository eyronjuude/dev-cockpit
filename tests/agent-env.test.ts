import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentOutcome, AgentStartInput, ImplementationAgent } from '@/agents/types';
import { agentProcessEnv } from '@/agents/spawn-env';
import { clearExtraSecrets, redactText } from '@/core/redact';

/**
 * The project's `env` field reaches the implementation agent.
 *
 * Setup, validation, previews and operational commands already received it;
 * the agent was spawned with Dev Cockpit's own `process.env` alone. So an agent
 * asked to check a migration in its worktree had no `DATABASE_URL`, while the
 * validation step that ran straight after it did — the same worktree, two
 * different environments.
 */

describe('agentProcessEnv', () => {
  afterEach(() => {
    clearExtraSecrets();
    delete process.env.COCKPIT_TEST_INHERITED;
  });

  it('layers the project env over the inherited environment', () => {
    process.env.COCKPIT_TEST_INHERITED = 'from-server';

    const env = agentProcessEnv({
      DATABASE_URL: 'postgres://localhost/scratch_run',
      COCKPIT_TEST_INHERITED: 'from-project',
    });

    expect(env.DATABASE_URL).toBe('postgres://localhost/scratch_run');
    expect(env.COCKPIT_TEST_INHERITED).toBe('from-project');
    // PATH still has to resolve the CLI's own tools.
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it('keeps the headless flags even when the project sets them', () => {
    const env = agentProcessEnv({ CI: '0', FORCE_COLOR: '3' });

    expect(env.CI).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
  });

  it('masks secret-named values in anything the agent prints', () => {
    agentProcessEnv({ STRIPE_SECRET_KEY: 'sk_test_agent_env_1234' });

    expect(redactText('key is sk_test_agent_env_1234')).not.toContain('sk_test_agent_env_1234');
  });

  it('is the inherited environment plus the flags when there is no project env', () => {
    const env = agentProcessEnv(undefined);

    expect(env.CI).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
  });
});

/* ------------------------------------------------------------------ *
 * Through the real orchestrator
 * ------------------------------------------------------------------ */

let dataDir: string;
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let closeDb: typeof import('@/db/client').closeDb;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agent-env-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

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
    // Windows can briefly hold a git worktree handle after the process exits.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

function makeRepo(name: string): string {
  const repo = path.join(dataDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'initial commit'], repo);
  return repo;
}

const fakeOutcome: AgentOutcome = {
  ok: true,
  sessionId: 'sess-env-fake',
  exitCode: 0,
  finalText: 'Done.',
  numTurns: 1,
  durationMs: 5,
  costUsd: 0,
  usage: null,
  errorMessage: null,
  cancelled: false,
  timedOut: false,
  deniedTools: [],
  rawLogPath: null,
};

function capturingAgent(seen: AgentStartInput[]): ImplementationAgent {
  return {
    id: 'claude-code',
    label: 'Env Capturing Agent',
    async checkAvailability() {
      return { available: true, detail: 'fake agent', version: 'test' };
    },
    async startRun(input) {
      seen.push(input);
      fs.writeFileSync(path.join(input.worktreePath, 'agent.txt'), 'written\n');
      return fakeOutcome;
    },
    async continueRun(input) {
      seen.push(input);
      return fakeOutcome;
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
  const deadline = Date.now() + 20_000;
  while (orchestrator.isRunActive(runId)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for run ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the orchestrator hands the project env to the agent', () => {
  it('passes parsed project env on an implementation iteration', async () => {
    const project = await projectsService.createProject({
      name: 'agent-env',
      repositoryPath: makeRepo('agent-env'),
      env: ['DATABASE_URL=postgres://localhost/scratch_run', '# a comment', 'FEATURE_FLAG=on'],
    });
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Write a marker file',
      mode: 'build',
    });

    const seen: AgentStartInput[] = [];
    const restore = orchestrator.registerAgent(capturingAgent(seen));
    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.env).toEqual({
      DATABASE_URL: 'postgres://localhost/scratch_run',
      FEATURE_FLAG: 'on',
    });
  });

  it('resolves per-run tokens for the agent, validation and operational commands', async () => {
    const printUrl = 'node -e "console.log(process.env.DATABASE_URL)"';
    // Outside the repository, so recording it never dirties a checkout.
    const setupLog = path.join(dataDir, 'agent-env-tokens-setup.log');
    const project = await projectsService.createProject({
      name: 'agent-env-tokens',
      repositoryPath: makeRepo('agent-env-tokens'),
      setupCommand:
        'node -e "require(\'fs\').appendFileSync(process.env.SETUP_LOG, process.env.DATABASE_URL + \'\\n\')"',
      env: ['DATABASE_URL=postgres://localhost/app_{runId}_{worktree}', `SETUP_LOG=${setupLog}`],
      validationSteps: [
        {
          key: 'db-url',
          label: 'Print database URL',
          command: printUrl,
          env: ['DATABASE_URL=postgres://localhost/check_{runId}_{worktree}'],
        },
      ],
    });
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Write a marker file',
      mode: 'build',
    });

    const seen: AgentStartInput[] = [];
    const restore = orchestrator.registerAgent(capturingAgent(seen));
    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    const runId = created.id;
    expect(seen[0]?.env?.DATABASE_URL).toBe(`postgres://localhost/app_${runId}_run`);

    const step = runsService.latestValidationAttempt(runId).find((r) => r.stepKey === 'db-url');
    expect(step?.stdout?.trim()).toBe(`postgres://localhost/check_${runId}_run`);

    const opsService = await import('@/services/operational-commands');
    const scratch = opsService.createOperationalCommand(project.id, {
      label: 'Print scratch URL',
      command: printUrl,
      target: 'non_production',
    });
    const scratchRun = await opsService.runOperationalCommand(scratch.id, {
      runId,
      confirmed: true,
    });
    expect(scratchRun.stdout?.trim()).toBe(`postgres://localhost/app_${runId}_run`);

    // Production has no run to name. A token left in place fails loudly as an
    // unknown database, which beats resolving it to something plausible.
    const production = opsService.createOperationalCommand(project.id, {
      label: 'Print production URL',
      command: printUrl,
      target: 'production',
    });
    const productionRun = await opsService.runOperationalCommand(production.id, {
      confirmed: true,
    });
    expect(productionRun.stdout?.trim()).toBe('postgres://localhost/app_{runId}_{worktree}');

    // Landing merges the target branch in, so it gets a database of its own.
    await orchestrator.approveRun(runId);
    orchestrator.landRun(runId);
    await waitForIdle(runId);
    expect(runsService.requireRun(runId).status).toBe('LANDED');

    const landingStep = runsService
      .latestValidationAttempt(runId)
      .find((r) => r.stepKey === 'db-url');
    expect(landingStep?.stdout?.trim()).toBe(`postgres://localhost/check_${runId}_landing`);

    expect(fs.readFileSync(setupLog, 'utf8').trim().split(/\r?\n/)).toEqual([
      `postgres://localhost/app_${runId}_run`,
      `postgres://localhost/app_${runId}_landing`,
    ]);
  });
});
