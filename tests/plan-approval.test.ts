import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentOutcome, AgentStartInput, ImplementationAgent } from '@/agents/types';
import { isLandableStatus } from '@/domain/types';

/**
 * Approving a plan, then building it, driven through the real orchestrator.
 *
 * This is the path that had no test and broke silently: a Plan run has nothing
 * to land, so approving it left `APPROVED` as a state no action could leave.
 * The only button remaining was a forced restart, which discards the worktree,
 * the agent session and the plan that was just approved.
 *
 * Real SQLite and real git worktrees; only the implementation agent is faked,
 * because these paths must not need tokens to prove.
 */

let dataDir: string;
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let closeDb: typeof import('@/db/client').closeDb;

const author = { name: 'Test', email: 'test@example.com' };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-plan-approval-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
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
  git(['config', 'user.email', author.email], repo);
  git(['config', 'user.name', author.name], repo);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'initial commit'], repo);
  return repo;
}

/** A project whose only check passes once the agent has written something. */
async function makeProject(name: string) {
  return projectsService.createProject({
    name,
    repositoryPath: makeRepo(name),
    validationCommands: [
      {
        kind: 'unit',
        command:
          'node -e "const fs=require(\'fs\'); if(!fs.existsSync(\'agent.txt\')) process.exit(1)"',
      },
    ],
  });
}

function outcome(overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    ok: true,
    sessionId: 'sess-plan-fake',
    exitCode: 0,
    finalText: '# Plan\n\n1. Add a marker file.\n',
    numTurns: 1,
    durationMs: 5,
    costUsd: 0.25,
    errorMessage: null,
    cancelled: false,
    timedOut: false,
    deniedTools: [],
    rawLogPath: null,
    ...overrides,
  };
}

interface AgentCall {
  method: 'startRun' | 'continueRun';
  prompt: string;
  sessionId: string | null;
  /** Optional on the boundary; the orchestrator always supplies it. */
  permissionMode: string | undefined;
}

/**
 * Records what the orchestrator asked of the agent.
 *
 * `startRun` versus `continueRun` is the observable difference between
 * building an approved plan and starting over, so it is captured rather than
 * inferred from the run row afterwards.
 */
function recordingAgent(options: {
  calls: AgentCall[];
  edit?: (input: AgentStartInput) => void | Promise<void>;
}): ImplementationAgent {
  const record = (
    method: AgentCall['method'],
    input: AgentStartInput,
    sessionId: string | null,
  ) => {
    options.calls.push({
      method,
      prompt: input.prompt,
      sessionId,
      permissionMode: input.permissionMode,
    });
  };

  return {
    id: 'claude-code',
    label: 'Recording Agent',
    async checkAvailability() {
      return { available: true, detail: 'fake agent', version: 'test' };
    },
    async startRun(input) {
      record('startRun', input, null);
      await options.edit?.(input);
      return outcome();
    },
    async continueRun(input) {
      record('continueRun', input, input.sessionId);
      await options.edit?.(input);
      return outcome({ finalText: 'Wrote the marker file the plan asked for.' });
    },
    async cancelRun() {
      return false;
    },
    getStatus(iterationId) {
      return { running: false, iterationId, pid: null, startedAt: null, sessionId: null };
    },
  };
}

const writeAgentFile = (input: AgentStartInput) => {
  fs.writeFileSync(path.join(input.worktreePath, 'agent.txt'), 'written by the agent\n');
};

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForIdle(runId: string): Promise<void> {
  await waitFor(() => !orchestrator.isRunActive(runId), `run ${runId} to go idle`);
}

/** Runs a Plan-mode run to its verdict with an agent that changes nothing. */
async function planToVerdict(name: string) {
  const project = await makeProject(name);
  const created = runsService.createRun({
    projectId: project.id,
    request: `Plan how to add a marker file for ${name}`,
    mode: 'plan',
  });
  const calls: AgentCall[] = [];

  // No `edit`: a Plan run that touches the worktree has broken the promise the
  // mode makes, and readiness would say so.
  const restore = orchestrator.registerAgent(recordingAgent({ calls }));
  try {
    orchestrator.startRun(created.id);
    await waitForIdle(created.id);
  } finally {
    restore();
  }

  return { project, runId: created.id, calls };
}

describe('building an approved plan', () => {
  it('reaches a verdict on a plan without changing anything', async () => {
    const { runId, calls } = await planToVerdict('plan-verdict');

    const run = runsService.requireRun(runId);
    expect(run.status).toBe('READY');
    expect(run.resolvedMode).toBe('plan');
    expect(run.changedFiles).toHaveLength(0);
    // The mode can only take capability away, so Claude Code's own plan
    // permission mode is forced regardless of the project's setting.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.permissionMode).toBe('plan');
  });

  it('lets an approved plan be implemented on the same worktree and session', async () => {
    const { runId } = await planToVerdict('plan-approve-build');

    const planned = runsService.requireRun(runId);
    expect(planned.status).toBe('READY');
    const plannedWorktree = planned.worktreePath;
    const plannedBranch = planned.branch;
    const plannedSession = planned.agentSessionId;
    expect(plannedWorktree).not.toBeNull();
    expect(plannedSession).not.toBeNull();

    // A plan has nothing to commit: its output is an artifact.
    const approved = await orchestrator.approveRun(runId, {
      createCommit: false,
      note: 'Plan looks right.',
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.disposition).toBe('approved');

    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(recordingAgent({ calls, edit: writeAgentFile }));
    try {
      // This is what "Implement this plan" posts. Before the APPROVED row of
      // the transition table was opened it threw
      // `Illegal run transition APPROVED -> IMPLEMENTING`.
      orchestrator.requestChanges(runId, 'Implement the plan you wrote, in full.', {
        mode: 'build',
      });
      await waitForIdle(runId);
    } finally {
      restore();
    }

    const built = runsService.requireRun(runId);
    expect(built.status).toBe('READY');
    // `mode` records what was asked for and is never rewritten; `resolvedMode`
    // records what is executing.
    expect(built.mode).toBe('plan');
    expect(built.resolvedMode).toBe('build');
    // The plan was not discarded: same worktree, same branch, same session.
    expect(built.worktreePath).toBe(plannedWorktree);
    expect(built.branch).toBe(plannedBranch);
    expect(built.agentSessionId).toBe(plannedSession);
    expect(built.changedFiles.length).toBeGreaterThan(0);

    // The session was resumed rather than started cold, which is the whole
    // reason this is not a forced restart.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('continueRun');
    expect(calls[0]?.sessionId).toBe(plannedSession);
    // Build mode can write, so the plan permission mode is no longer forced.
    expect(calls[0]?.permissionMode).not.toBe('plan');

    const iterations = built.iterations;
    expect(iterations).toHaveLength(2);
    expect(iterations[1]?.kind).toBe('change_request');
    expect(iterations[1]?.resumed).toBe(true);

    const types = eventsService.listEvents(runId).map((event) => event.type);
    expect(types).toContain('run.approved');
    expect(types).toContain('run.mode_switched');
  });

  it('does not carry the plan approval over to the code it produced', async () => {
    const { runId } = await planToVerdict('plan-approval-superseded');

    await orchestrator.approveRun(runId, { createCommit: false });
    expect(runsService.requireRun(runId).disposition).toBe('approved');

    const restore = orchestrator.registerAgent(
      recordingAgent({ calls: [], edit: writeAgentFile }),
    );
    try {
      orchestrator.requestChanges(runId, 'Implement the plan you wrote, in full.', {
        mode: 'build',
      });
      await waitForIdle(runId);
    } finally {
      restore();
    }

    // The approval described the plan. The build that followed it is new work,
    // and nobody has approved that yet.
    const built = runsService.requireRun(runId);
    expect(built.disposition).toBeNull();
    expect(built.dispositionNote).toBeNull();

    // Which is what stops a later cancellation reading as landable:
    // `isLandableStatus` treats CANCELLED plus an approval as a merge still
    // owed on the target branch.
    runsService.setStatus(runId, 'CANCELLED', { reason: 'test', finished: true });
    const cancelled = runsService.requireRun(runId);
    expect(isLandableStatus(cancelled.status, cancelled.disposition)).toBe(false);
  });
});
