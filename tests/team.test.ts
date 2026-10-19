import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultTeam, TEAM_ROLES, teamConfigSchema } from '@/domain/team';
import type { AgentOutcome, AgentStartInput, ImplementationAgent } from '@/agents/types';
import type { ClaudeQueryOptions } from '@/agents/claude-query';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/agents/claude-query', () => ({ claudeQuery: query }));

let dataDir: string;
let projects: typeof import('@/services/projects');
let runs: typeof import('@/services/runs');
let events: typeof import('@/services/events');
let teamService: typeof import('@/services/team');
let orchestrator: typeof import('@/orchestrator/orchestrator');
let closeDb: typeof import('@/db/client').closeDb;
let nextProject = 0;

const report = (summary = 'Evidence assessed; browser checks remain unverified.', findings: unknown[] = []) => ({
  ok: true, structured: { summary, findings }, text: null, costUsd: 0.01,
  durationMs: 10, error: null, exitCode: 0,
});
const defect = {
  severity: 'high', title: 'Missing edge case', detail: 'file.txt needs the requested marker.',
  file: 'file.txt', line: 1, suggestion: 'Add the marker.',
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-team-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;
  projects = await import('@/services/projects');
  runs = await import('@/services/runs');
  events = await import('@/services/events');
  teamService = await import('@/services/team');
  orchestrator = await import('@/orchestrator/orchestrator');
  ({ closeDb } = await import('@/db/client'));
});
beforeEach(() => { query.mockReset(); query.mockResolvedValue(report()); });
afterAll(() => {
  closeDb?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

async function makeProject() {
  const repo = path.join(dataDir, `repo-${++nextProject}`);
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A']); git(['commit', '-qm', 'initial']);
  return projects.createProject({
    name: `Team test ${nextProject}`, repositoryPath: repo, team: defaultTeam(),
    requireValidation: false, agentModel: 'project-model-must-not-override-team',
  });
}

function fakeEngineer(calls: AgentStartInput[], edit = true): ImplementationAgent {
  const execute = async (input: AgentStartInput): Promise<AgentOutcome> => {
    calls.push(input);
    if (edit) fs.appendFileSync(path.join(input.worktreePath, 'file.txt'), 'marker\n');
    await input.onEvent({ kind: 'text', text: 'Implementing the marker.' });
    return {
      ok: true, sessionId: 'test-session', exitCode: 0, finalText: 'Added the marker; review the recorded checks.',
      numTurns: 1, durationMs: 5, costUsd: 0.02, usage: null, errorMessage: null,
      cancelled: false, timedOut: false, deniedTools: [], rawLogPath: null,
    };
  };
  return {
    id: 'claude-code', label: 'Test engineer',
    checkAvailability: async () => ({ available: true, detail: 'test', version: null }),
    startRun: execute, continueRun: execute, cancelRun: async () => true,
    getStatus: (iterationId) => ({ running: false, iterationId, pid: null, startedAt: null, sessionId: null }),
  };
}
async function idle(runId: string) {
  const deadline = Date.now() + 90_000;
  while (orchestrator.isRunActive(runId)) {
    if (Date.now() > deadline) throw new Error('Team run did not stop');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return runs.requireRun(runId);
}
async function executeRun(input: Parameters<typeof runs.createRun>[0], calls: AgentStartInput[]) {
  const run = runs.createRun(input);
  const restore = orchestrator.registerAgent(fakeEngineer(calls));
  try { orchestrator.startRun(run.id); return await idle(run.id); }
  finally { restore(); }
}

describe('engineering team', () => {
  it('requires six valid role configurations and preserves a run snapshot', async () => {
    const invalid = defaultTeam();
    delete (invalid.members as Partial<typeof invalid.members>)['ux-qa'];
    expect(teamConfigSchema.safeParse(invalid).success).toBe(false);
    const project = await makeProject();
    const run = runs.createRun({ projectId: project.id, request: 'Add a marker', mode: 'build' });
    const changed = defaultTeam(); changed.members.lead.instructions = 'New project policy';
    projects.updateProject(project.id, { team: changed });
    expect(runs.requireRun(run.id).team?.members.lead.instructions).toBe('');
    expect(run.reviewAutoAddressMinSeverity).toBe('high');
    expect(run.agentModel).toBeNull();
    expect(runs.createRun({ projectId: project.id, request: 'Solo', team: null }).team).toBeNull();
  });

  it('hands lead and user context to the engineer and records all four independent reports', async () => {
    const project = await makeProject();
    const config = defaultTeam(); config.members.engineer.effort = 'low';
    const run = runs.createRun({ projectId: project.id, request: 'Add a marker', mode: 'build', team: config });
    teamService.teamActivity(run.id, { role: 'user', to: 'team', kind: 'message', text: 'Preserve the base line.' });
    query.mockImplementation(async (options: ClaudeQueryOptions) => report(options.systemPrompt?.includes('Tech lead') ? 'Keep the base line and add a marker.' : undefined));
    const calls: AgentStartInput[] = [];
    const restore = orchestrator.registerAgent(fakeEngineer(calls));
    let result;
    try { orchestrator.startRun(run.id); result = await idle(run.id); } finally { restore(); }
    expect(result.status, JSON.stringify({ reason: result.statusReason, team: !!result.team, queries: query.mock.calls.length, events: events.listEvents(result.id).filter((e) => e.type.startsWith('review.') || e.type.startsWith('team.') || e.type === 'run.failed').map((e) => e.message) })).toBe('READY');
    expect(query).toHaveBeenCalledTimes(5);
    expect(calls[0]!.prompt).toContain('Preserve the base line.');
    expect(calls[0]!.prompt).toContain('Keep the base line and add a marker.');
    expect(calls[0]!.model).toBeNull();
    expect(calls[0]!.effort).toBe('low');
    const roles = events.listEvents(run.id, { types: ['team.activity'] }).map((e) => (e.payload as { role: string }).role);
    for (const role of TEAM_ROLES) expect(roles).toContain(role);
    expect(result.teamReview?.iterationId).toBe(result.iterations.at(-1)?.id);
    expect(result.costUsd).toBeCloseTo(0.07);
    const qaPrompt = JSON.parse(query.mock.calls[2]![0].prompt);
    expect(qaPrompt.evidence.diff).toContain('+marker');
    expect(qaPrompt.conversation).toContain('Evidence assessed');
  });

  it('keeps functional QA defects even when the other QAs are clean and repairs them', async () => {
    const project = await makeProject();
    let functionalPass = 0;
    query.mockImplementation(async (options: ClaudeQueryOptions) => {
      if (options.systemPrompt?.includes('You are the Functional QA')) {
        functionalPass += 1;
        return report('Functional assessment', functionalPass === 1 ? [defect] : []);
      }
      return report();
    });
    const calls: AgentStartInput[] = [];
    const result = await executeRun({ projectId: project.id, request: 'Add a marker', mode: 'build' }, calls);
    expect(result.status, JSON.stringify({ reason: result.statusReason, team: !!result.team, queries: query.mock.calls.length, events: events.listEvents(result.id).filter((e) => e.type.startsWith('review.') || e.type.startsWith('team.') || e.type === 'run.failed').map((e) => e.message) })).toBe('READY');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('[Functional QA] Missing edge case');
    expect(result.findings.some((f) => f.title.includes('[Functional QA]'))).toBe(true);
    expect(result.findings.filter((f) => f.attempt === result.lastReviewAttempt)).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(10);
  });

  it('bounds automatic repair and leaves persistent team defects blocking', async () => {
    const project = await makeProject();
    query.mockImplementation(async (options: ClaudeQueryOptions) => report('Assessment', options.systemPrompt?.includes('You are the Functional QA') ? [defect] : []));
    const calls: AgentStartInput[] = [];
    const result = await executeRun({ projectId: project.id, request: 'Add a marker', mode: 'build' }, calls);
    expect(calls).toHaveLength(3);
    expect(result.status).toBe('NEEDS_CHANGES');
    expect(runs.assessReadiness(result, project).blockingFindings).toBe(1);
  });

  it('fails visibly on an unavailable teammate and cannot report a complete review', async () => {
    const project = await makeProject();
    query.mockImplementation(async (options: ClaudeQueryOptions) => options.systemPrompt?.includes('You are the Regression QA')
      ? { ...report(), ok: false, error: 'CLI unavailable' } : report());
    const result = await executeRun({ projectId: project.id, request: 'Add a marker', mode: 'build' }, []);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('CLI unavailable');
    expect(result.teamReview).toBeNull();
    expect(runs.assessReadiness(result, project).ready).toBe(false);
    expect(events.listEvents(result.id, { types: ['team.activity'] }).some((e) =>
      (e.payload as { kind: string }).kind === 'failed')).toBe(true);
    query.mockResolvedValue(report());
    orchestrator.retryRun(result.id);
    const retried = await idle(result.id);
    expect(retried.status).toBe('READY');
    expect(retried.teamReview).not.toBeNull();
  });

  it('stops an active teammate when the run is cancelled', async () => {
    const project = await makeProject();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    query.mockImplementation((options: ClaudeQueryOptions) => new Promise((resolve) => {
      markStarted();
      options.signal!.addEventListener('abort', () => resolve({ ...report(), ok: false, error: 'Cancelled' }), { once: true });
    }));
    const run = runs.createRun({ projectId: project.id, request: 'Add a marker', mode: 'build' });
    const calls: AgentStartInput[] = [];
    const restore = orchestrator.registerAgent(fakeEngineer(calls));
    try {
      orchestrator.startRun(run.id);
      await started;
      expect(orchestrator.cancelRun(run.id)).toBe(true);
      const result = await idle(run.id);
      expect(result.status).toBe('CANCELLED');
      expect(calls).toHaveLength(0);
      expect(events.listEvents(run.id, { types: ['team.activity'] }).at(-1)?.message).toContain('Stopped with the run');
    } finally { restore(); }
  });

  it('validates local direction messages and never starts a run when saving one', async () => {
    const { POST } = await import('@/app/api/runs/[runId]/team/messages/route');
    const project = await makeProject();
    const run = runs.createRun({ projectId: project.id, request: 'Add a marker', mode: 'build' });
    const send = (text: string, origin = 'http://127.0.0.1:4317') => POST(new Request(`http://127.0.0.1:4317/api/runs/${run.id}/team/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ text }),
    }), { params: Promise.resolve({ runId: run.id }) });
    expect((await send('   ')).status).toBe(400);
    expect((await send('Direction', 'https://example.com')).status).toBe(403);
    expect((await send('Preserve compatibility')).status).toBe(200);
    expect(teamService.teamConversation(run.id)).toContain('Preserve compatibility');
    expect(orchestrator.isRunActive(run.id)).toBe(false);
    expect(runs.requireRun(run.id).status).toBe('DRAFT');
    runs.setStatus(run.id, 'CANCELLED');
    runs.setStatus(run.id, 'REJECTED');
    expect((await send('Too late')).status).toBe(400);
  });

  it('does not launch the team for a read-only run', async () => {
    const project = await makeProject();
    const run = runs.createRun({ projectId: project.id, request: 'Explain the marker', mode: 'ask' });
    const restore = orchestrator.registerAgent(fakeEngineer([], false));
    try {
      orchestrator.startRun(run.id); const result = await idle(run.id);
      expect(result.status, JSON.stringify({ reason: result.statusReason, team: !!result.team, queries: query.mock.calls.length, events: events.listEvents(result.id).filter((e) => e.type.startsWith('review.') || e.type.startsWith('team.') || e.type === 'run.failed').map((e) => e.message) })).toBe('READY');
      expect(query).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});
