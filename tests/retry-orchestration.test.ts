import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentOutcome, AgentStartInput, ImplementationAgent } from '@/agents/types';

/**
 * Retry and restart driven through the real orchestrator.
 *
 * Real SQLite, real git worktrees, real child processes for validation; only
 * the implementation agent is faked, because spending tokens is the one thing
 * these paths must not need. What is being proved is the part the planner
 * cannot: that a resumed run picks up where it stopped without redoing
 * finished phases, that a retried iteration re-issues the same prompt, and that
 * a forced restart genuinely removes a worktree and rebuilds it.
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-retry-'));
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

/** A project whose only check passes as long as the agent wrote something. */
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
    sessionId: 'sess-fake',
    exitCode: 0,
    finalText: 'Fake agent wrote the file.',
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

function capacityOutcome(provider = 'Claude Code'): AgentOutcome {
  return outcome({
    ok: false,
    sessionId: null,
    exitCode: 1,
    finalText: null,
    costUsd: null,
    errorMessage: `${provider} usage limit reached. Your limit will reset in 2 hours.`,
  });
}

interface AgentCall {
  method: 'startRun' | 'continueRun';
  prompt: string;
  sessionId: string | null;
  model: string | null;
}

/**
 * Records what the orchestrator asked of the agent.
 *
 * The prompts and the choice of `startRun` versus `continueRun` are the whole
 * observable difference between the three actions, so they are captured rather
 * than inferred from the run row afterwards.
 */
function recordingAgent(options: {
  id?: string;
  label?: string;
  available?: boolean;
  calls: AgentCall[];
  edit?: (input: AgentStartInput) => void | Promise<void>;
  result?: (call: number) => AgentOutcome;
}): ImplementationAgent {
  return {
    id: options.id ?? 'claude-code',
    label: options.label ?? 'Recording Agent',
    async checkAvailability() {
      return options.available === false
        ? { available: false, detail: 'not installed in test', version: null }
        : { available: true, detail: 'fake agent', version: 'test' };
    },
    async startRun(input) {
      options.calls.push({
        method: 'startRun',
        prompt: input.prompt,
        sessionId: null,
        model: input.model ?? null,
      });
      await options.edit?.(input);
      return options.result?.(options.calls.length) ?? outcome();
    },
    async continueRun(input) {
      options.calls.push({
        method: 'continueRun',
        prompt: input.prompt,
        sessionId: input.sessionId,
        model: input.model ?? null,
      });
      await options.edit?.(input);
      return options.result?.(options.calls.length) ?? outcome();
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

async function waitForIdle(runId: string): Promise<void> {
  await waitFor(() => !orchestrator.isRunActive(runId), `run ${runId} to go idle`);
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs a project's first pass to completion with a working fake agent. */
async function runToCompletion(name: string) {
  const project = await makeProject(name);
  const run = runsService.createRun({
    projectId: project.id,
    request: `Add a marker file for ${name}`,
  });
  const calls: AgentCall[] = [];

  const restore = orchestrator.registerAgent(
    recordingAgent({ calls, edit: writeAgentFile }),
  );
  try {
    orchestrator.startRun(run.id);
    await waitForIdle(run.id);
  } finally {
    restore();
  }

  return { project, runId: run.id, calls };
}

describe('selecting implementation agents', () => {
  it('uses the selected implementation agent and model for a new run', async () => {
    const project = await makeProject('selected-agent-new-run');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
      agentProvider: 'codex-code',
      agentModel: 'gpt-5-codex',
    });
    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({
        id: 'codex-code',
        label: 'Codex CLI',
        calls,
        edit: writeAgentFile,
        result: () => outcome({ sessionId: 'sess-codex-selected' }),
      }),
    );

    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('startRun');
    expect(calls[0]?.model).toBe('gpt-5-codex');

    const completed = runsService.requireRun(created.id);
    expect(completed.status).toBe('READY');
    expect(completed.agentProvider).toBe('codex-code');
    expect(completed.agentModel).toBe('gpt-5-codex');
    expect(completed.agentSessionId).toBe('sess-codex-selected');
  });

  it('keeps the session when only the model changes on the same provider', async () => {
    const { runId } = await runToCompletion('selected-agent-same-provider');
    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({ calls, edit: writeAgentFile }),
    );

    try {
      orchestrator.requestChanges(runId, 'Try the follow-up with the stronger model.', {
        agentModel: 'claude-opus-4.1',
      });
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('continueRun');
    expect(calls[0]?.sessionId).toBe('sess-fake');
    expect(calls[0]?.model).toBe('claude-opus-4.1');

    const completed = runsService.requireRun(runId);
    expect(completed.status).toBe('READY');
    expect(completed.agentProvider).toBe('claude-code');
    expect(completed.agentModel).toBe('claude-opus-4.1');
    expect(completed.agentSessionId).toBe('sess-fake');

    const change = eventsService
      .listEvents(runId)
      .filter((event) => event.type === 'run.agent_changed')
      .at(-1);
    expect(change?.payload).toMatchObject({
      fromProvider: 'claude-code',
      toProvider: 'claude-code',
      fromModel: null,
      toModel: 'claude-opus-4.1',
      sessionCleared: false,
    });
  });

  it('starts cold when the next pass switches implementation provider', async () => {
    const { runId } = await runToCompletion('selected-agent-new-provider');
    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({
        id: 'codex-code',
        label: 'Codex CLI',
        calls,
        edit: writeAgentFile,
        result: () => outcome({ sessionId: 'sess-codex-switch' }),
      }),
    );

    try {
      orchestrator.requestChanges(runId, 'Try this follow-up with Codex.', {
        agentProvider: 'codex-code',
        agentModel: 'gpt-5-codex',
      });
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('startRun');
    expect(calls[0]?.sessionId).toBeNull();
    expect(calls[0]?.model).toBe('gpt-5-codex');

    const completed = runsService.requireRun(runId);
    expect(completed.status).toBe('READY');
    expect(completed.agentProvider).toBe('codex-code');
    expect(completed.agentModel).toBe('gpt-5-codex');
    expect(completed.agentSessionId).toBe('sess-codex-switch');

    const change = eventsService
      .listEvents(runId)
      .filter((event) => event.type === 'run.agent_changed')
      .at(-1);
    expect(change?.payload).toMatchObject({
      fromProvider: 'claude-code',
      toProvider: 'codex-code',
      fromModel: null,
      toModel: 'gpt-5-codex',
      sessionCleared: true,
    });
  });
});

describe('retrying a failed run', () => {
  it('resumes at the agent pass when the agent never ran', async () => {
    const project = await makeProject('retry-implement');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });

    // An unavailable agent fails the run after the worktree is prepared, which
    // is exactly the state a retry should resume from rather than rebuild.
    const failing = orchestrator.registerAgent(recordingAgent({ available: false, calls: [] }));
    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      failing();
    }

    const failed = runsService.requireRun(created.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.worktreePath).not.toBeNull();
    expect(failed.iterations).toHaveLength(0);

    const worktreePath = failed.worktreePath!;
    const calls: AgentCall[] = [];
    const working = orchestrator.registerAgent(
      recordingAgent({ calls, edit: writeAgentFile }),
    );
    let plan: ReturnType<typeof orchestrator.retryRun>;
    try {
      plan = orchestrator.retryRun(created.id);
      await waitForIdle(created.id);
    } finally {
      working();
    }

    expect(plan.stage).toBe('implement');

    const retried = runsService.requireRun(created.id);
    expect(retried.status).toBe('READY');
    // The same worktree and the same branch: a retry resumes, it does not
    // rebuild.
    expect(retried.worktreePath).toBe(worktreePath);
    expect(retried.branch).toBe(failed.branch);
    expect(retried.iterations).toHaveLength(1);
    expect(retried.iterations[0]?.kind).toBe('retry');

    // No session existed, so the agent had to start cold rather than resume.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('startRun');

    const types = eventsService.listEvents(created.id).map((event) => event.type);
    expect(types).toContain('run.retried');
  });

  it('falls back to Codex CLI when the preferred agent is out of capacity', async () => {
    const project = await makeProject('capacity-fallback');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });

    const claudeCalls: AgentCall[] = [];
    const codexCalls: AgentCall[] = [];
    const restoreClaude = orchestrator.registerAgent(
      recordingAgent({
        calls: claudeCalls,
        result: () => capacityOutcome('Claude Code'),
      }),
    );
    const restoreCodex = orchestrator.registerAgent(
      recordingAgent({
        id: 'codex-code',
        label: 'Codex CLI',
        calls: codexCalls,
        edit: writeAgentFile,
        result: () =>
          outcome({
            sessionId: 'sess-codex',
            finalText: 'Codex wrote the file.',
            costUsd: null,
          }),
      }),
    );

    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restoreCodex();
      restoreClaude();
    }

    expect(claudeCalls).toHaveLength(1);
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]?.method).toBe('startRun');

    const completed = runsService.requireRun(created.id);
    expect(completed.status).toBe('READY');
    expect(completed.agentProvider).toBe('codex-code');
    expect(completed.agentSessionId).toBe('sess-codex');
    expect(completed.iterations.map((iteration) => iteration.status)).toEqual([
      'failed',
      'completed',
    ]);
    expect(fs.existsSync(path.join(completed.worktreePath!, 'agent.txt'))).toBe(true);

    const types = eventsService.listEvents(created.id).map((event) => event.type);
    expect(types).toContain('agent.fallback_started');
    expect(types).toContain('agent.completed');
    expect(types).not.toContain('run.paused');
  });

  it('pauses and later retries when every implementation agent is out of capacity', async () => {
    const project = await makeProject('capacity-paused');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });

    const exhaustedClaude = orchestrator.registerAgent(
      recordingAgent({
        calls: [],
        result: () => capacityOutcome('Claude Code'),
      }),
    );
    const exhaustedCodex = orchestrator.registerAgent(
      recordingAgent({
        id: 'codex-code',
        label: 'Codex CLI',
        calls: [],
        result: () => capacityOutcome('Codex CLI'),
      }),
    );

    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      exhaustedCodex();
      exhaustedClaude();
    }

    const paused = runsService.requireRun(created.id);
    expect(paused.status).toBe('PAUSED');
    expect(paused.error).toContain('provider limits refresh');
    expect(paused.worktreePath).not.toBeNull();
    expect(paused.iterations.map((iteration) => iteration.status)).toEqual([
      'failed',
      'failed',
    ]);

    const pausedEvents = eventsService.listEvents(created.id);
    expect(pausedEvents.map((event) => event.type)).toContain('run.paused');
    expect(pausedEvents.map((event) => event.type)).not.toContain('run.failed');

    const retryClaude = orchestrator.registerAgent(
      recordingAgent({
        calls: [],
        result: () => capacityOutcome('Claude Code'),
      }),
    );
    const retryCodexCalls: AgentCall[] = [];
    const retryCodex = orchestrator.registerAgent(
      recordingAgent({
        id: 'codex-code',
        label: 'Codex CLI',
        calls: retryCodexCalls,
        edit: writeAgentFile,
        result: () =>
          outcome({
            sessionId: 'sess-codex-retry',
            finalText: 'Codex retried after capacity refreshed.',
            costUsd: null,
          }),
      }),
    );

    let plan: ReturnType<typeof orchestrator.retryRun>;
    try {
      plan = orchestrator.retryRun(created.id);
      await waitForIdle(created.id);
    } finally {
      retryCodex();
      retryClaude();
    }

    expect(plan.stage).toBe('implement');
    expect(retryCodexCalls).toHaveLength(1);

    const retried = runsService.requireRun(created.id);
    expect(retried.status).toBe('READY');
    expect(retried.error).toBeNull();
    expect(retried.agentProvider).toBe('codex-code');
    expect(retried.iterations.at(-1)?.status).toBe('completed');
  });

  it('resumes at validation without running the agent again', async () => {
    const { runId, project } = await runToCompletion('retry-validate');
    expect(runsService.requireRun(runId).status).toBe('READY');

    const attemptsBefore = runsService.requireRun(runId).validations.length;

    // The run was stopped after its agent pass finished. Re-running the agent
    // would redo work that succeeded and spend another pass on the same
    // instruction, so the retry has to pick up after it.
    runsService.setStatus(runId, 'CANCELLED', { reason: 'test', finished: true });

    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(recordingAgent({ calls }));
    let plan: ReturnType<typeof orchestrator.retryRun>;
    try {
      plan = orchestrator.retryRun(runId);
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(plan.stage).toBe('validate');
    expect(calls).toHaveLength(0);

    const retried = runsService.requireRun(runId);
    expect(retried.status).toBe('READY');
    expect(retried.error).toBeNull();
    expect(retried.iterations).toHaveLength(1);
    // A fresh validation attempt, and the project's check really ran.
    expect(retried.validations.length).toBeGreaterThan(attemptsBefore);
    const attempt = Math.max(...retried.validations.map((v) => v.attempt));
    expect(attempt).toBe(2);
    expect(
      retried.validations.find((v) => v.attempt === attempt && v.kind === 'unit')?.outcome,
    ).toBe('pass');
    expect(project.id).toBe(retried.projectId);
  });

  it('reuses a recorded specification instead of paying for it twice', async () => {
    const project = await makeProject('retry-spec');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });
    // Stands in for a transformer that ran before the failure.
    runsService.updateRunFields(created.id, { spec: '# Spec\nWritten once.', specProvider: 'test' });
    runsService.setStatus(created.id, 'FAILED', { reason: 'test', error: 'failed at prepare' });

    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({ calls, edit: writeAgentFile }),
    );
    let plan: ReturnType<typeof orchestrator.retryRun>;
    try {
      plan = orchestrator.retryRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    expect(plan.stage).toBe('prepare');
    const retried = runsService.requireRun(created.id);
    expect(retried.status).toBe('READY');
    expect(retried.spec).toBe('# Spec\nWritten once.');

    const skipped = eventsService
      .listEvents(created.id)
      .filter((event) => event.type === 'transform.skipped');
    expect(skipped.at(-1)?.message).toContain('already recorded');
  });

  it('resumes a stopped Plan run at the verdict, which runs no checks', async () => {
    // A read-only run has nothing to validate, so "Re-run validation" refuses
    // it. A retry must not: re-reading the worktree and reaching the verdict
    // again is real work, and refusing would leave a full restart as the only
    // way forward.
    const project = await makeProject('retry-plan-verdict');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Write a plan for the marker file.',
      mode: 'plan',
    });

    const restore = orchestrator.registerAgent(recordingAgent({ calls: [] }));
    try {
      orchestrator.startRun(created.id);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    expect(runsService.requireRun(created.id).status).toBe('READY');
    runsService.setStatus(created.id, 'CANCELLED', { reason: 'test', finished: true });

    const calls: AgentCall[] = [];
    const retryAgent = orchestrator.registerAgent(recordingAgent({ calls }));
    let plan: ReturnType<typeof orchestrator.retryRun>;
    try {
      plan = orchestrator.retryRun(created.id);
      await waitForIdle(created.id);
    } finally {
      retryAgent();
    }

    expect(plan.stage).toBe('validate');
    expect(calls).toHaveLength(0);
    expect(runsService.requireRun(created.id).status).toBe('READY');

    const types = eventsService.listEvents(created.id).map((event) => event.type);
    expect(types).toContain('validation.skipped');
  });

  it('refuses to retry while work is in flight', async () => {
    const project = await makeProject('retry-busy');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });

    let invocations = 0;
    const blocking: ImplementationAgent = {
      ...recordingAgent({ calls: [] }),
      async startRun(input) {
        invocations += 1;
        const { signal } = input;
        if (!signal) throw new Error('the orchestrator must pass an abort signal');
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return outcome({ ok: false, cancelled: true, finalText: null, costUsd: null });
      },
    };

    const restore = orchestrator.registerAgent(blocking);
    try {
      orchestrator.startRun(created.id);
      await waitFor(() => invocations === 1, 'the agent to start');

      // Cancel is the honest action here, and it already exists. A retry that
      // silently killed a working agent would be a cancel in disguise.
      expect(() => orchestrator.retryRun(created.id)).toThrow(/already in progress/);
      expect(() => orchestrator.retryIteration(created.id)).toThrow(/already in progress/);

      orchestrator.cancelRun(created.id, 'test cleanup');
      await waitForIdle(created.id);
    } finally {
      restore();
    }
  });

  it('refuses to retry a run that reached a verdict', async () => {
    const { runId } = await runToCompletion('retry-refuse');

    expect(runsService.requireRun(runId).status).toBe('READY');
    expect(() => orchestrator.retryRun(runId)).toThrow(/nothing to retry/);
  });
});

describe('retrying the current iteration', () => {
  it('re-issues the same prompt on the recorded session', async () => {
    const { runId, calls } = await runToCompletion('retry-iteration');
    const first = runsService.requireRun(runId);
    const originalPrompt = first.iterations[0]?.prompt;

    expect(calls).toHaveLength(1);
    expect(originalPrompt).toBeTruthy();

    const retryCalls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({ calls: retryCalls, edit: writeAgentFile }),
    );
    let result: ReturnType<typeof orchestrator.retryIteration>;
    try {
      result = orchestrator.retryIteration(runId);
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(result).toEqual({ ordinal: 1, resuming: true });
    expect(retryCalls).toHaveLength(1);
    // The instruction is not what is being changed, the attempt at it is.
    expect(retryCalls[0]?.prompt).toBe(originalPrompt);
    // A session was recorded, so the second attempt starts knowing what the
    // first one wrote.
    expect(retryCalls[0]?.method).toBe('continueRun');
    expect(retryCalls[0]?.sessionId).toBe('sess-fake');

    const after = runsService.requireRun(runId);
    expect(after.iterations).toHaveLength(2);
    expect(after.iterations[1]?.kind).toBe('retry');
    expect(after.iterations[1]?.resumed).toBe(true);
    expect(after.iterations[1]?.prompt).toBe(originalPrompt);
    // The original row is untouched: a retry appends to the record.
    expect(after.iterations[0]?.kind).toBe('initial');
  });

  it('can re-issue the prompt with a different provider and model', async () => {
    const { runId } = await runToCompletion('retry-iteration-agent-switch');
    const retryCalls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({
        id: 'codex-code',
        label: 'Codex CLI',
        calls: retryCalls,
        edit: writeAgentFile,
        result: () => outcome({ sessionId: 'sess-codex-retry-iteration' }),
      }),
    );
    let result: ReturnType<typeof orchestrator.retryIteration>;

    try {
      result = orchestrator.retryIteration(runId, {
        agentProvider: 'codex-code',
        agentModel: 'gpt-5-codex',
      });
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(result).toEqual({ ordinal: 1, resuming: false });
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]?.method).toBe('startRun');
    expect(retryCalls[0]?.sessionId).toBeNull();
    expect(retryCalls[0]?.model).toBe('gpt-5-codex');

    const after = runsService.requireRun(runId);
    expect(after.status).toBe('READY');
    expect(after.agentProvider).toBe('codex-code');
    expect(after.agentModel).toBe('gpt-5-codex');
    expect(after.agentSessionId).toBe('sess-codex-retry-iteration');
  });

  it('rolls the cost of the retry into the run rather than replacing it', async () => {
    const { runId } = await runToCompletion('retry-cost');
    expect(runsService.requireRun(runId).costUsd).toBeCloseTo(0.25);

    const restore = orchestrator.registerAgent(
      recordingAgent({ calls: [], edit: writeAgentFile }),
    );
    try {
      orchestrator.retryIteration(runId);
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(runsService.requireRun(runId).costUsd).toBeCloseTo(0.5);
  });

  it('refuses when there is no recorded agent pass to re-run', async () => {
    const project = await makeProject('retry-iteration-none');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });
    runsService.setStatus(created.id, 'FAILED', { reason: 'test' });

    expect(() => orchestrator.retryIteration(created.id)).toThrow(/no worktree/);
  });
});

describe('forced restart', () => {
  it('discards the worktree and runs the whole pipeline again', async () => {
    const { runId } = await runToCompletion('restart-basic');
    const before = runsService.requireRun(runId);
    const originalWorktree = before.worktreePath!;

    expect(fs.existsSync(path.join(originalWorktree, 'agent.txt'))).toBe(true);
    expect(before.agentSessionId).toBe('sess-fake');
    expect(before.changedFiles.length).toBeGreaterThan(0);

    const calls: AgentCall[] = [];
    const restore = orchestrator.registerAgent(
      recordingAgent({ calls, edit: writeAgentFile }),
    );
    let result: Awaited<ReturnType<typeof orchestrator.restartRun>>;
    try {
      result = await orchestrator.restartRun(runId);
      await waitForIdle(runId);
    } finally {
      restore();
    }

    expect(result.worktreeRemoved).toBe(true);
    expect(result.stoppedActiveWork).toBe(false);
    expect(result.previousBranch).toBe(before.branch);

    const after = runsService.requireRun(runId);
    expect(after.status).toBe('READY');
    // A fresh worktree at the same path, rebuilt from the base branch: the
    // agent's marker only exists because the second pass wrote it again.
    expect(after.worktreePath).toBe(originalWorktree);
    expect(after.baseCommit).not.toBeNull();
    expect(fs.existsSync(path.join(originalWorktree, 'agent.txt'))).toBe(true);

    // Cold: a new session, and the initial prompt rather than a resumed one.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('startRun');
    expect(after.iterations).toHaveLength(2);
    expect(after.iterations[1]?.kind).toBe('initial');
    expect(after.iterations[1]?.resumed).toBe(false);

    const types = eventsService.listEvents(runId).map((event) => event.type);
    expect(types).toContain('run.restarted');
  });

  it('keeps the previous branch and its commits, taking the next free name', async () => {
    const { project, runId } = await runToCompletion('restart-branch');
    const before = runsService.requireRun(runId);
    const originalBranch = before.branch!;

    // A commit on the run branch is what makes reuse impossible: `git branch
    // -d` refuses it, and this project never reaches for `-D`.
    const worktreePath = before.worktreePath!;
    git(['add', '-A'], worktreePath);
    git(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-qm', 'agent work'], worktreePath);
    const originalSha = git(['rev-parse', originalBranch], project.repositoryPath).trim();

    const restore = orchestrator.registerAgent(
      recordingAgent({ calls: [], edit: writeAgentFile }),
    );
    try {
      await orchestrator.restartRun(runId);
      await waitForIdle(runId);
    } finally {
      restore();
    }

    const after = runsService.requireRun(runId);
    expect(after.branch).toBe(`${originalBranch}-r2`);
    // Nothing was deleted: the discarded attempt is still reachable.
    expect(git(['rev-parse', originalBranch], project.repositoryPath).trim()).toBe(originalSha);
  });

  it('resets derived state but keeps the record of what happened', async () => {
    const { runId } = await runToCompletion('restart-reset');
    const before = runsService.requireRun(runId);
    const eventsBefore = eventsService.listEvents(runId).length;

    // Approve first, so the reset has a disposition and a commit to clear.
    await orchestrator.approveRun(runId, { note: 'looks fine', createCommit: true });
    const approved = runsService.requireRun(runId);
    expect(approved.disposition).toBe('approved');
    expect(approved.commitSha).not.toBeNull();

    const restore = orchestrator.registerAgent(recordingAgent({ available: false, calls: [] }));
    try {
      await orchestrator.restartRun(runId);
      await waitForIdle(runId);
    } finally {
      restore();
    }

    // The unavailable agent leaves the restarted run failed, which is the
    // point: the reset is observable without a second successful pass.
    const after = runsService.requireRun(runId);
    expect(after.agentSessionId).toBeNull();
    expect(after.commitSha).toBeNull();
    expect(after.disposition).toBeNull();
    expect(after.dispositionNote).toBeNull();
    expect(after.changedFiles).toHaveLength(0);
    expect(after.spec).toBeNull();

    // Kept: the money really was spent, and the log is the run's history.
    expect(after.costUsd).toBeCloseTo(before.costUsd ?? 0);
    expect(after.iterations).toHaveLength(1);
    expect(eventsService.listEvents(runId).length).toBeGreaterThan(eventsBefore);
  });

  it('stops work in flight and waits for it before touching the worktree', async () => {
    const project = await makeProject('restart-live');
    const created = runsService.createRun({
      projectId: project.id,
      request: 'Add a marker file.',
    });

    // An agent that only returns once its signal is aborted, so the restart
    // has something real to stop rather than a race to win.
    let invocations = 0;
    const slowAgent: ImplementationAgent = {
      ...recordingAgent({ calls: [] }),
      async startRun(input) {
        invocations += 1;
        // Optional on the interface, but a run that could not be cancelled
        // would make this whole test meaningless, so it is asserted.
        const { signal } = input;
        if (!signal) throw new Error('the orchestrator must pass an abort signal');
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return outcome({ ok: false, cancelled: true, finalText: null, costUsd: null });
      },
    };

    const restore = orchestrator.registerAgent(slowAgent);
    try {
      orchestrator.startRun(created.id);
      await waitFor(() => invocations === 1, 'the agent to start');
      expect(orchestrator.isRunActive(created.id)).toBe(true);

      const result = await orchestrator.restartRun(created.id);
      expect(result.stoppedActiveWork).toBe(true);
      // `restartRun` only returns once the cancelled pass has let go of the
      // run, so the worktree it deleted was not in use.
      expect(runsService.requireRun(created.id).iterations[0]?.status).toBe('cancelled');

      // The restart starts a second pass, which this agent would block
      // forever. Stop it once it has demonstrably begun.
      await waitFor(() => invocations === 2, 'the restarted pass to start');
      expect(orchestrator.cancelRun(created.id, 'test cleanup')).toBe(true);
      await waitForIdle(created.id);
    } finally {
      restore();
    }

    const types = eventsService.listEvents(created.id).map((event) => event.type);
    expect(types).toContain('run.cancelled');
    expect(types).toContain('run.restarted');
    expect(runsService.requireRun(created.id).worktreePath).not.toBeNull();
  });

  it('refuses to restart a landed run', async () => {
    const { runId } = await runToCompletion('restart-refuse');
    runsService.setStatus(runId, 'APPROVED', { reason: 'test' });
    runsService.setStatus(runId, 'LANDING', { reason: 'test' });
    runsService.setStatus(runId, 'LANDED', { reason: 'test', finished: true });

    await expect(orchestrator.restartRun(runId)).rejects.toThrow(/cannot be restarted/);
  });
});
