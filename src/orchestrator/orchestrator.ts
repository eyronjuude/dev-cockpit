import 'server-only';

import path from 'node:path';

import { ClaudeCodeAgent } from '@/agents/claude-code';
import { summariseToolInput } from '@/agents/stream-parser';
import type { AgentOutcome, AgentStreamEvent, ImplementationAgent } from '@/agents/types';
import { AppError, errorMessage } from '@/core/errors';
import { runWorktreeDir } from '@/core/paths';
import { BLOCKING_SEVERITIES, type Disposition } from '@/domain/types';
import { collectRunDiff, commitAll } from '@/git/diff';
import { commitInfo } from '@/git/git';
import { linkIntoWorktree, prepareWorktree, removeWorktree } from '@/git/worktree';
import { runCommand } from '@/process/spawn';
import { getReviewer } from '@/reviewers/registry';
import { register, writeTextArtifact } from '@/services/artifacts';
import { appendEvent } from '@/services/events';
import { requireProject, type ProjectView } from '@/services/projects';
import {
  assessReadiness,
  createIteration,
  finishIteration,
  insertFindings,
  latestIteration,
  latestValidationAttempt,
  nextReviewAttempt,
  replaceChangedFiles,
  requireRun,
  setIterationSummary,
  runProviders,
  setStatus,
  updateRunFields,
  type RunView,
} from '@/services/runs';
import { getTransformer } from '@/transformers/registry';
import { formatDuration, runValidation } from '@/validation/engine';
import { buildChangeRequestPrompt, buildInitialPrompt } from './prompt';
import { getProfile, type ExecutionProfile } from './profiles';

/* ------------------------------------------------------------------ *
 * Cancellation registry
 * ------------------------------------------------------------------ */

interface ActiveRun {
  controller: AbortController;
  startedAt: string;
  phase: string;
}

const GLOBAL_KEY = '__devCockpitActiveRuns__' as const;
type GlobalWithRuns = typeof globalThis & { [GLOBAL_KEY]?: Map<string, ActiveRun> };

function activeRuns(): Map<string, ActiveRun> {
  const g = globalThis as GlobalWithRuns;
  g[GLOBAL_KEY] ??= new Map();
  return g[GLOBAL_KEY];
}

export function isRunActive(runId: string): boolean {
  return activeRuns().has(runId);
}

export function activeRunPhase(runId: string): string | null {
  return activeRuns().get(runId)?.phase ?? null;
}

/**
 * Cancels a run's in-flight work.
 *
 * Aborting the controller propagates to the agent process and to whatever
 * validation command is running, both of which kill their process tree.
 */
export function cancelRun(runId: string, reason = 'Cancelled by the user'): boolean {
  const active = activeRuns().get(runId);
  if (!active) return false;
  appendEvent({
    runId,
    type: 'run.cancelled',
    level: 'notice',
    message: reason,
    payload: { reason },
  });
  active.controller.abort();
  return true;
}

function setPhase(runId: string, phase: string): void {
  const active = activeRuns().get(runId);
  if (active) active.phase = phase;
}

/* ------------------------------------------------------------------ *
 * Agent registry
 * ------------------------------------------------------------------ */

const AGENTS: Record<string, ImplementationAgent> = {
  'claude-code': new ClaudeCodeAgent(),
};

export function getAgent(id: string): ImplementationAgent {
  const agent = AGENTS[id];
  if (!agent) throw new AppError(`Unknown implementation agent: ${id}`);
  return agent;
}

export function listAgents(): readonly ImplementationAgent[] {
  return Object.values(AGENTS);
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

/**
 * Drives a run from DRAFT through to READY or NEEDS_CHANGES.
 *
 * Runs detached from the request that triggered it: the HTTP call returns as
 * soon as the run is accepted, and the UI follows along over SSE. Every phase
 * writes its state before moving on, so a crash leaves a run that can be
 * explained rather than a blank one.
 */
export function startRun(runId: string): void {
  if (activeRuns().has(runId)) {
    throw new AppError('This run is already in progress.', { code: 'already_running' });
  }
  const controller = new AbortController();
  activeRuns().set(runId, {
    controller,
    startedAt: new Date().toISOString(),
    phase: 'preparing',
  });

  void execute(runId, controller.signal, { kind: 'initial' }).finally(() => {
    activeRuns().delete(runId);
  });
}

/** Continues an existing run with user feedback, resuming the agent session. */
export function requestChanges(runId: string, feedback: string): void {
  if (activeRuns().has(runId)) {
    throw new AppError('This run is already in progress.', { code: 'already_running' });
  }
  const trimmed = feedback.trim();
  if (!trimmed) throw new AppError('Describe what should change.');

  const controller = new AbortController();
  activeRuns().set(runId, {
    controller,
    startedAt: new Date().toISOString(),
    phase: 'implementing',
  });

  void execute(runId, controller.signal, { kind: 'change_request', feedback: trimmed }).finally(
    () => {
      activeRuns().delete(runId);
    },
  );
}

/** Re-runs validation only, without touching the implementation. */
export function revalidate(runId: string): void {
  if (activeRuns().has(runId)) {
    throw new AppError('This run is already in progress.', { code: 'already_running' });
  }
  const controller = new AbortController();
  activeRuns().set(runId, {
    controller,
    startedAt: new Date().toISOString(),
    phase: 'validating',
  });

  void execute(runId, controller.signal, { kind: 'revalidate' }).finally(() => {
    activeRuns().delete(runId);
  });
}

type ExecuteMode =
  | { kind: 'initial' }
  | { kind: 'change_request'; feedback: string }
  | { kind: 'revalidate' };

async function execute(runId: string, signal: AbortSignal, mode: ExecuteMode): Promise<void> {
  let run = requireRun(runId);
  const project = requireProject(run.projectId);
  const profile = getProfile(run.profile);

  try {
    if (mode.kind === 'initial') {
      run = await phaseTransform(run, project, profile, signal);
      run = await phasePrepare(run, project, signal);
      run = await phaseImplement(run, project, profile, signal, { kind: 'initial' });
    } else if (mode.kind === 'change_request') {
      run = await phaseImplement(run, project, profile, signal, {
        kind: 'change_request',
        feedback: mode.feedback,
      });
    }

    if (signal.aborted) {
      await finishCancelled(runId);
      return;
    }

    run = await phaseCollectDiff(run, signal);
    run = await phaseValidate(run, project, profile, signal);

    if (signal.aborted) {
      await finishCancelled(runId);
      return;
    }

    run = await phaseReview(run, project, profile, signal);
    await phaseDecide(run, project);
  } catch (err) {
    if (signal.aborted) {
      await finishCancelled(runId);
      return;
    }
    const message = errorMessage(err);
    appendEvent({
      runId,
      type: 'run.failed',
      level: 'error',
      message,
      payload: { error: message },
    });
    updateRunFields(runId, { error: message });
    try {
      setStatus(runId, 'FAILED', { reason: 'error', finished: true, error: message });
    } catch {
      // Already terminal; the event above is the record.
    }
  }
}

async function finishCancelled(runId: string): Promise<void> {
  try {
    setStatus(runId, 'CANCELLED', { reason: 'cancelled', finished: true });
  } catch {
    // Already terminal.
  }
}

/* ------------------------------------------------------------------ *
 * Phase: transform
 * ------------------------------------------------------------------ */

async function phaseTransform(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  signal: AbortSignal,
): Promise<RunView> {
  setPhase(run.id, 'transforming');
  const providers = runProviders(run.id);
  const transformer = getTransformer(providers.transformer);

  if (transformer.id === 'none') {
    appendEvent({
      runId: run.id,
      type: 'transform.skipped',
      message: 'No transformer configured; using the request as written',
      payload: { provider: 'none', reason: 'not configured' },
    });
    return requireRun(run.id);
  }

  const availability = await transformer.checkAvailability();
  if (!availability.available) {
    // Graceful fallback: the run continues with the raw request. A missing
    // optional provider is not a failure.
    appendEvent({
      runId: run.id,
      type: 'transform.skipped',
      level: 'notice',
      message: `Transformer ${transformer.id} unavailable: ${availability.detail}. Using the request as written.`,
      payload: { provider: transformer.id, reason: availability.detail },
    });
    return requireRun(run.id);
  }

  appendEvent({
    runId: run.id,
    type: 'transform.started',
    message: `Transforming the request with ${transformer.label}`,
    payload: { provider: transformer.id },
  });

  try {
    const result = await transformer.transformRequest({
      request: run.request,
      projectName: project.name,
      projectSummary: project.developmentCommand
        ? `Development command: ${project.developmentCommand}`
        : null,
      configuredValidations: project.validationCommands
        .filter((c) => c.enabled && c.command.trim())
        .map((c) => c.kind),
      profile: profile.id,
      signal,
    });

    updateRunFields(run.id, {
      spec: result.spec,
      specProvider: result.provider,
      ...(result.title ? { title: result.title } : {}),
    });

    await writeTextArtifact({
      runId: run.id,
      kind: 'transform_spec',
      label: 'Implementation specification',
      fileName: 'specification.md',
      content: result.spec,
      mimeType: 'text/markdown',
      meta: { provider: result.provider, durationMs: result.durationMs },
    });

    appendEvent({
      runId: run.id,
      type: 'transform.completed',
      message: `Specification ready (${result.provider}, ${formatDuration(result.durationMs)})`,
      payload: {
        provider: result.provider,
        specLength: result.spec.length,
        durationMs: result.durationMs,
      },
    });
  } catch (err) {
    const message = errorMessage(err);
    appendEvent({
      runId: run.id,
      type: 'transform.failed',
      level: 'notice',
      message: `Transformer failed: ${message}. Using the request as written.`,
      payload: { provider: transformer.id, error: message },
    });
  }

  return requireRun(run.id);
}

/* ------------------------------------------------------------------ *
 * Phase: prepare worktree
 * ------------------------------------------------------------------ */

async function phasePrepare(
  run: RunView,
  project: ProjectView,
  signal: AbortSignal,
): Promise<RunView> {
  setStatus(run.id, 'PREPARING', { started: true });
  setPhase(run.id, 'preparing');

  const worktreePath = runWorktreeDir(project.id, run.id);
  const branch = run.branch ?? `cockpit/${run.id}`;
  const baseRef = run.baseBranch ?? project.defaultBranch;

  const prepared = await prepareWorktree({
    repositoryPath: project.repositoryPath,
    worktreePath,
    branch,
    baseRef,
    protectedBranches: project.protectedBranches,
  });

  updateRunFields(run.id, {
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    baseBranch: baseRef,
  });

  const base = await commitInfo(project.repositoryPath, prepared.baseCommit);
  appendEvent({
    runId: run.id,
    type: 'worktree.prepared',
    message: `Worktree ready on ${prepared.branch} from ${
      base ? `${base.shortSha} "${base.subject}"` : prepared.baseCommit.slice(0, 7)
    }`,
    payload: {
      path: prepared.worktreePath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      baseBranch: baseRef,
    },
  });

  // Link what the checks need but a fresh worktree does not have.
  const linkResult = await linkIntoWorktree(
    project.repositoryPath,
    prepared.worktreePath,
    project.linkPaths,
  );

  let setupExitCode: number | null = null;
  if (project.setupCommand?.trim()) {
    setPhase(run.id, 'setup');
    const result = await runCommand({
      command: project.setupCommand,
      cwd: prepared.worktreePath,
      timeoutMs: 20 * 60 * 1000,
      signal,
    });
    setupExitCode = result.exitCode;

    await writeTextArtifact({
      runId: run.id,
      kind: 'stdout_log',
      label: 'Worktree setup output',
      fileName: path.join('setup', 'setup.log'),
      content: `Command: ${project.setupCommand}\nExit code: ${result.exitCode}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}`,
      meta: { exitCode: result.exitCode, durationMs: result.durationMs },
    });

    if (result.exitCode !== 0 && !result.aborted) {
      // Not fatal: the checks may still work. Surfaced honestly instead.
      appendEvent({
        runId: run.id,
        type: 'worktree.setup',
        level: 'notice',
        message: `Setup command exited ${result.exitCode}. Validation may fail as a result.`,
        payload: {
          linked: linkResult.linked,
          setupCommand: project.setupCommand,
          setupExitCode: result.exitCode,
        },
      });
    }
  }

  const linkedNote =
    linkResult.linked.length > 0 ? `linked ${linkResult.linked.join(', ')}` : 'nothing linked';
  const failedNote =
    linkResult.failed.length > 0
      ? `; could not link ${linkResult.failed.map((f) => `${f.path} (${f.error})`).join(', ')}`
      : '';

  appendEvent({
    runId: run.id,
    type: 'worktree.setup',
    level: linkResult.failed.length > 0 ? 'notice' : 'info',
    message: `Worktree setup: ${linkedNote}${failedNote}${
      setupExitCode === null ? '' : `; setup command exited ${setupExitCode}`
    }`,
    payload: {
      linked: linkResult.linked,
      setupCommand: project.setupCommand ?? null,
      setupExitCode,
    },
  });

  return requireRun(run.id);
}

/* ------------------------------------------------------------------ *
 * Phase: implement
 * ------------------------------------------------------------------ */

type ImplementMode = { kind: 'initial' } | { kind: 'change_request'; feedback: string };

async function phaseImplement(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  signal: AbortSignal,
  mode: ImplementMode,
): Promise<RunView> {
  if (!run.worktreePath) {
    throw new AppError('This run has no worktree. Start it before requesting changes.');
  }

  setStatus(run.id, 'IMPLEMENTING', { started: run.startedAt === null });
  setPhase(run.id, 'implementing');

  const agent = getAgent(run.agentProvider);

  const availability = await agent.checkAvailability();
  if (!availability.available) {
    throw new AppError(
      `${agent.label} is not available: ${availability.detail}`,
      { code: 'agent_unavailable' },
    );
  }

  const prompt =
    mode.kind === 'initial'
      ? buildInitialPrompt({ run, project, profile })
      : buildChangeRequestPrompt({
          run,
          project,
          feedback: mode.feedback,
          validations: latestValidationAttempt(run.id),
          findings: latestFindings(run),
        });

  // Resume when a session exists, so a change request keeps context.
  const resumeSessionId = mode.kind === 'change_request' ? run.agentSessionId : null;

  const iteration = createIteration({
    runId: run.id,
    kind: mode.kind === 'initial' ? 'initial' : 'change_request',
    prompt,
    sessionId: resumeSessionId,
    resumed: resumeSessionId !== null,
  });

  appendEvent({
    runId: run.id,
    type: 'agent.started',
    message: resumeSessionId
      ? `Resuming ${agent.label} session ${resumeSessionId.slice(0, 8)} (iteration ${iteration.ordinal})`
      : `Starting ${agent.label} (iteration ${iteration.ordinal})`,
    payload: {
      iterationId: iteration.id,
      provider: agent.id,
      sessionId: resumeSessionId,
      resumed: resumeSessionId !== null,
      model: run.agentModel ?? project.agentModel,
    },
  });

  const onEvent = (event: AgentStreamEvent) => {
    handleAgentEvent(run.id, iteration.id, event);
  };

  const startInput = {
    runId: run.id,
    iterationId: iteration.id,
    prompt,
    worktreePath: run.worktreePath,
    additionalDirs: project.agentAddDirs,
    model: run.agentModel ?? project.agentModel,
    permissionMode: project.effectivePermissionMode,
    effort: profile.agentEffort,
    timeoutMs: profile.agentTimeoutMs,
    signal,
    onEvent,
  };

  const outcome: AgentOutcome = resumeSessionId
    ? await agent.continueRun({ ...startInput, sessionId: resumeSessionId })
    : await agent.startRun(startInput);

  if (outcome.rawLogPath) {
    await register({
      runId: run.id,
      kind: 'implementation_log',
      label: `Agent stream (iteration ${iteration.ordinal})`,
      filePath: outcome.rawLogPath,
      mimeType: 'application/x-ndjson',
      meta: { iterationId: iteration.id, sessionId: outcome.sessionId },
    });
  }

  finishIteration(iteration.id, {
    status: outcome.cancelled ? 'cancelled' : outcome.ok ? 'completed' : 'failed',
    sessionId: outcome.sessionId,
    exitCode: outcome.exitCode,
    numTurns: outcome.numTurns,
    costUsd: outcome.costUsd,
    finalText: outcome.finalText,
    error: outcome.errorMessage,
  });

  if (outcome.sessionId) {
    updateRunFields(run.id, { agentSessionId: outcome.sessionId });
  }

  const previousCost = run.costUsd ?? 0;
  if (outcome.costUsd !== null) {
    updateRunFields(run.id, { costUsd: previousCost + outcome.costUsd });
  }

  // A run whose agent had tools refused worked with less capability than the
  // prompt assumed. Say so, rather than leaving the user to infer it from a
  // closing message that mentions checks it could not run.
  if (outcome.deniedTools.length > 0) {
    const denied = outcome.deniedTools.join(', ');
    appendEvent({
      runId: run.id,
      type: 'agent.notice',
      level: 'notice',
      message: `Permission mode "${project.effectivePermissionMode}" refused ${denied} — the implementer could not run commands or verify its own work.`,
      payload: { iterationId: iteration.id, text: `Denied tools: ${denied}` },
    });
  }

  if (outcome.cancelled) {
    appendEvent({
      runId: run.id,
      type: 'agent.cancelled',
      level: 'notice',
      message: 'Implementation cancelled',
      payload: { iterationId: iteration.id },
    });
    return requireRun(run.id);
  }

  if (!outcome.ok) {
    appendEvent({
      runId: run.id,
      type: 'agent.failed',
      level: 'error',
      message: outcome.errorMessage ?? 'The implementation agent failed',
      payload: {
        iterationId: iteration.id,
        error: outcome.errorMessage ?? 'unknown',
        exitCode: outcome.exitCode,
      },
    });
    // Deliberately not thrown: the diff and validation still run, because
    // partial work is worth showing and validating.
  } else {
    appendEvent({
      runId: run.id,
      type: 'agent.completed',
      message: `Implementation finished${
        outcome.durationMs === null ? '' : ` in ${formatDuration(outcome.durationMs)}`
      }${outcome.numTurns === null ? '' : `, ${outcome.numTurns} turn(s)`}`,
      payload: {
        iterationId: iteration.id,
        sessionId: outcome.sessionId,
        numTurns: outcome.numTurns,
        durationMs: outcome.durationMs,
        costUsd: outcome.costUsd,
        finalText: outcome.finalText,
      },
    });
  }

  if (outcome.finalText?.trim()) {
    await writeTextArtifact({
      runId: run.id,
      kind: 'markdown_report',
      label: `Implementation summary (iteration ${iteration.ordinal})`,
      fileName: path.join('summaries', `iteration-${iteration.ordinal}.md`),
      content: outcome.finalText,
      mimeType: 'text/markdown',
      meta: { iterationId: iteration.id },
    });

    await phaseSummarise(run, iteration.id, iteration.ordinal, outcome.finalText, signal);
  }

  return requireRun(run.id);
}

/* ------------------------------------------------------------------ *
 * Phase: interpret the implementer's closing message
 * ------------------------------------------------------------------ */

/**
 * Rewrites the agent's closing message into plain language.
 *
 * Optional in the same way the specification step is: a provider that is absent
 * or fails records a `summarise.skipped` event and the run continues. The
 * original text is never replaced — the interpreted version is stored beside it,
 * because losing the implementer's actual words would make the run less
 * auditable rather than more.
 *
 * Only prose crosses this boundary. The diff, the exit codes and the findings
 * are nowhere in the call.
 */
async function phaseSummarise(
  run: RunView,
  iterationId: string,
  ordinal: number,
  agentText: string,
  signal: AbortSignal,
): Promise<void> {
  const providers = runProviders(run.id);
  const transformer = getTransformer(providers.transformer);

  if (transformer.id === 'none' || typeof transformer.summariseOutcome !== 'function') {
    appendEvent({
      runId: run.id,
      type: 'summarise.skipped',
      level: 'debug',
      message:
        transformer.id === 'none'
          ? 'No transformer configured; showing the implementer’s message as written'
          : `${transformer.label} cannot summarise; showing the message as written`,
      payload: { provider: transformer.id, iterationId, reason: 'not available' },
    });
    return;
  }

  if (signal.aborted) return;

  try {
    const result = await transformer.summariseOutcome({
      agentText,
      request: run.request,
      signal,
    });

    const summary = result.summary.trim();
    if (!summary) throw new Error('The provider returned an empty summary');

    setIterationSummary(iterationId, summary, result.provider);

    await writeTextArtifact({
      runId: run.id,
      kind: 'markdown_report',
      label: `Plain-language summary (iteration ${ordinal})`,
      fileName: path.join('summaries', `iteration-${ordinal}-interpreted.md`),
      content: `${summary}\n\n---\n\nInterpreted by ${result.provider} from the implementer's own closing message, which is stored unchanged alongside this file.\n`,
      mimeType: 'text/markdown',
      meta: { iterationId, provider: result.provider, durationMs: result.durationMs },
    });

    appendEvent({
      runId: run.id,
      type: 'summarise.completed',
      message: `Summary rewritten by ${result.provider} (${formatDuration(result.durationMs)})`,
      payload: { provider: result.provider, iterationId, durationMs: result.durationMs },
    });
  } catch (err) {
    const message = errorMessage(err);
    appendEvent({
      runId: run.id,
      type: 'summarise.skipped',
      level: 'notice',
      message: `Could not rewrite the summary: ${message}. Showing the message as written.`,
      payload: { provider: transformer.id, iterationId, reason: message },
    });
  }
}

/** Translates a normalised agent event into a persisted run event. */
function handleAgentEvent(runId: string, iterationId: string, event: AgentStreamEvent): void {
  switch (event.kind) {
    case 'session':
      updateRunFields(runId, {
        agentSessionId: event.sessionId,
        ...(event.model ? { agentModel: event.model } : {}),
      });
      break;

    case 'text':
      appendEvent({
        runId,
        type: 'agent.message',
        message: firstMeaningfulLine(event.text),
        payload: { iterationId, text: event.text },
      });
      break;

    case 'thinking':
      appendEvent({
        runId,
        type: 'agent.thinking',
        level: 'debug',
        message: firstMeaningfulLine(event.text),
        payload: { iterationId, text: event.text },
      });
      break;

    case 'tool_start': {
      const summary = summariseToolInput(event.tool, event.input);
      appendEvent({
        runId,
        type: 'agent.tool_started',
        message: summary ? `${event.tool}: ${summary}` : event.tool,
        payload: { iterationId, toolUseId: event.toolUseId, tool: event.tool, summary },
      });
      break;
    }

    case 'tool_end':
      appendEvent({
        runId,
        type: 'agent.tool_completed',
        level: event.isError ? 'notice' : 'debug',
        message: `${event.tool || 'tool'} ${event.isError ? 'failed' : 'done'}${
          event.summary ? `: ${event.summary}` : ''
        }`,
        payload: {
          iterationId,
          toolUseId: event.toolUseId,
          tool: event.tool,
          isError: event.isError,
          summary: event.summary,
        },
      });
      break;

    case 'notice':
      appendEvent({
        runId,
        type: 'agent.notice',
        level: event.level === 'error' ? 'error' : 'notice',
        message: event.text,
        payload: { iterationId, text: event.text },
      });
      break;

    case 'result':
      // Recorded by phaseImplement from the outcome, which has the full picture.
      break;
  }
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const value = line ?? text.trim();
  return value.length > 400 ? `${value.slice(0, 397)}...` : value;
}

/* ------------------------------------------------------------------ *
 * Phase: collect diff
 * ------------------------------------------------------------------ */

async function phaseCollectDiff(run: RunView, _signal: AbortSignal): Promise<RunView> {
  if (!run.worktreePath || !run.baseCommit) return run;
  setPhase(run.id, 'collecting');

  const diff = await collectRunDiff(run.worktreePath, run.baseCommit);
  replaceChangedFiles(run.id, diff.files);

  for (const file of diff.files) {
    appendEvent({
      runId: run.id,
      type: 'file.changed',
      level: 'debug',
      message: `${file.changeType} ${file.path} (+${file.additions}/-${file.deletions})`,
      payload: {
        path: file.path,
        changeType: file.changeType,
        additions: file.additions,
        deletions: file.deletions,
      },
    });
  }

  await writeTextArtifact({
    runId: run.id,
    kind: 'git_diff',
    label: 'Git diff',
    fileName: 'changes.diff',
    content: diff.patch || '(no changes)',
    mimeType: 'text/plain',
    // A diff is evidence. Redaction would alter it, so it is stored verbatim.
    redactContent: false,
    meta: {
      files: diff.files.length,
      additions: diff.additions,
      deletions: diff.deletions,
      truncated: diff.truncated,
      baseCommit: run.baseCommit,
    },
  });

  await writeTextArtifact({
    runId: run.id,
    kind: 'changed_files',
    label: 'Changed files',
    fileName: 'changed-files.json',
    content: JSON.stringify(
      { baseCommit: run.baseCommit, files: diff.files, additions: diff.additions, deletions: diff.deletions },
      null,
      2,
    ),
    mimeType: 'application/json',
    redactContent: false,
  });

  appendEvent({
    runId: run.id,
    type: 'artifact.created',
    message: `${diff.files.length} file(s) changed, +${diff.additions}/-${diff.deletions}`,
    payload: { artifactId: '', kind: 'git_diff', label: 'Git diff', bytes: diff.patch.length },
  });

  return requireRun(run.id);
}

/* ------------------------------------------------------------------ *
 * Phase: validate
 * ------------------------------------------------------------------ */

async function phaseValidate(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  signal: AbortSignal,
): Promise<RunView> {
  if (!run.worktreePath) return run;
  setStatus(run.id, 'VALIDATING');
  setPhase(run.id, 'validating');

  await runValidation({
    runId: run.id,
    worktreePath: run.worktreePath,
    project,
    profile: profile.id,
    signal,
  });

  return requireRun(run.id);
}

/* ------------------------------------------------------------------ *
 * Phase: review
 * ------------------------------------------------------------------ */

function latestFindings(run: RunView) {
  const attempt = run.findings.reduce((acc, f) => Math.max(acc, f.attempt), 0);
  return run.findings.filter((f) => f.attempt === attempt);
}

async function phaseReview(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  signal: AbortSignal,
): Promise<RunView> {
  const providers = runProviders(run.id);
  const reviewer = getReviewer(providers.reviewer);

  if (!reviewer) {
    appendEvent({
      runId: run.id,
      type: 'review.skipped',
      message: 'No independent reviewer configured for this run',
      payload: { provider: 'none', reason: 'not configured' },
    });
    return run;
  }

  if (!profile.runReviewer) {
    appendEvent({
      runId: run.id,
      type: 'review.skipped',
      message: `The ${profile.label} profile skips independent review`,
      payload: { provider: reviewer.id, reason: `profile ${profile.id}` },
    });
    return run;
  }

  if (run.changedFiles.length === 0) {
    appendEvent({
      runId: run.id,
      type: 'review.skipped',
      message: 'Nothing changed, so there is nothing to review',
      payload: { provider: reviewer.id, reason: 'no changes' },
    });
    return run;
  }

  const availability = await reviewer.checkAvailability();
  if (!availability.available) {
    appendEvent({
      runId: run.id,
      type: 'review.skipped',
      level: 'notice',
      message: `Reviewer ${reviewer.id} unavailable: ${availability.detail}`,
      payload: { provider: reviewer.id, reason: availability.detail },
    });
    return run;
  }

  setStatus(run.id, 'REVIEWING');
  setPhase(run.id, 'reviewing');

  appendEvent({
    runId: run.id,
    type: 'review.started',
    message: `Independent review with ${reviewer.label}`,
    payload: { provider: reviewer.id },
  });

  try {
    const diffArtifact = await readDiffForReview(run);
    const validations = latestValidationAttempt(run.id);
    const lastIteration = latestIteration(run.id);

    const result = await reviewer.review({
      runId: run.id,
      request: run.request,
      spec: run.spec,
      diff: diffArtifact,
      changedFiles: run.changedFiles.map((f) => ({
        path: f.path,
        changeType: f.changeType,
        additions: f.additions,
        deletions: f.deletions,
      })),
      validations: validations.map((v) => ({
        kind: v.kind,
        outcome: v.outcome,
        exitCode: v.exitCode,
        command: v.command,
        excerpt:
          v.outcome === 'fail' || v.outcome === 'error'
            ? [v.stdout, v.stderr].filter(Boolean).join('\n').slice(-4_000) || null
            : null,
      })),
      agentSummary: lastIteration?.finalText ?? null,
      signal,
    });

    const attempt = nextReviewAttempt(run.id);
    const stored = insertFindings(run.id, attempt, result.provider, result.findings);

    for (const finding of stored) {
      appendEvent({
        runId: run.id,
        type: 'review.finding',
        level: BLOCKING_SEVERITIES.includes(finding.severity) ? 'notice' : 'info',
        message: `[${finding.severity}] ${finding.title}${finding.file ? ` — ${finding.file}` : ''}`,
        payload: {
          findingId: finding.id,
          severity: finding.severity,
          title: finding.title,
          file: finding.file,
        },
      });
    }

    await writeTextArtifact({
      runId: run.id,
      kind: 'review_report',
      label: `Review report (attempt ${attempt})`,
      fileName: path.join('review', `attempt-${attempt}.md`),
      content: buildReviewReport(reviewer.label, result.summary, stored),
      mimeType: 'text/markdown',
      meta: { provider: result.provider, attempt, findingCount: stored.length },
    });

    const blockingCount = stored.filter((f) => BLOCKING_SEVERITIES.includes(f.severity)).length;

    appendEvent({
      runId: run.id,
      type: 'review.completed',
      message: `Review finished: ${stored.length} finding(s)${
        blockingCount > 0 ? `, ${blockingCount} blocking` : ''
      }`,
      payload: {
        provider: result.provider,
        findingCount: stored.length,
        blocking: project.reviewBlocksReady && blockingCount > 0,
      },
    });
  } catch (err) {
    const message = errorMessage(err);
    // An optional layer failing must not fail the run.
    appendEvent({
      runId: run.id,
      type: 'review.skipped',
      level: 'notice',
      message: `Review failed: ${message}`,
      payload: { provider: reviewer.id, reason: message },
    });
  }

  return requireRun(run.id);
}

async function readDiffForReview(run: RunView): Promise<string> {
  if (!run.worktreePath || !run.baseCommit) return '';
  const diff = await collectRunDiff(run.worktreePath, run.baseCommit);
  return diff.patch;
}

function buildReviewReport(
  providerLabel: string,
  summary: string | null,
  findings: readonly { severity: string; title: string; detail: string | null; file: string | null; line: number | null; suggestion: string | null }[],
): string {
  const parts = [`# Independent review\n\nReviewer: ${providerLabel}`];
  if (summary) parts.push(`## Summary\n\n${summary}`);
  if (findings.length === 0) {
    parts.push('## Findings\n\nNo findings.');
  } else {
    const list = findings
      .map((f) => {
        const location = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'unspecified';
        const detail = f.detail ? `\n\n${f.detail}` : '';
        const suggestion = f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : '';
        return `### [${f.severity}] ${f.title}\n\nLocation: ${location}${detail}${suggestion}`;
      })
      .join('\n\n');
    parts.push(`## Findings\n\n${list}`);
  }
  parts.push(
    '---\n\nFindings are the reviewer’s opinion, not test results. Deterministic validation is recorded separately.',
  );
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Phase: decide
 * ------------------------------------------------------------------ */

/**
 * Decides READY or NEEDS_CHANGES from stored state.
 *
 * This is where IMPLEMENTER != APPROVER becomes concrete: the agent's own
 * summary is not consulted. Only recorded validation outcomes, recorded
 * findings, and the project's policies decide.
 */
async function phaseDecide(run: RunView, project: ProjectView): Promise<void> {
  const fresh = requireRun(run.id);
  const assessment = assessReadiness(fresh, project);

  if (assessment.ready) {
    setStatus(fresh.id, 'READY', { reason: 'validation passed', finished: true });
    appendEvent({
      runId: fresh.id,
      type: 'run.ready',
      message: `Ready for review: ${assessment.validationsPassed} check(s) passed`,
      payload: {
        validationsPassed: assessment.validationsPassed,
        blockingFindings: assessment.blockingFindings,
      },
    });
    return;
  }

  setStatus(fresh.id, 'NEEDS_CHANGES', { reason: assessment.reasons[0], finished: true });
  appendEvent({
    runId: fresh.id,
    type: 'run.needs_changes',
    level: 'notice',
    message: `Needs changes: ${assessment.reasons.join('; ')}`,
    payload: { reasons: assessment.reasons },
  });
}

/* ------------------------------------------------------------------ *
 * Disposition
 * ------------------------------------------------------------------ */

export interface ApproveOptions {
  note?: string | null;
  /** Creates a local commit on the run branch. Never merges, never pushes. */
  createCommit?: boolean;
  commitMessage?: string;
}

/**
 * Marks a run approved.
 *
 * V1 approval means exactly this: the run is recorded as approved and, if asked,
 * a commit is created on the run's own branch. Nothing is merged into the
 * default branch and nothing is pushed — that stays a deliberate manual step.
 */
export async function approveRun(runId: string, options: ApproveOptions = {}): Promise<RunView> {
  const run = requireRun(runId);
  const project = requireProject(run.projectId);

  if (isRunActive(runId)) {
    throw new AppError('Cancel the run before approving it.', { code: 'busy' });
  }

  let commitSha: string | null = run.commitSha;

  if (options.createCommit) {
    if (!run.worktreePath || !run.branch) {
      throw new AppError('This run has no worktree to commit.');
    }
    if (project.protectedBranches.includes(run.branch)) {
      throw new AppError(`Refusing to commit onto the protected branch ${run.branch}.`, {
        code: 'protected',
      });
    }
    if (run.changedFiles.length === 0) {
      throw new AppError('There is nothing to commit.');
    }

    const message =
      options.commitMessage?.trim() ||
      `${run.title}\n\nImplemented by Dev Cockpit run ${run.id}.`;

    commitSha = await commitAll(run.worktreePath, message, {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });

    appendEvent({
      runId,
      type: 'run.commit_created',
      message: `Created commit ${commitSha.slice(0, 7)} on ${run.branch}`,
      payload: { sha: commitSha, message },
    });
  }

  updateRunFields(runId, {
    disposition: 'approved' satisfies Disposition,
    dispositionNote: options.note ?? null,
    commitSha,
  });
  setStatus(runId, 'APPROVED', { reason: 'approved by the user', finished: true });

  appendEvent({
    runId,
    type: 'run.approved',
    message: options.note?.trim() ? `Approved: ${options.note.trim()}` : 'Approved',
    payload: { note: options.note ?? null, commitSha },
  });

  return requireRun(runId);
}

export interface RejectOptions {
  note?: string | null;
  /** Removes the worktree and deletes the branch if it holds no commits. */
  cleanUp?: boolean;
}

export async function rejectRun(runId: string, options: RejectOptions = {}): Promise<RunView> {
  const run = requireRun(runId);
  const project = requireProject(run.projectId);

  if (isRunActive(runId)) {
    cancelRun(runId, 'Cancelled because the run was rejected');
  }

  updateRunFields(runId, {
    disposition: 'rejected' satisfies Disposition,
    dispositionNote: options.note ?? null,
  });
  setStatus(runId, 'REJECTED', { reason: 'rejected by the user', finished: true });

  appendEvent({
    runId,
    type: 'run.rejected',
    message: options.note?.trim() ? `Rejected: ${options.note.trim()}` : 'Rejected',
    payload: { note: options.note ?? null },
  });

  if (options.cleanUp && run.worktreePath) {
    const result = await removeWorktree(
      project.repositoryPath,
      run.worktreePath,
      run.branch,
      { force: true, deleteBranch: true },
    );
    appendEvent({
      runId,
      type: 'run.cancelled',
      level: 'info',
      message: result.removed
        ? `Worktree removed${result.branchDeleted ? ' and branch deleted' : ''}`
        : `Worktree not removed: ${result.reason ?? 'unknown reason'}`,
      payload: { reason: result.reason ?? 'cleanup' },
    });
  }

  return requireRun(runId);
}
