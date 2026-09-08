import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentStreamEvent } from '@/agents/types';

/**
 * Live test against the real Claude Code CLI.
 *
 * It spends real tokens, so it is opt-in: set DEV_COCKPIT_LIVE_AGENT_TESTS=1.
 * Everything it asserts is behaviour that cannot be established any other way —
 * that the adapter really drives the CLI, really captures a session id, and
 * really resumes that session with its context intact.
 */

const LIVE = process.env.DEV_COCKPIT_LIVE_AGENT_TESTS === '1';
const describeLive = LIVE ? describe : describe.skip;

let dataDir: string;
let repoDir: string;
let agentModule: typeof import('@/agents/claude-code');

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-live-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  repoDir = path.join(dataDir, 'artifacts', 'live-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repoDir, stdio: 'ignore', windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# live\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);

  agentModule = await import('@/agents/claude-code');
});

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Disposable temp directory.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

describe('ClaudeCodeAgent availability', () => {
  it('reports whether the CLI can actually be run, without throwing', async () => {
    const agent = new agentModule.ClaudeCodeAgent();
    const availability = await agent.checkAvailability();

    expect(typeof availability.available).toBe('boolean');
    expect(availability.detail.length).toBeGreaterThan(0);
    if (availability.available) {
      // The version string proves the resolver found something runnable.
      expect(availability.version).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it('reports a missing binary as unavailable rather than crashing', async () => {
    const original = process.env.DEV_COCKPIT_CLAUDE_BIN;
    process.env.DEV_COCKPIT_CLAUDE_BIN = 'claude-does-not-exist-zzz';
    try {
      const agent = new agentModule.ClaudeCodeAgent();
      const availability = await agent.checkAvailability();
      expect(availability.available).toBe(false);
      expect(availability.version).toBeNull();
      expect(availability.detail).toContain('claude-does-not-exist-zzz');
    } finally {
      if (original === undefined) delete process.env.DEV_COCKPIT_CLAUDE_BIN;
      else process.env.DEV_COCKPIT_CLAUDE_BIN = original;
    }
  });

  it('reports no running process for an unknown iteration', () => {
    const agent = new agentModule.ClaudeCodeAgent();
    const status = agent.getStatus('itr_nonexistent');
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it('returns false when cancelling an iteration it does not have', async () => {
    const agent = new agentModule.ClaudeCodeAgent();
    expect(await agent.cancelRun('itr_nonexistent')).toBe(false);
  });
});

describeLive('ClaudeCodeAgent live run', () => {
  it('implements a task, captures structured events and returns a session id', async () => {
    const agent = new agentModule.ClaudeCodeAgent();
    const worktree = path.join(dataDir, 'worktrees', 'live', 'run_live');
    fs.mkdirSync(worktree, { recursive: true });
    fs.copyFileSync(path.join(repoDir, 'README.md'), path.join(worktree, 'README.md'));

    const events: AgentStreamEvent[] = [];
    const outcome = await agent.startRun({
      runId: 'run_live',
      iterationId: 'itr_live_1',
      prompt:
        'Create a file named greeting.txt in the current directory containing exactly: hello from dev cockpit. Then stop.',
      worktreePath: worktree,
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'acceptEdits',
      timeoutMs: 5 * 60 * 1000,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(outcome.errorMessage).toBeNull();
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);

    // A session id must come back, or a change request could never resume.
    expect(outcome.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // The agent actually did the work.
    const created = path.join(worktree, 'greeting.txt');
    expect(fs.existsSync(created)).toBe(true);
    expect(fs.readFileSync(created, 'utf8')).toContain('hello from dev cockpit');

    // Events arrived as structured data, not as a terminal transcript.
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('session')).toBe(true);
    expect(kinds.has('tool_start')).toBe(true);
    expect(kinds.has('result')).toBe(true);

    const toolStarts = events.filter((e) => e.kind === 'tool_start');
    expect(toolStarts.length).toBeGreaterThan(0);

    // The raw stream was captured for the Logs tab.
    expect(outcome.rawLogPath).not.toBeNull();
    expect(fs.existsSync(outcome.rawLogPath!)).toBe(true);
    const log = fs.readFileSync(outcome.rawLogPath!, 'utf8');
    expect(log.split('\n').filter(Boolean).length).toBeGreaterThan(3);
    // Every retained line is JSON: the file is data, not screen output.
    for (const line of log.split('\n').filter(Boolean).slice(0, 5)) {
      if (line.startsWith('[stderr]')) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Cost and turn counts are recorded when the CLI reports them.
    expect(outcome.numTurns === null || outcome.numTurns > 0).toBe(true);
  }, 360_000);

  it('resumes the same session so the follow-up keeps its context', async () => {
    const agent = new agentModule.ClaudeCodeAgent();
    const worktree = path.join(dataDir, 'worktrees', 'live', 'run_resume');
    fs.mkdirSync(worktree, { recursive: true });

    const first = await agent.startRun({
      runId: 'run_resume',
      iterationId: 'itr_resume_1',
      prompt:
        'Create a file named notes.txt in the current directory whose only line is: first pass. Then stop.',
      worktreePath: worktree,
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'acceptEdits',
      timeoutMs: 5 * 60 * 1000,
      onEvent: () => {},
    });

    expect(first.ok).toBe(true);
    expect(first.sessionId).not.toBeNull();

    // The follow-up refers to "that file" without naming it: only a resumed
    // session can resolve that reference.
    const second = await agent.continueRun({
      runId: 'run_resume',
      iterationId: 'itr_resume_2',
      sessionId: first.sessionId!,
      prompt: 'Append a second line to that same file reading: second pass. Then stop.',
      worktreePath: worktree,
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'acceptEdits',
      timeoutMs: 5 * 60 * 1000,
      onEvent: () => {},
    });

    expect(second.errorMessage).toBeNull();
    expect(second.ok).toBe(true);
    // Resuming keeps the same session id, which is what the run row stores.
    expect(second.sessionId).toBe(first.sessionId);

    const contents = fs.readFileSync(path.join(worktree, 'notes.txt'), 'utf8');
    expect(contents).toContain('first pass');
    expect(contents).toContain('second pass');
  }, 420_000);

  it('cancels a running iteration and reports it as cancelled', async () => {
    const agent = new agentModule.ClaudeCodeAgent();
    const worktree = path.join(dataDir, 'worktrees', 'live', 'run_cancel');
    fs.mkdirSync(worktree, { recursive: true });

    const controller = new AbortController();
    const pending = agent.startRun({
      runId: 'run_cancel',
      iterationId: 'itr_cancel_1',
      prompt:
        'Count slowly from 1 to 500, writing each number to a separate file. Take your time.',
      worktreePath: worktree,
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'acceptEdits',
      timeoutMs: 5 * 60 * 1000,
      signal: controller.signal,
      onEvent: () => {},
    });

    // Give the process time to start before pulling the plug.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(agent.getStatus('itr_cancel_1').running).toBe(true);
    controller.abort();

    const outcome = await pending;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toBe('Cancelled');
    // The registry must not leak the finished process.
    expect(agent.getStatus('itr_cancel_1').running).toBe(false);
  }, 180_000);
});

describeLive('read-only providers', () => {
  it('runs a structured read-only query with no tools available', async () => {
    const { claudeQuery } = await import('@/agents/claude-query');
    const worktree = path.join(dataDir, 'worktrees', 'live', 'run_query');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'target.txt'), 'original content\n');

    const result = await claudeQuery({
      prompt: 'Reply with the sum of 2 and 2.',
      systemPrompt: 'Answer with a JSON object holding the numeric answer.',
      jsonSchema: {
        type: 'object',
        properties: { answer: { type: 'integer' } },
        required: ['answer'],
        additionalProperties: false,
      },
      model: 'sonnet',
      effort: 'low',
      cwd: worktree,
      timeoutMs: 180_000,
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect((result.structured as { answer: number }).answer).toBe(4);

    // Read-only means read-only: the working directory is untouched.
    expect(fs.readFileSync(path.join(worktree, 'target.txt'), 'utf8')).toBe('original content\n');
    expect(fs.readdirSync(worktree)).toEqual(['target.txt']);
  }, 240_000);

  it('produces a specification through the transformer provider', async () => {
    const { ClaudeCliTransformer } = await import('@/transformers/providers');
    const transformer = new ClaudeCliTransformer('sonnet', 'low');

    const result = await transformer.transformRequest({
      request: 'make the login page remember the email address between visits',
      projectName: 'live-test',
      configuredValidations: ['typecheck', 'unit'],
      profile: 'standard',
    });

    expect(result.provider).toBe('claude-cli');
    expect(result.spec.length).toBeGreaterThan(40);
    expect(result.title).toBeTruthy();
    expect(result.title!.length).toBeLessThan(120);
  }, 240_000);

  it('produces structured findings through the reviewer provider', async () => {
    const { ClaudeCliReviewer } = await import('@/reviewers/providers');
    const reviewer = new ClaudeCliReviewer('sonnet', 'low');
    expect(reviewer.readOnly).toBe(true);

    const result = await reviewer.review({
      runId: 'run_review_live',
      request: 'Add a route that echoes a query parameter.',
      spec: null,
      diff: [
        'diff --git a/server.js b/server.js',
        '--- a/server.js',
        '+++ b/server.js',
        '@@ -1,3 +1,7 @@',
        ' const app = require("express")();',
        '+app.get("/echo", (req, res) => {',
        '+  res.send("<h1>" + req.query.msg + "</h1>");',
        '+});',
        ' module.exports = app;',
      ].join('\n'),
      changedFiles: [
        { path: 'server.js', changeType: 'modified', additions: 4, deletions: 0 },
      ],
      validations: [
        { kind: 'unit', outcome: 'pass', exitCode: 0, command: 'npm test', excerpt: null },
      ],
      agentSummary: 'Added the echo route.',
    });

    expect(result.provider).toBe('claude-cli');
    expect(Array.isArray(result.findings)).toBe(true);
    // Unescaped query output rendered into HTML is XSS; a competent reviewer
    // should flag it. This asserts the plumbing and the prompt work together.
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(['info', 'low', 'medium', 'high', 'critical']).toContain(finding.severity);
      expect(finding.title.length).toBeGreaterThan(0);
    }
  }, 420_000);
});
