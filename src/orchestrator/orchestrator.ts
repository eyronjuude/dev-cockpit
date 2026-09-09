import 'server-only';

import path from 'node:path';

import { ClaudeCodeAgent } from '@/agents/claude-code';
import { summariseToolInput } from '@/agents/stream-parser';
import type { AgentOutcome, AgentStreamEvent, ImplementationAgent } from '@/agents/types';
import { landingBranchName } from '@/core/ids';
import { AppError, errorMessage } from '@/core/errors';
import { runLandingDir, runWorktreeDir } from '@/core/paths';
import {
  effectiveWorkMode,
  WORK_MODE_LABELS,
  WORK_MODE_WORDING,
  type ResolvedWorkMode,
} from '@/domain/modes';
import {
  BLOCKING_OUTCOMES,
  BLOCKING_SEVERITIES,
  type Disposition,
  type IterationKind,
  type RunStatus,
} from '@/domain/types';
import { collectRunDiff, commitAll } from '@/git/diff';
import { commitInfo, isDirty, refExists, resolveCommit } from '@/git/git';
import {
  applyLandingToTarget,
  completeMergeIfResolved,
  ensureLandingWorktree,
  mergeInProgress,
  mergeSourceIntoLanding,
  mergeTargetIntoLanding,
  refMergedIntoLanding,
  sourceMergedIntoLanding,
  stageResolvedConflictFiles,
  unmergedFiles,
} from '@/git/landing';
import { linkIntoWorktree, prepareWorktree, removeWorktree } from '@/git/worktree';
import { runCommand } from '@/process/spawn';
import { getReviewer } from '@/reviewers/registry';
import { register, writeTextArtifact } from '@/services/artifacts';
import { appendEvent } from '@/services/events';
import { tryRecordImplementationMap } from '@/services/implementation-map';
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
  switchRunMode,
  updateRunFields,
  type RunView,
} from '@/services/runs';
import { getTransformer } from '@/transformers/registry';
import { formatDuration, runValidation, type ValidationRunSummary } from '@/validation/engine';
import { effectivePermissionMode, getWorkMode, type WorkModeBehaviour } from './modes';
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

export function registerAgent(agent: ImplementationAgent): () => void {
  const previous = AGENTS[agent.id];
  AGENTS[agent.id] = agent;
  return () => {
    if (previous) AGENTS[agent.id] = previous;
    else delete AGENTS[agent.id];
  };
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

export interface RequestChangesOptions {
  /**
   * Switch the run into this mode for the follow-up iteration.
   *
   * This is how a plan becomes an implementation without losing the session
   * that produced it: the same Claude Code session is resumed, told the rules
   * have changed, and asked to build what it just planned.
   */
  mode?: ResolvedWorkMode;
}

/** Continues an existing run with user feedback, resuming the agent session. */
export function requestChanges(
  runId: string,
  feedback: string,
  options: RequestChangesOptions = {},
): void {
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

  void execute(runId, controller.signal, {
    kind: 'change_request',
    feedback: trimmed,
    switchTo: options.mode ?? null,
  }).finally(() => {
    activeRuns().delete(runId);
  });
}

/** Re-runs validation only, without touching the implementation. */
export function revalidate(runId: string): void {
  if (activeRuns().has(runId)) {
    throw new AppError('This run is already in progress.', { code: 'already_running' });
  }

  // A read-only run has no diff, so there is nothing to validate. Saying so
  // beats recording an attempt whose every outcome is "not configured".
  const run = requireRun(runId);
  const mode = effectiveWorkMode(run);
  if (!getWorkMode(mode).runValidation) {
    throw new AppError(
      `${WORK_MODE_LABELS[mode]} mode changes nothing, so there is nothing to validate. Switch the run to Build mode first.`,
      { code: 'wrong_mode' },
    );
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

const LANDABLE_STATUSES: readonly RunStatus[] = ['APPROVED', 'MERGE_CONFLICT', 'LANDING_FAILED'];

function isLandable(run: RunView): boolean {
  return LANDABLE_STATUSES.includes(run.status) || (
    run.status === 'CANCELLED' && run.disposition === 'approved'
  );
}

/** Starts the approved-run landing flow in an isolated landing worktree. */
export function landRun(runId: string): void {
  if (activeRuns().has(runId)) {
    throw new AppError('This run is already in progress.', { code: 'already_running' });
  }
  const run = requireRun(runId);
  if (!isLandable(run)) {
    throw new AppError(`Run ${run.id} is ${run.status}; approve it before landing.`);
  }

  const controller = new AbortController();
  activeRuns().set(runId, {
    controller,
    startedAt: new Date().toISOString(),
    phase: 'landing',
  });

  void executeLanding(runId, controller.signal, { kind: 'land' }).finally(() => {
    activeRuns().delete(runId);
  });
}

/** Lets the implementation agent try to resolve an existing landing conflict. */
export function resolveLandingConflicts(runId: string): void {
  if (activeRuns().has(runId)) {
    throw new AppError('This run is already in progress.', { code: 'already_running' });
  }
  const run = requireRun(runId);
  if (run.status !== 'MERGE_CONFLICT') {
    throw new AppError(`Run ${run.id} is ${run.status}; there is no recorded merge conflict.`);
  }

  const controller = new AbortController();
  activeRuns().set(runId, {
    controller,
    startedAt: new Date().toISOString(),
    phase: 'resolving merge conflicts',
  });

  void executeLanding(runId, controller.signal, { kind: 'resolve_conflicts' }).finally(() => {
    activeRuns().delete(runId);
  });
}

type ExecuteMode =
  | { kind: 'initial' }
  | { kind: 'change_request'; feedback: string; switchTo: ResolvedWorkMode | null }
  | { kind: 'revalidate' };

type LandingMode = { kind: 'land' } | { kind: 'resolve_conflicts' };

async function execute(runId: string, signal: AbortSignal, mode: ExecuteMode): Promise<void> {
  let run = requireRun(runId);
  const project = requireProject(run.projectId);
  const profile = getProfile(run.profile);

  try {
    // The working mode governs which phases run at all, so it is settled
    // before the first one. A switch is applied here rather than inside a
    // phase: the stored mode has to be true for the whole of the iteration it
    // describes.
    let switched = false;
    if (mode.kind === 'change_request' && mode.switchTo) {
      switched = mode.switchTo !== effectiveWorkMode(run);
      if (switched) {
        switchRunMode(runId, mode.switchTo, 'requested with the change');
        run = requireRun(runId);
      }
    }
    const workMode = getWorkMode(effectiveWorkMode(run));

    if (mode.kind === 'initial') {
      run = await phaseTransform(run, project, profile, signal);
      run = await phasePrepare(run, project, signal);
      run = await phaseImplement(run, project, profile, workMode, signal, { kind: 'initial' });
    } else if (mode.kind === 'change_request') {
      run = await phaseImplement(run, project, profile, workMode, signal, {
        kind: 'change_request',
        feedback: mode.feedback,
        switched,
      });
    }

    if (signal.aborted) {
      await finishCancelled(runId);
      return;
    }

    run = await phaseCollectDiff(run, signal);
    run = await phaseValidate(run, project, profile, workMode, signal);

    if (signal.aborted) {
      await finishCancelled(runId);
      return;
    }

    run = await phaseReview(run, project, profile, workMode, signal);
    await phaseDecide(run, project, workMode);
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
  } finally {
    // Every run gets a map, including the ones that failed or were cancelled:
    // "where did this stop?" is exactly the question a failed run raises. Drawn
    // last so it reflects the final status rather than a status in flight.
    await tryRecordImplementationMap(runId);
  }
}

async function executeLanding(
  runId: string,
  signal: AbortSignal,
  mode: LandingMode,
): Promise<void> {
  let run = requireRun(runId);
  const project = requireProject(run.projectId);
  const profile = getProfile(run.profile);
  let landingPath: string | null = null;
  let targetBranch: string | null = null;

  try {
    if (!isLandable(run)) {
      throw new AppError(`Run ${run.id} is ${run.status}; approve it before landing.`);
    }

    setStatus(run.id, 'LANDING', {
      reason:
        mode.kind === 'resolve_conflicts' ? 'resolving merge conflicts' : 'landing approved run',
      started: run.startedAt === null,
    });
    setPhase(run.id, mode.kind === 'resolve_conflicts' ? 'resolving merge conflicts' : 'landing');

    run = await ensureRunBranchCommitted(run, project);
    targetBranch = await resolveLandingTargetBranch(run, project);
    const landingBranch = landingBranchName(run.id);
    landingPath = runLandingDir(project.id, run.id);

    const landing = await ensureLandingWorktree({
      repositoryPath: project.repositoryPath,
      worktreePath: landingPath,
      branch: landingBranch,
      targetBranch,
    });

    appendEvent({
      runId: run.id,
      type: 'landing.started',
      message: `${landing.reused ? 'Reusing' : 'Prepared'} landing worktree ${landing.branch} for ${targetBranch}`,
      payload: {
        path: landing.worktreePath,
        branch: landing.branch,
        targetBranch,
        sourceBranch: run.branch ?? '',
      },
    });

    if (mode.kind === 'resolve_conflicts') {
      const conflictResolution = await tryResolveLandingConflicts({
        run,
        project,
        profile,
        landingPath: landing.worktreePath,
        targetBranch,
        signal,
      });
      if (conflictResolution === 'cancelled') {
        await finishCancelled(run.id);
        return;
      }
      if (conflictResolution === 'stopped') {
        return;
      }
    } else if (
      run.branch &&
      !(await mergeInProgress(landing.worktreePath)) &&
      !(await sourceMergedIntoLanding(landing.worktreePath, run.branch))
    ) {
      await mergeSourceIntoLanding(landing.worktreePath, run.branch);
    }

    if (mode.kind === 'land') {
      const conflictResolution = await tryResolveLandingConflicts({
        run,
        project,
        profile,
        landingPath: landing.worktreePath,
        targetBranch,
        signal,
      });
      if (conflictResolution === 'cancelled') {
        await finishCancelled(run.id);
        return;
      }
      if (conflictResolution === 'stopped') {
        return;
      }
    }

    if (signal.aborted) {
      await finishCancelled(run.id);
      return;
    }

    const completed = await completeMergeIfResolved(landing.worktreePath, {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });
    if (!completed.completed) {
      await finishLandingConflict(run.id, completed.conflicts, {
        run,
        project,
        landingPath: landing.worktreePath,
        targetBranch,
        reason: 'Merge conflicts remain in the landing worktree.',
      });
      return;
    }

    let landingCommitSha =
      completed.commitSha ?? (await resolveCommit(landing.worktreePath, 'HEAD'));
    const manualRepairCommit = await commitLandingWorktreeChangesIfDirty({
      run,
      landingPath: landing.worktreePath,
      landingBranch: landing.branch,
      reason: 'Manual landing worktree changes were present before validation.',
    });
    landingCommitSha = manualRepairCommit ?? landingCommitSha;

    const refreshed = await refreshLandingFromTargetIfNeeded({
      run,
      project,
      profile,
      landingPath: landing.worktreePath,
      landingBranch: landing.branch,
      targetBranch,
      signal,
    });
    if (refreshed.result === 'cancelled') {
      await finishCancelled(run.id);
      return;
    }
    if (refreshed.result === 'stopped') {
      return;
    }
    landingCommitSha = refreshed.commitSha ?? landingCommitSha;

    appendEvent({
      runId: run.id,
      type: 'landing.merged',
      message: `Landing merge ready on ${landing.branch} at ${landingCommitSha.slice(0, 7)}`,
      payload: {
        branch: landing.branch,
        targetBranch,
        sourceBranch: run.branch ?? '',
        commitSha: landingCommitSha,
      },
    });

    await collectLandingEvidence(run, landing.worktreePath, refreshed.targetCommit);

    let validation = await runValidation({
      runId: run.id,
      worktreePath: landing.worktreePath,
      project,
      profile: profile.id,
      signal,
    });

    if (signal.aborted || validation.cancelled) {
      await finishCancelled(run.id);
      return;
    }

    if (validation.blocking) {
      appendLandingValidationFailed(run.id, validation, targetBranch);

      const repair = await tryRepairLandingValidation({
        run,
        project,
        profile,
        landingPath: landing.worktreePath,
        landingBranch: landing.branch,
        targetBranch,
        signal,
      });
      if (repair === 'cancelled') {
        await finishCancelled(run.id);
        return;
      }
      if (repair === 'stopped') {
        return;
      }

      await commitLandingWorktreeChangesIfDirty({
        run,
        landingPath: landing.worktreePath,
        landingBranch: landing.branch,
        reason: 'AI landing repair after validation failure.',
      });
      await collectLandingEvidence(run, landing.worktreePath, refreshed.targetCommit);

      validation = await runValidation({
        runId: run.id,
        worktreePath: landing.worktreePath,
        project,
        profile: profile.id,
        signal,
      });

      if (signal.aborted || validation.cancelled) {
        await finishCancelled(run.id);
        return;
      }

      if (validation.blocking) {
        appendLandingValidationFailed(run.id, validation, targetBranch);
        await finishLandingFailureWithInstructions({
          run,
          project,
          landingPath: landing.worktreePath,
          targetBranch,
          reason: 'Landing validation still failed after the AI repair attempt.',
          validation,
        });
        return;
      }
    }

    const appliedSha = await applyLandingToTarget(
      project.repositoryPath,
      targetBranch,
      landing.branch,
    );
    appendEvent({
      runId: run.id,
      type: 'landing.applied',
      message: `Updated ${targetBranch} to ${appliedSha.slice(0, 7)}`,
      payload: { targetBranch, commitSha: appliedSha },
    });
    setStatus(run.id, 'LANDED', { reason: `landed on ${targetBranch}`, finished: true });
  } catch (err) {
    if (signal.aborted) {
      await finishCancelled(runId);
      return;
    }
    const message = errorMessage(err);
    appendEvent({
      runId,
      type: 'landing.failed',
      level: 'error',
      message,
      payload: { error: message },
    });
    if (landingPath && targetBranch) {
      try {
        await recordLandingManualInstructions({
          run: requireRun(runId),
          project,
          landingPath,
          targetBranch,
          reason: `Landing failed: ${message}`,
        });
      } catch {
        // The original landing failure is the important event.
      }
    }
    updateRunFields(runId, { error: message });
    try {
      setStatus(runId, 'LANDING_FAILED', { reason: message, finished: true, error: message });
    } catch {
      setStatus(runId, 'FAILED', { reason: 'landing error', finished: true, error: message });
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

type ImplementMode =
  | { kind: 'initial' }
  | { kind: 'change_request'; feedback: string; switched: boolean };

async function phaseImplement(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  workMode: WorkModeBehaviour,
  signal: AbortSignal,
  mode: ImplementMode,
): Promise<RunView> {
  if (!run.worktreePath) {
    throw new AppError('This run has no worktree. Start it before requesting changes.');
  }

  const wording = WORK_MODE_WORDING[workMode.id];

  setStatus(run.id, 'IMPLEMENTING', { started: run.startedAt === null });
  setPhase(run.id, wording.activity);

  const agent = getAgent(run.agentProvider);

  const availability = await agent.checkAvailability();
  if (!availability.available) {
    throw new AppError(
      `${agent.label} is not available: ${availability.detail}`,
      { code: 'agent_unavailable' },
    );
  }

  // Resume when a session exists, so a change request keeps context.
  const resumeSessionId = mode.kind === 'change_request' ? run.agentSessionId : null;

  const prompt =
    mode.kind === 'initial'
      ? buildInitialPrompt({ run, project, profile, mode: workMode })
      : buildChangeRequestPrompt({
          run,
          project,
          feedback: mode.feedback,
          validations: latestValidationAttempt(run.id),
          findings: latestFindings(run),
          mode: workMode,
          modeSwitched: mode.switched,
          resumed: resumeSessionId !== null,
          // A resumed session already holds what it wrote. Without one the
          // agent starts cold, so the previous iteration's output has to travel
          // in the prompt or the follow-up asks for work from nothing.
          priorOutput:
            resumeSessionId === null ? (latestIteration(run.id)?.finalText ?? null) : null,
        });

  // A mode can only take capability away, never add it: the read-only modes
  // force Claude Code's own `plan` permission mode over whatever the project
  // resolved to.
  const permissionMode = effectivePermissionMode(project.effectivePermissionMode, workMode);

  const iteration = createIteration({
    runId: run.id,
    kind: mode.kind === 'initial' ? 'initial' : 'change_request',
    prompt,
    sessionId: resumeSessionId,
    resumed: resumeSessionId !== null,
  });

  const modeLabel = WORK_MODE_LABELS[workMode.id];

  appendEvent({
    runId: run.id,
    type: 'agent.started',
    message: resumeSessionId
      ? `Resuming ${agent.label} session ${resumeSessionId.slice(0, 8)} in ${modeLabel} mode (iteration ${iteration.ordinal})`
      : `Starting ${agent.label} in ${modeLabel} mode (iteration ${iteration.ordinal})`,
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
    permissionMode,
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

  // A build run whose agent had tools refused worked with less capability than
  // the prompt assumed. Say so, rather than leaving the user to infer it from a
  // closing message that mentions checks it could not run. In a read-only mode
  // a refusal is the mode doing its job, so it is recorded without the warning.
  if (outcome.deniedTools.length > 0) {
    const denied = outcome.deniedTools.join(', ');
    appendEvent({
      runId: run.id,
      type: 'agent.notice',
      level: workMode.editsCode ? 'notice' : 'info',
      message: workMode.editsCode
        ? `Permission mode "${permissionMode}" refused ${denied} — the implementer could not run commands or verify its own work.`
        : `Permission mode "${permissionMode}" refused ${denied}. Expected in ${modeLabel} mode, which changes nothing.`,
      payload: { iterationId: iteration.id, text: `Denied tools: ${denied}` },
    });
  }

  if (outcome.cancelled) {
    appendEvent({
      runId: run.id,
      type: 'agent.cancelled',
      level: 'notice',
      message: `${wording.progressNoun} cancelled`,
      payload: { iterationId: iteration.id },
    });
    return requireRun(run.id);
  }

  if (!outcome.ok) {
    appendEvent({
      runId: run.id,
      type: 'agent.failed',
      level: 'error',
      message: outcome.errorMessage ?? `The ${wording.agentNoun} failed`,
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
      message: `${wording.progressNoun} finished${
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
    // In a read-only mode the closing message is not a summary of work done,
    // it *is* the work, so where it is stored and what it is called come from
    // the mode rather than being the same for every run.
    const artifact = workMode.outcomeArtifact;
    await writeTextArtifact({
      runId: run.id,
      kind: artifact.kind,
      label: `${artifact.label} (iteration ${iteration.ordinal})`,
      fileName: path.join(artifact.directory, `iteration-${iteration.ordinal}.md`),
      content: outcome.finalText,
      mimeType: 'text/markdown',
      meta: { iterationId: iteration.id, mode: workMode.id },
    });

    if (workMode.summariseOutcome) {
      await phaseSummarise(run, iteration.id, iteration.ordinal, outcome.finalText, signal);
    } else {
      // Compressing the deliverable to three sentences would throw it away.
      appendEvent({
        runId: run.id,
        type: 'summarise.skipped',
        level: 'debug',
        message: `${modeLabel} mode shows the ${wording.deliverable} as written rather than summarising it`,
        payload: {
          provider: runProviders(run.id).transformer,
          iterationId: iteration.id,
          reason: `${workMode.id} mode`,
        },
      });
    }
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
  workMode: WorkModeBehaviour,
  signal: AbortSignal,
): Promise<RunView> {
  if (!run.worktreePath) return run;

  if (!workMode.runValidation) {
    // Not "skipped because it failed to start": there is genuinely nothing to
    // check. Recording six `not_configured` rows instead would put an empty
    // scorecard on the run screen and imply the checks were considered.
    appendEvent({
      runId: run.id,
      type: 'validation.skipped',
      message: `${WORK_MODE_LABELS[workMode.id]} mode changes no files, so no checks were run`,
      payload: { reason: `${workMode.id} mode` },
    });
    return run;
  }

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
  workMode: WorkModeBehaviour,
  signal: AbortSignal,
): Promise<RunView> {
  const providers = runProviders(run.id);

  // Checked before the provider, so the reason given is the real one: a
  // read-only run has no diff to review whether a reviewer is configured or
  // not.
  if (!workMode.runReviewer) {
    appendEvent({
      runId: run.id,
      type: 'review.skipped',
      message: `${WORK_MODE_LABELS[workMode.id]} mode produces no diff to review`,
      payload: { provider: providers.reviewer, reason: `${workMode.id} mode` },
    });
    return run;
  }

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
 * Landing support
 * ------------------------------------------------------------------ */

async function ensureRunBranchCommitted(
  run: RunView,
  project: ProjectView,
  commitMessage?: string,
): Promise<RunView> {
  if (!run.worktreePath || !run.branch) {
    throw new AppError('This run has no worktree to land.');
  }
  if (project.protectedBranches.includes(run.branch)) {
    throw new AppError(`Refusing to commit onto the protected branch ${run.branch}.`, {
      code: 'protected',
    });
  }

  let commitSha = await resolveCommit(project.repositoryPath, run.branch);
  if (await isDirty(run.worktreePath)) {
    const message =
      commitMessage?.trim() || `${run.title}\n\nApproved by Dev Cockpit run ${run.id}.`;
    commitSha = await commitAll(run.worktreePath, message, {
      name: 'Dev Cockpit',
      email: 'dev-cockpit@localhost',
    });
    appendEvent({
      runId: run.id,
      type: 'run.commit_created',
      message: `Created commit ${commitSha.slice(0, 7)} on ${run.branch}`,
      payload: { sha: commitSha, message },
    });
  }

  if (run.baseCommit && commitSha === run.baseCommit) {
    throw new AppError('The run branch has no committed changes to land.', {
      code: 'empty_run_branch',
    });
  }

  updateRunFields(run.id, { commitSha });
  return requireRun(run.id);
}

async function resolveLandingTargetBranch(run: RunView, project: ProjectView): Promise<string> {
  const candidate = run.baseBranch?.trim() || project.defaultBranch;
  if (candidate && (await refExists(project.repositoryPath, `refs/heads/${candidate}`))) {
    return candidate;
  }
  return project.defaultBranch;
}

type LandingAssistResult = 'ok' | 'stopped' | 'cancelled';

type LandingConflictSource =
  | { kind: 'source_merge' }
  | { kind: 'target_refresh'; targetBranch: string };

interface LandingManualInstructionsInput {
  run: RunView;
  project: ProjectView;
  landingPath: string;
  targetBranch: string;
  reason: string;
  conflicts?: readonly string[];
  validation?: ValidationRunSummary;
}

async function finishLandingConflict(
  runId: string,
  files: readonly string[],
  guidance?: Omit<LandingManualInstructionsInput, 'conflicts'>,
): Promise<void> {
  const display = files.length === 1 ? files[0] : `${files.length} files`;
  appendEvent({
    runId,
    type: 'landing.conflicted',
    level: 'notice',
    message: `Landing merge has conflicts in ${display}`,
    payload: { files: [...files] },
  });
  if (guidance) {
    await recordLandingManualInstructions({ ...guidance, conflicts: files });
  }
  setStatus(runId, 'MERGE_CONFLICT', { reason: 'merge conflicts', finished: true });
}

async function tryResolveLandingConflicts(input: {
  run: RunView;
  project: ProjectView;
  profile: ExecutionProfile;
  landingPath: string;
  targetBranch: string;
  signal: AbortSignal;
  conflictSource?: LandingConflictSource;
}): Promise<LandingAssistResult> {
  const conflicts = await unmergedFiles(input.landingPath);
  if (conflicts.length === 0) return 'ok';

  try {
    const resolved = await phaseResolveLandingConflicts(
      input.run,
      input.project,
      input.profile,
      input.landingPath,
      input.signal,
      input.conflictSource,
    );
    if (!resolved) return 'cancelled';
  } catch (err) {
    const message = errorMessage(err);
    await finishLandingConflict(input.run.id, conflicts, {
      ...input,
      reason: `AI conflict resolution could not run: ${message}`,
    });
    return 'stopped';
  }

  const remaining = await unmergedFiles(input.landingPath);
  if (remaining.length > 0) {
    await finishLandingConflict(input.run.id, remaining, {
      ...input,
      reason: 'AI conflict resolution finished, but merge conflicts remain.',
    });
    return 'stopped';
  }

  return 'ok';
}

async function refreshLandingFromTargetIfNeeded(input: {
  run: RunView;
  project: ProjectView;
  profile: ExecutionProfile;
  landingPath: string;
  landingBranch: string;
  targetBranch: string;
  signal: AbortSignal;
}): Promise<{ result: LandingAssistResult; targetCommit: string; commitSha: string | null }> {
  const targetCommit = await resolveCommit(input.project.repositoryPath, input.targetBranch);
  if (await refMergedIntoLanding(input.landingPath, input.targetBranch)) {
    return { result: 'ok', targetCommit, commitSha: null };
  }

  setPhase(input.run.id, 'refreshing landing from target');
  appendEvent({
    runId: input.run.id,
    type: 'landing.refresh_started',
    message: `Refreshing landing worktree with latest ${input.targetBranch} before applying`,
    payload: {
      path: input.landingPath,
      targetBranch: input.targetBranch,
      targetCommit,
    },
  });

  await mergeTargetIntoLanding(input.landingPath, input.targetBranch);
  const conflictResolution = await tryResolveLandingConflicts({
    run: input.run,
    project: input.project,
    profile: input.profile,
    landingPath: input.landingPath,
    targetBranch: input.targetBranch,
    signal: input.signal,
    conflictSource: { kind: 'target_refresh', targetBranch: input.targetBranch },
  });
  if (conflictResolution !== 'ok') {
    return { result: conflictResolution, targetCommit, commitSha: null };
  }

  const completed = await completeMergeIfResolved(input.landingPath, {
    name: 'Dev Cockpit',
    email: 'dev-cockpit@localhost',
  });
  if (!completed.completed) {
    await finishLandingConflict(input.run.id, completed.conflicts, {
      run: input.run,
      project: input.project,
      landingPath: input.landingPath,
      targetBranch: input.targetBranch,
      reason: `Refreshing the landing branch from ${input.targetBranch} left merge conflicts.`,
    });
    return { result: 'stopped', targetCommit, commitSha: null };
  }

  const commitSha = completed.commitSha ?? (await resolveCommit(input.landingPath, 'HEAD'));
  appendEvent({
    runId: input.run.id,
    type: 'landing.refresh_completed',
    message: `Landing worktree includes latest ${input.targetBranch} at ${commitSha.slice(0, 7)}`,
    payload: {
      branch: input.landingBranch,
      targetBranch: input.targetBranch,
      commitSha,
    },
  });

  return { result: 'ok', targetCommit, commitSha };
}

function appendLandingValidationFailed(
  runId: string,
  validation: ValidationRunSummary,
  targetBranch: string,
): void {
  appendEvent({
    runId,
    type: 'landing.validation_failed',
    level: 'notice',
    message: `Landing validation failed: ${validation.failed} blocking failure(s)`,
    payload: { failed: validation.failed, targetBranch },
  });
}

async function tryRepairLandingValidation(input: {
  run: RunView;
  project: ProjectView;
  profile: ExecutionProfile;
  landingPath: string;
  landingBranch: string;
  targetBranch: string;
  signal: AbortSignal;
}): Promise<LandingAssistResult> {
  try {
    const repaired = await phaseRepairLandingValidation(
      input.run,
      input.project,
      input.profile,
      input.landingPath,
      input.signal,
    );
    if (!repaired) return 'cancelled';
  } catch (err) {
    const message = errorMessage(err);
    await finishLandingFailureWithInstructions({
      run: input.run,
      project: input.project,
      landingPath: input.landingPath,
      targetBranch: input.targetBranch,
      reason: `AI landing repair could not run: ${message}`,
    });
    return 'stopped';
  }

  return 'ok';
}

async function commitLandingWorktreeChangesIfDirty(input: {
  run: RunView;
  landingPath: string;
  landingBranch: string;
  reason: string;
}): Promise<string | null> {
  if (await mergeInProgress(input.landingPath)) return null;
  if (!(await isDirty(input.landingPath))) return null;

  const message = `Repair landing for ${input.run.title}

${input.reason}

Dev Cockpit run ${input.run.id}.`;
  const commitSha = await commitAll(input.landingPath, message, {
    name: 'Dev Cockpit',
    email: 'dev-cockpit@localhost',
  });
  appendEvent({
    runId: input.run.id,
    type: 'landing.repair_committed',
    message: `Committed landing repair ${commitSha.slice(0, 7)} on ${input.landingBranch}`,
    payload: { branch: input.landingBranch, commitSha },
  });
  return commitSha;
}

async function finishLandingFailureWithInstructions(
  input: LandingManualInstructionsInput,
): Promise<void> {
  await recordLandingManualInstructions(input);
  setStatus(input.run.id, 'LANDING_FAILED', { reason: input.reason, finished: true });
}

async function recordLandingManualInstructions(
  input: LandingManualInstructionsInput,
): Promise<void> {
  const artifact = await writeTextArtifact({
    runId: input.run.id,
    kind: 'markdown_report',
    label: 'Manual landing repair instructions',
    fileName: path.join('landing', `manual-repair-${Date.now()}.md`),
    content: buildLandingManualInstructions(input),
    mimeType: 'text/markdown',
    meta: {
      targetBranch: input.targetBranch,
      conflicts: input.conflicts?.length ?? 0,
      validationAttempt: input.validation?.attempt ?? null,
    },
  });

  appendEvent({
    runId: input.run.id,
    type: 'landing.manual_instructions',
    level: 'notice',
    message: `Manual landing repair instructions recorded: ${input.reason}`,
    payload: {
      reason: input.reason,
      artifactId: artifact.id,
      path: input.landingPath,
      targetBranch: input.targetBranch,
    },
  });
}

async function collectLandingEvidence(
  run: RunView,
  landingPath: string,
  targetCommit: string,
): Promise<void> {
  const diff = await collectRunDiff(landingPath, targetCommit);
  replaceChangedFiles(run.id, diff.files);

  await writeTextArtifact({
    runId: run.id,
    kind: 'git_diff',
    label: 'Landing diff',
    fileName: path.join('landing', 'changes.diff'),
    content: diff.patch || '(no changes)',
    mimeType: 'text/plain',
    redactContent: false,
    meta: {
      files: diff.files.length,
      additions: diff.additions,
      deletions: diff.deletions,
      truncated: diff.truncated,
      targetCommit,
    },
  });

  await writeTextArtifact({
    runId: run.id,
    kind: 'changed_files',
    label: 'Landing changed files',
    fileName: path.join('landing', 'changed-files.json'),
    content: JSON.stringify(
      { targetCommit, files: diff.files, additions: diff.additions, deletions: diff.deletions },
      null,
      2,
    ),
    mimeType: 'application/json',
    redactContent: false,
  });
}

async function phaseResolveLandingConflicts(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  landingPath: string,
  signal: AbortSignal,
  conflictSource: LandingConflictSource = { kind: 'source_merge' },
): Promise<boolean> {
  const conflicts = await unmergedFiles(landingPath);
  if (conflicts.length === 0) return true;

  setPhase(run.id, 'resolving merge conflicts');
  appendEvent({
    runId: run.id,
    type: 'landing.resolution_started',
    message: `Asking ${getAgent(run.agentProvider).label} to resolve ${conflicts.length} conflicted file(s)`,
    payload: { path: landingPath, files: conflicts },
  });

  const prompt = buildMergeResolutionPrompt(run, project, conflicts, conflictSource);
  const agentRun = await runLandingAgentIteration({
    run,
    project,
    profile,
    landingPath,
    signal,
    kind: 'merge_resolution',
    prompt,
  });
  if (!agentRun.completed) return false;

  const resolution = await stageResolvedConflictFiles(landingPath);
  const unresolved = resolution.conflicts;
  appendEvent({
    runId: run.id,
    type: 'landing.resolution_completed',
    level: unresolved.length > 0 ? 'notice' : 'info',
    message: landingResolutionMessage(resolution),
    payload: {
      iterationId: agentRun.iterationId,
      unresolved,
      staged: resolution.staged,
      markerFiles: resolution.markerFiles,
    },
  });
  return true;
}

async function phaseRepairLandingValidation(
  run: RunView,
  project: ProjectView,
  profile: ExecutionProfile,
  landingPath: string,
  signal: AbortSignal,
): Promise<boolean> {
  const failed = latestValidationAttempt(run.id).filter(
    (result) => result.blocking && BLOCKING_OUTCOMES.includes(result.outcome),
  );
  if (failed.length === 0) return true;

  setPhase(run.id, 'repairing landing validation');
  appendEvent({
    runId: run.id,
    type: 'landing.repair_started',
    message: `Asking ${getAgent(run.agentProvider).label} to repair ${failed.length} failed landing check(s)`,
    payload: { path: landingPath, failed: failed.map((result) => result.kind) },
  });

  const agentRun = await runLandingAgentIteration({
    run,
    project,
    profile,
    landingPath,
    signal,
    kind: 'landing_repair',
    prompt: buildLandingValidationRepairPrompt(run, project, failed),
  });
  return agentRun.completed;
}

async function runLandingAgentIteration(input: {
  run: RunView;
  project: ProjectView;
  profile: ExecutionProfile;
  landingPath: string;
  signal: AbortSignal;
  kind: Extract<IterationKind, 'merge_resolution' | 'landing_repair'>;
  prompt: string;
}): Promise<{ completed: boolean; iterationId: string }> {
  const { run, project, profile, landingPath, signal, kind, prompt } = input;
  const agent = getAgent(run.agentProvider);
  const label = kind === 'merge_resolution' ? 'merge resolution' : 'landing repair';
  const title = kind === 'merge_resolution' ? 'Merge resolution' : 'Landing repair';

  const availability = await agent.checkAvailability();
  if (!availability.available) {
    throw new AppError(`${agent.label} is not available: ${availability.detail}`, {
      code: 'agent_unavailable',
    });
  }

  const iteration = createIteration({
    runId: run.id,
    kind,
    prompt,
    sessionId: null,
    resumed: false,
  });

  appendEvent({
    runId: run.id,
    type: 'agent.started',
    message: `Starting ${agent.label} for ${label} (iteration ${iteration.ordinal})`,
    payload: {
      iterationId: iteration.id,
      provider: agent.id,
      sessionId: null,
      resumed: false,
      model: run.agentModel ?? project.agentModel,
    },
  });

  const outcome: AgentOutcome = await agent.startRun({
    runId: run.id,
    iterationId: iteration.id,
    prompt,
    worktreePath: landingPath,
    additionalDirs: project.agentAddDirs,
    model: run.agentModel ?? project.agentModel,
    permissionMode: project.effectivePermissionMode,
    effort: profile.agentEffort,
    timeoutMs: profile.agentTimeoutMs,
    signal,
    onEvent: (event) => handleAgentEvent(run.id, iteration.id, event),
  });

  if (outcome.rawLogPath) {
    await register({
      runId: run.id,
      kind: 'implementation_log',
      label: `${title} stream (iteration ${iteration.ordinal})`,
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
  if (outcome.costUsd !== null) {
    const fresh = requireRun(run.id);
    updateRunFields(run.id, { costUsd: (fresh.costUsd ?? 0) + outcome.costUsd });
  }

  if (outcome.deniedTools.length > 0) {
    const denied = outcome.deniedTools.join(', ');
    appendEvent({
      runId: run.id,
      type: 'agent.notice',
      level: 'notice',
      message: `Permission mode "${project.effectivePermissionMode}" refused ${denied} during ${label}.`,
      payload: { iterationId: iteration.id, text: `Denied tools: ${denied}` },
    });
  }

  if (outcome.finalText?.trim()) {
    const suffix = kind === 'merge_resolution' ? 'merge' : 'landing-repair';
    await writeTextArtifact({
      runId: run.id,
      kind: 'markdown_report',
      label: `${title} summary (iteration ${iteration.ordinal})`,
      fileName: path.join('summaries', `iteration-${iteration.ordinal}-${suffix}.md`),
      content: outcome.finalText,
      mimeType: 'text/markdown',
      meta: { iterationId: iteration.id },
    });
    await phaseSummarise(run, iteration.id, iteration.ordinal, outcome.finalText, signal);
  }

  if (outcome.cancelled) {
    appendEvent({
      runId: run.id,
      type: 'agent.cancelled',
      level: 'notice',
      message: `${title} cancelled`,
      payload: { iterationId: iteration.id },
    });
    return { completed: false, iterationId: iteration.id };
  }
  if (!outcome.ok) {
    appendEvent({
      runId: run.id,
      type: 'agent.failed',
      level: 'error',
      message: outcome.errorMessage ?? `The ${label} agent failed`,
      payload: {
        iterationId: iteration.id,
        error: outcome.errorMessage ?? 'unknown',
        exitCode: outcome.exitCode,
      },
    });
    throw new AppError(outcome.errorMessage ?? `The ${label} agent failed.`, {
      code: kind === 'merge_resolution' ? 'merge_resolver_failed' : 'landing_repair_failed',
    });
  }

  appendEvent({
    runId: run.id,
    type: 'agent.completed',
    message: `${title} finished${
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

  return { completed: true, iterationId: iteration.id };
}

function landingResolutionMessage(resolution: {
  staged: readonly string[];
  conflicts: readonly string[];
  markerFiles: readonly string[];
}): string {
  if (resolution.markerFiles.length > 0) {
    return `Merge resolver left conflict markers in ${resolution.markerFiles.length} file(s)`;
  }
  if (resolution.conflicts.length > 0) {
    return `Merge resolver left ${resolution.conflicts.length} conflicted file(s)`;
  }
  if (resolution.staged.length > 0) {
    return `Merge resolver cleared all conflicted files; Dev Cockpit staged ${resolution.staged.length} resolved file(s)`;
  }
  return 'Merge resolver cleared all conflicted files';
}

function buildMergeResolutionPrompt(
  run: RunView,
  project: ProjectView,
  conflicts: readonly string[],
  conflictSource: LandingConflictSource = { kind: 'source_merge' },
): string {
  const summary = latestIteration(run.id)?.summary ?? latestIteration(run.id)?.finalText ?? null;
  const situation =
    conflictSource.kind === 'target_refresh'
      ? `The landing worktree already contains conflict markers from refreshing the prepared landing branch with the latest ${conflictSource.targetBranch}.`
      : `The landing worktree already contains conflict markers from merging ${run.branch} into ${
          run.baseBranch ?? project.defaultBranch
        }.`;

  return `You are resolving Git merge conflicts for Dev Cockpit.

Project: ${project.name}
Run: ${run.id}
Request:
${run.request}

${run.spec ? `Implementation specification:\n${run.spec}\n\n` : ''}${
    summary ? `Approved implementation summary:\n${summary}\n\n` : ''
  }${situation}

Resolve the conflicts in these files:
${conflicts.map((file) => `- ${file}`).join('\n')}

Rules:
- Work only inside this landing worktree.
- Preserve the approved run's intent while keeping compatible changes from the target branch.
- Remove all conflict markers.
- Do not commit, merge, push, rebase, reset, or delete the worktree.
- Finish with a short summary of what you resolved.`;
}

type LandingValidationFailure = ReturnType<typeof latestValidationAttempt>[number];

function buildLandingValidationRepairPrompt(
  run: RunView,
  project: ProjectView,
  failures: readonly LandingValidationFailure[],
): string {
  const summary = latestIteration(run.id)?.summary ?? latestIteration(run.id)?.finalText ?? null;
  const details = failures.map(formatValidationFailureForPrompt).join('\n\n');

  return `You are repairing a Dev Cockpit landing worktree after landing validation failed.

Project: ${project.name}
Run: ${run.id}
Request:
${run.request}

${run.spec ? `Implementation specification:\n${run.spec}\n\n` : ''}${
    summary ? `Approved implementation summary:\n${summary}\n\n` : ''
  }The merge has already been prepared in the landing worktree. Fix only the landing worktree so the failed validation checks pass.

Failed blocking checks:
${details}

Rules:
- Work only inside this landing worktree.
- Preserve the approved run's intent while keeping compatible changes from the target branch.
- Make the smallest code/configuration changes needed for the failed checks to pass.
- Run the relevant validation commands after editing when possible.
- Do not commit, merge, push, rebase, reset, checkout another branch, or delete the worktree.
- Finish with a short summary of what you repaired.`;
}

function buildLandingManualInstructions(input: LandingManualInstructionsInput): string {
  const failed = latestValidationAttempt(input.run.id).filter(
    (result) => result.blocking && BLOCKING_OUTCOMES.includes(result.outcome),
  );
  const hasConflicts = (input.conflicts?.length ?? 0) > 0;
  const hasFailedValidation = failed.length > 0;
  const targetCheckoutBlocked = /checkout (?:is on|has uncommitted changes)/i.test(input.reason);
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const landingCdCommand =
    process.platform === 'win32'
      ? `Set-Location -LiteralPath ${quotePowerShell(input.landingPath)}`
      : `cd ${quotePosix(input.landingPath)}`;
  const repositoryCdCommand =
    process.platform === 'win32'
      ? `Set-Location -LiteralPath ${quotePowerShell(input.project.repositoryPath)}`
      : `cd ${quotePosix(input.project.repositoryPath)}`;

  const sections = [
    '# Manual landing repair',
    `Run: ${input.run.id}`,
    `Project: ${input.project.name}`,
    `Landing worktree: ${input.landingPath}`,
    `Target branch: ${input.targetBranch}`,
    `Source branch: ${input.run.branch ?? '(unknown)'}`,
    '## What failed',
    input.reason,
  ];

  if (input.conflicts && input.conflicts.length > 0) {
    sections.push('## Conflicted files', input.conflicts.map((file) => `- ${file}`).join('\n'));
  }

  if (failed.length > 0) {
    sections.push('## Failed validation checks', failed.map(formatValidationFailureForManual).join('\n\n'));
  }

  const steps: string[] = [];
  const addStep = (text: string) => steps.push(`${steps.length + 1}. ${text}`);

  if (targetCheckoutBlocked) {
    addStep(
      [
        'Open the original repository checkout and inspect its state.',
        '',
        codeFence(shell, `${repositoryCdCommand}\ngit status --short --branch`),
      ].join('\n'),
    );

    addStep(
      `Preserve or clear local work in the original checkout. Commit it, stash it, or move it out of the tree. If the checkout is on another branch, switch back to ${inlineCode(
        input.targetBranch,
      )} after preserving local edits.`,
    );
  }

  if (hasConflicts || hasFailedValidation || !targetCheckoutBlocked) {
    addStep(
      [
        'Open the landing worktree and inspect Git state.',
        '',
        codeFence(shell, `${landingCdCommand}\ngit status --short`),
      ].join('\n'),
    );
  }

  if (hasConflicts) {
    addStep(
      [
        'Resolve the conflicted files. Remove every conflict marker, keep the intended behavior from the approved run, and keep compatible changes from the target branch.',
        '',
        codeFence(shell, 'git diff --check\ngit add --all'),
      ].join('\n'),
    );
  }

  if (hasFailedValidation) {
    addStep(
      'Re-run the failed validation commands from the landing worktree. If a row names a working directory, run that command from that directory. Edit only the landing worktree until the blocking checks pass.',
    );
  }

  if (hasConflicts || hasFailedValidation) {
    addStep(
      'Leave any repair edits in the landing worktree. Dev Cockpit will commit uncommitted landing-worktree changes on the next landing retry before it validates and fast-forwards the target branch.',
    );
  }

  addStep(`Return to Dev Cockpit and click ${inlineCode(`Land on ${input.targetBranch}`)} again.`);

  sections.push('## Steps', steps.join('\n\n'));
  sections.push('## Guardrails', '- Do not push from Dev Cockpit.\n- Do not manually merge the landing branch into the target checkout unless you are abandoning this landing attempt.\n- Do not delete the landing worktree; Dev Cockpit reuses it on retry.');

  return `${sections.join('\n\n')}\n`;
}

function formatValidationFailureForPrompt(failure: LandingValidationFailure): string {
  const output = validationOutputExcerpt(failure, 4_000);
  return [
    `### ${failure.kind}`,
    `Command: ${failure.command ?? '(no command recorded)'}`,
    `Working directory: ${failure.workingDir ?? '(worktree root)'}`,
    `Outcome: ${failure.outcome}`,
    `Exit code: ${failure.exitCode ?? '(none)'}`,
    output ? `Output excerpt:\n${codeFence('', output)}` : 'Output excerpt: (empty)',
  ].join('\n');
}

function formatValidationFailureForManual(failure: LandingValidationFailure): string {
  const output = validationOutputExcerpt(failure, 2_000);
  const lines = [
    `### ${failure.kind}`,
    `- Command: ${inlineCode(failure.command ?? '(no command recorded)')}`,
    `- Working directory: ${inlineCode(failure.workingDir ?? '(worktree root)')}`,
    `- Outcome: ${failure.outcome}`,
    `- Exit code: ${failure.exitCode ?? '(none)'}`,
  ];
  if (output) lines.push(`\n${codeFence('', output)}`);
  return lines.join('\n');
}

function validationOutputExcerpt(failure: LandingValidationFailure, limit: number): string {
  const parts = [
    failure.error ? `Error: ${failure.error}` : null,
    failure.stdout?.trim() ? `stdout:\n${failure.stdout.trim()}` : null,
    failure.stderr?.trim() ? `stderr:\n${failure.stderr.trim()}` : null,
  ].filter((part): part is string => part !== null);
  return tailText(parts.join('\n\n'), limit);
}

function tailText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `... [truncated to the last ${limit} characters] ...\n${text.slice(-limit)}`;
}

function codeFence(info: string, value: string): string {
  const escaped = value.replaceAll('```', '` ` `');
  return [`\`\`\`${info}`, escaped, '```'].join('\n');
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', '\\`')}\``;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/* ------------------------------------------------------------------ *
 * Phase: decide
 * ------------------------------------------------------------------ */

/**
 * Decides READY or NEEDS_CHANGES from stored state.
 *
 * This is where IMPLEMENTER != APPROVER becomes concrete: the agent's own
 * summary is not consulted. Only recorded validation outcomes, recorded
 * findings, and the project's policies decide. The working mode changes what
 * counts as evidence, never who decides.
 */
async function phaseDecide(
  run: RunView,
  project: ProjectView,
  workMode: WorkModeBehaviour,
): Promise<void> {
  const fresh = requireRun(run.id);
  const assessment = assessReadiness(fresh, project);

  const deliverable = WORK_MODE_WORDING[workMode.id].deliverable;

  if (assessment.ready) {
    setStatus(fresh.id, 'READY', {
      reason: workMode.editsCode ? 'validation passed' : `${deliverable} written`,
      finished: true,
    });
    appendEvent({
      runId: fresh.id,
      type: 'run.ready',
      message: workMode.editsCode
        ? `Ready for review: ${assessment.validationsPassed} check(s) passed`
        : `The ${deliverable} is ready for review`,
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
 * Approval records the decision and creates a commit on the run branch by
 * default. Landing remains a separate action that validates an isolated merge
 * before the target checkout is updated.
 */
export async function approveRun(runId: string, options: ApproveOptions = {}): Promise<RunView> {
  const run = requireRun(runId);
  const project = requireProject(run.projectId);

  if (isRunActive(runId)) {
    throw new AppError('Cancel the run before approving it.', { code: 'busy' });
  }

  let commitSha: string | null = run.commitSha;

  if (options.createCommit ?? true) {
    const message =
      options.commitMessage?.trim() ||
      `${run.title}\n\nImplemented by Dev Cockpit run ${run.id}.`;
    const committed = await ensureRunBranchCommitted(run, project, message);
    commitSha = committed.commitSha;
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
