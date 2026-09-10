import 'server-only';

import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import {
  changedFiles,
  iterations,
  projects,
  reviewFindings,
  runs,
  validationResults,
} from '@/db/schema';
import { newIterationId, newRunId, runBranchName } from '@/core/ids';
import { notFound } from '@/core/errors';
import {
  effectiveWorkMode,
  resolveWorkMode,
  WORK_MODE_LABELS,
  WORK_MODE_WORDING,
  workModeSchema,
  type ResolvedWorkMode,
  type WorkMode,
} from '@/domain/modes';
import { CLAUDE_CODE_PROVIDER, resolveAgentModel } from '@/domain/models';
import { getProfile, recommendedModelFor } from '@/orchestrator/profiles';
import {
  ACTIVE_STATUSES,
  assertTransition,
  BLOCKING_OUTCOMES,
  BLOCKING_SEVERITIES,
  executionProfileSchema,
  VALIDATION_KINDS,
  type ChangeType,
  type Disposition,
  type FindingSeverity,
  type IterationKind,
  type IterationStatus,
  type RunStatus,
  type ValidationKind,
  type ValidationOutcome,
} from '@/domain/types';
import type { FileChange } from '@/git/diff';
import { listAttachments, type AttachmentView } from './attachments';
import { appendEvent } from './events';
import { fromLines, requireProject, type ProjectView } from './projects';
import type { ReviewFinding } from '@/reviewers/types';

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export const createRunSchema = z.object({
  projectId: z.string().trim().min(1),
  request: z.string().trim().min(1).max(20_000),
  title: z.string().trim().max(200).optional(),
  profile: executionProfileSchema.default('standard'),
  /**
   * Model for this run, overriding both the project default and the profile's
   * recommendation. Blank or absent leaves that precedence intact.
   */
  model: z.string().trim().max(120).optional(),
  /** Working mode: `plan`, `build`, or `auto` to decide from the request. */
  mode: workModeSchema.default('build'),
  /** Transformer provider id, or 'none'. */
  transformer: z.string().trim().max(60).optional(),
  /** Reviewer provider id, or 'none'. */
  reviewer: z.string().trim().max(60).optional(),
  /** Branch or commit the run starts from. Defaults to the project default. */
  baseRef: z.string().trim().max(200).optional(),
});

/**
 * The input type, not the parsed output type: `profile` and `mode` have
 * defaults, so `z.infer` would wrongly require callers to supply them.
 */
export type CreateRunInput = z.input<typeof createRunSchema>;

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export interface IterationView {
  id: string;
  ordinal: number;
  kind: IterationKind;
  prompt: string;
  status: IterationStatus;
  sessionId: string | null;
  resumed: boolean;
  exitCode: number | null;
  numTurns: number | null;
  costUsd: number | null;
  finalText: string | null;
  summary: string | null;
  summaryProvider: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ValidationResultView {
  id: string;
  attempt: number;
  kind: ValidationKind;
  commandSource: string;
  command: string | null;
  workingDir: string | null;
  outcome: ValidationOutcome;
  blocking: boolean;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChangedFileView {
  path: string;
  previousPath: string | null;
  changeType: ChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ReviewFindingView {
  id: string;
  attempt: number;
  provider: string;
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  file: string | null;
  line: number | null;
  suggestion: string | null;
  createdAt: string;
}

export interface RunView {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  request: string;
  spec: string | null;
  specProvider: string | null;
  status: RunStatus;
  statusReason: string | null;
  profile: string;
  /** What the user chose: `plan`, `build` or `auto`. Never rewritten. */
  mode: WorkMode;
  /**
   * The mode the run is executing in. Null on rows written before modes
   * existed; `effectiveWorkMode` reads those as `build`.
   */
  resolvedMode: ResolvedWorkMode | null;
  baseBranch: string | null;
  baseCommit: string | null;
  branch: string | null;
  worktreePath: string | null;
  commitSha: string | null;
  agentProvider: string;
  agentSessionId: string | null;
  agentModel: string | null;
  transformerProvider: string;
  reviewerProvider: string;
  disposition: Disposition | null;
  dispositionNote: string | null;
  error: string | null;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  iterations: IterationView[];
  validations: ValidationResultView[];
  changedFiles: ChangedFileView[];
  findings: ReviewFindingView[];
  /**
   * Files the developer attached to the request.
   *
   * Part of the run rather than a separate lookup because both prompt builders
   * and the run screen need them, and a request whose attachments arrive by a
   * different route is a request that can be read without them.
   */
  attachments: AttachmentView[];
}

/* ------------------------------------------------------------------ *
 * Provider choices
 * ------------------------------------------------------------------ */

export interface RunProviderChoices {
  transformer: string;
  reviewer: string;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

function hydrateIteration(row: typeof iterations.$inferSelect): IterationView {
  return {
    id: row.id,
    ordinal: row.ordinal,
    kind: row.kind as IterationKind,
    prompt: row.prompt,
    status: row.status as IterationStatus,
    sessionId: row.sessionId,
    resumed: row.resumed,
    exitCode: row.exitCode,
    numTurns: row.numTurns,
    costUsd: row.costUsd,
    finalText: row.finalText,
    summary: row.summary,
    summaryProvider: row.summaryProvider,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function hydrateValidation(row: typeof validationResults.$inferSelect): ValidationResultView {
  return {
    id: row.id,
    attempt: row.attempt,
    kind: row.kind as ValidationKind,
    commandSource: row.commandSource,
    command: row.command,
    workingDir: row.workingDir,
    outcome: row.outcome as ValidationOutcome,
    blocking: row.blocking,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    stdout: row.stdout,
    stderr: row.stderr,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function getRun(id: string): RunView | null {
  const db = getDb();
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!row) return null;

  const projectView = requireProject(row.projectId);

  const iterationRows = db
    .select()
    .from(iterations)
    .where(eq(iterations.runId, id))
    .orderBy(asc(iterations.ordinal))
    .all();

  const validationRows = db
    .select()
    .from(validationResults)
    .where(eq(validationResults.runId, id))
    .orderBy(asc(validationResults.attempt))
    .all();

  const fileRows = db
    .select()
    .from(changedFiles)
    .where(eq(changedFiles.runId, id))
    .orderBy(asc(changedFiles.path))
    .all();

  const findingRows = db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.runId, id))
    .orderBy(desc(reviewFindings.attempt))
    .all();

  return {
    id: row.id,
    projectId: row.projectId,
    projectName: projectView.name,
    title: row.title,
    request: row.request,
    spec: row.spec,
    specProvider: row.specProvider,
    status: row.status as RunStatus,
    statusReason: row.statusReason,
    profile: row.profile,
    mode: row.mode as WorkMode,
    resolvedMode: row.resolvedMode as ResolvedWorkMode | null,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    branch: row.branch,
    worktreePath: row.worktreePath,
    commitSha: row.commitSha,
    agentProvider: row.agentProvider,
    agentSessionId: row.agentSessionId,
    agentModel: row.agentModel,
    transformerProvider: row.transformerProvider,
    reviewerProvider: row.reviewerProvider,
    disposition: row.disposition as Disposition | null,
    dispositionNote: row.dispositionNote,
    error: row.error,
    costUsd: row.costUsd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    iterations: iterationRows.map(hydrateIteration),
    validations: validationRows.map(hydrateValidation),
    changedFiles: fileRows.map((f) => ({
      path: f.path,
      previousPath: f.previousPath,
      changeType: f.changeType as ChangeType,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
    })),
    findings: findingRows.map((f) => ({
      id: f.id,
      attempt: f.attempt,
      provider: f.provider,
      severity: f.severity as FindingSeverity,
      title: f.title,
      detail: f.detail,
      file: f.file,
      line: f.line,
      suggestion: f.suggestion,
      createdAt: f.createdAt,
    })),
    attachments: listAttachments(id),
  };
}

export function requireRun(id: string): RunView {
  const run = getRun(id);
  if (!run) throw notFound(`Run ${id}`);
  return run;
}

export interface RunListItem {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: RunStatus;
  profile: string;
  mode: WorkMode;
  resolvedMode: ResolvedWorkMode | null;
  branch: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  changedFileCount: number;
  validationSummary: { passed: number; failed: number; running: number };
  blockingFindings: number;
}

export interface ListRunsOptions {
  projectId?: string;
  statuses?: readonly RunStatus[];
  limit?: number;
}

export function listRuns(options: ListRunsOptions = {}): RunListItem[] {
  const { projectId, statuses, limit = 100 } = options;
  const db = getDb();

  const conditions = [];
  if (projectId) conditions.push(eq(runs.projectId, projectId));
  if (statuses && statuses.length > 0) conditions.push(inArray(runs.status, [...statuses]));

  const rows = db
    .select()
    .from(runs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const runIds = rows.map((r) => r.id);
  const projectNames = new Map(
    listProjectNames().map((p) => [p.id, p.name] as const),
  );

  const fileCounts = new Map<string, number>();
  for (const row of db
    .select({ runId: changedFiles.runId })
    .from(changedFiles)
    .where(inArray(changedFiles.runId, runIds))
    .all()) {
    fileCounts.set(row.runId, (fileCounts.get(row.runId) ?? 0) + 1);
  }

  const validationRows = db
    .select()
    .from(validationResults)
    .where(inArray(validationResults.runId, runIds))
    .all();

  const findingRows = db
    .select({ runId: reviewFindings.runId, severity: reviewFindings.severity })
    .from(reviewFindings)
    .where(inArray(reviewFindings.runId, runIds))
    .all();

  return rows.map((row) => {
    const latestAttempt = validationRows
      .filter((v) => v.runId === row.id)
      .reduce((acc, v) => Math.max(acc, v.attempt), 0);
    const current = validationRows.filter(
      (v) => v.runId === row.id && v.attempt === latestAttempt,
    );

    return {
      id: row.id,
      projectId: row.projectId,
      projectName: projectNames.get(row.projectId) ?? 'Unknown project',
      title: row.title,
      status: row.status as RunStatus,
      profile: row.profile,
      mode: row.mode as WorkMode,
      resolvedMode: row.resolvedMode as ResolvedWorkMode | null,
      branch: row.branch,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      changedFileCount: fileCounts.get(row.id) ?? 0,
      validationSummary: {
        passed: current.filter((v) => v.outcome === 'pass').length,
        failed: current.filter((v) => BLOCKING_OUTCOMES.includes(v.outcome as ValidationOutcome))
          .length,
        running: current.filter((v) => v.outcome === 'running').length,
      },
      blockingFindings: findingRows.filter(
        (f) =>
          f.runId === row.id && BLOCKING_SEVERITIES.includes(f.severity as FindingSeverity),
      ).length,
    };
  });
}

function listProjectNames(): { id: string; name: string }[] {
  const db = getDb();
  return db.select({ id: projects.id, name: projects.name }).from(projects).all();
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export function createRun(input: CreateRunInput): RunView {
  const parsed = createRunSchema.parse(input);
  const project = requireProject(parsed.projectId);
  const db = getDb();

  const id = newRunId();
  const title = parsed.title?.trim() || deriveTitle(parsed.request);

  // Resolved before the run exists, from the request as typed. `auto` is a
  // choice between the other two modes, not a third behaviour, so nothing
  // downstream ever has to handle it.
  const resolution = resolveWorkMode(parsed.mode, parsed.request);

  /**
   * Resolved at creation and written down, rather than derived at each phase.
   *
   * Same reason the provider choices are stored per run: changing a project
   * default, or the recommendation attached to a profile, must not retroactively
   * change what an existing run reports having used. It also means the model the
   * New Task form showed is the model on the row.
   */
  const model = resolveAgentModel({
    requested: parsed.model,
    projectDefault: project.agentModel,
    recommended: recommendedModelFor(getProfile(parsed.profile), CLAUDE_CODE_PROVIDER),
  });

  db.insert(runs)
    .values({
      id,
      projectId: project.id,
      title,
      request: parsed.request,
      status: 'DRAFT',
      profile: parsed.profile,
      mode: parsed.mode,
      resolvedMode: resolution.mode,
      baseBranch: parsed.baseRef?.trim() || project.defaultBranch,
      branch: runBranchName(id),
      agentProvider: CLAUDE_CODE_PROVIDER,
      agentModel: model.model,
      transformerProvider: parsed.transformer ?? 'none',
      reviewerProvider: parsed.reviewer ?? 'none',
    })
    .run();

  appendEvent({
    runId: id,
    type: 'run.created',
    message: `Run created in ${WORK_MODE_LABELS[resolution.mode]} mode: ${title}`,
    payload: {
      title,
      request: parsed.request,
      profile: parsed.profile,
      mode: parsed.mode,
      resolvedMode: resolution.mode,
      model: model.model,
      modelSource: model.source,
    },
  });

  // Only when something was actually decided. An explicit choice is already
  // stated by the event above, and repeating it would be noise in the feed.
  if (resolution.automatic) {
    appendEvent({
      runId: id,
      type: 'run.mode_selected',
      message: `Auto chose ${WORK_MODE_LABELS[resolution.mode]} mode: ${resolution.reason}`,
      payload: { requested: parsed.mode, resolved: resolution.mode, reason: resolution.reason },
    });
  }

  return requireRun(id);
}

/**
 * Switches the mode a run is executing in.
 *
 * The requested mode on the run is left alone: what the user originally asked
 * for stays readable, and the switch itself is recorded as an event, which is
 * the audit trail for everything else in a run too.
 */
export function switchRunMode(runId: string, to: ResolvedWorkMode, reason: string): void {
  const db = getDb();
  const row = db
    .select({ mode: runs.mode, resolvedMode: runs.resolvedMode })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!row) throw notFound(`Run ${runId}`);

  const from = effectiveWorkMode(row);
  if (from === to) return;

  db.update(runs)
    .set({ resolvedMode: to, updatedAt: new Date().toISOString() })
    .where(eq(runs.id, runId))
    .run();

  appendEvent({
    runId,
    type: 'run.mode_switched',
    level: 'notice',
    message: `Mode switched from ${WORK_MODE_LABELS[from]} to ${WORK_MODE_LABELS[to]}: ${reason}`,
    payload: { from, to, reason },
  });
}

/** First line of the request, trimmed to a sane length. */
export function deriveTitle(request: string): string {
  const firstLine = request
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const base = (firstLine ?? 'Untitled run').replace(/\s+/g, ' ');
  return base.length > 120 ? `${base.slice(0, 117)}...` : base;
}

export function runProviders(runId: string): RunProviderChoices {
  const db = getDb();
  const row = db
    .select({ transformer: runs.transformerProvider, reviewer: runs.reviewerProvider })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  return { transformer: row?.transformer ?? 'none', reviewer: row?.reviewer ?? 'none' };
}

export interface StatusChangeOptions {
  reason?: string;
  error?: string | null;
  finished?: boolean;
  started?: boolean;
}

/**
 * The single write path for run status.
 *
 * Every change goes through the transition table and appends an event, which is
 * what makes stored state — not the agent's opinion — the source of truth.
 */
export function setStatus(
  runId: string,
  to: RunStatus,
  options: StatusChangeOptions = {},
): RunStatus {
  const db = getDb();
  const row = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
  if (!row) throw notFound(`Run ${runId}`);

  const from = row.status as RunStatus;
  if (from === to) return to;
  assertTransition(from, to);

  const nowIso = new Date().toISOString();
  const nextError =
    options.error !== undefined
      ? options.error
      : to === 'FAILED' || to === 'LANDING_FAILED'
        ? undefined
        : null;
  db.update(runs)
    .set({
      status: to,
      statusReason: options.reason ?? null,
      updatedAt: nowIso,
      ...(nextError !== undefined ? { error: nextError } : {}),
      ...(options.started ? { startedAt: nowIso } : {}),
      ...(ACTIVE_STATUSES.includes(to) ? { finishedAt: null } : {}),
      ...(options.finished ? { finishedAt: nowIso } : {}),
    })
    .where(eq(runs.id, runId))
    .run();

  appendEvent({
    runId,
    type: 'run.status_changed',
    level: to === 'FAILED' ? 'error' : to === 'PAUSED' ? 'notice' : 'info',
    message: `${from} → ${to}${options.reason ? ` (${options.reason})` : ''}`,
    payload: { from, to, reason: options.reason },
  });

  return to;
}

export function updateRunFields(
  runId: string,
  fields: Partial<{
    title: string;
    spec: string | null;
    specProvider: string | null;
    baseBranch: string;
    /** Nullable so a restart can clear it and have prepare resolve it again. */
    baseCommit: string | null;
    branch: string;
    /** Cleared to null once the worktree is gone â€” reclaimed, or torn down by a restart. */
    worktreePath: string | null;
    agentProvider: string;
    agentSessionId: string | null;
    agentModel: string | null;
    commitSha: string | null;
    costUsd: number | null;
    disposition: Disposition | null;
    dispositionNote: string | null;
    error: string | null;
  }>,
): void {
  const db = getDb();
  db.update(runs)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(runs.id, runId))
    .run();
}

/**
 * Puts a run back to the state it was created in, for a forced restart.
 *
 * What is cleared and what is kept follows one rule: **derived state resets,
 * the record does not.** Anything the next pass will produce again — worktree,
 * base commit, specification, agent session, commit, disposition, the changed
 * file set — is cleared, so the run screen never shows evidence belonging to an
 * attempt that no longer exists. Anything that is a record of what happened —
 * events, iterations, artifacts, attempt-numbered validation results and
 * review findings — is kept, because a restart is a new attempt at the request,
 * not a way of erasing the last one.
 *
 * `costUsd` is deliberately kept. That money was spent. Zeroing it would make
 * the run under-report what it cost, which is the one number a user cannot
 * recover from anywhere else.
 *
 * The caller removes the worktree and settles on `branch` first: this only
 * writes, and writing a cleared `worktreePath` while the directory still
 * existed would lose the app's only handle on it.
 */
export function resetRunForRestart(
  runId: string,
  input: {
    branch: string;
    reason: string;
    /** Whether a worktree directory was actually removed before this call. */
    worktreeRemoved: boolean;
    /** Whether in-flight work had to be stopped to get here. */
    stoppedActiveWork: boolean;
  },
): RunView {
  const run = requireRun(runId);

  setStatus(runId, 'DRAFT', { reason: input.reason, error: null });

  updateRunFields(runId, {
    branch: input.branch,
    worktreePath: null,
    baseCommit: null,
    spec: null,
    specProvider: null,
    agentSessionId: null,
    commitSha: null,
    disposition: null,
    dispositionNote: null,
    error: null,
  });

  // The run's start and finish times describe the attempt being discarded.
  // `setStatus(..., { started: true })` writes `startedAt` again on the next
  // pass, so clearing them here keeps the elapsed clock honest.
  const db = getDb();
  db.update(runs)
    .set({ startedAt: null, finishedAt: null, updatedAt: new Date().toISOString() })
    .where(eq(runs.id, runId))
    .run();

  // The recorded diff describes a worktree that no longer exists.
  replaceChangedFiles(runId, []);

  appendEvent({
    runId,
    type: 'run.restarted',
    level: 'notice',
    message: `Restarted from ${run.baseBranch ?? 'the base branch'} on ${input.branch}: ${input.reason}`,
    payload: {
      reason: input.reason,
      branch: input.branch,
      previousBranch: run.branch,
      worktreeRemoved: input.worktreeRemoved,
      stoppedActiveWork: input.stoppedActiveWork,
    },
  });

  return requireRun(runId);
}

/* ------------------------------------------------------------------ *
 * Iterations
 * ------------------------------------------------------------------ */

export function createIteration(input: {
  runId: string;
  kind: IterationKind;
  prompt: string;
  sessionId: string | null;
  resumed: boolean;
}): IterationView {
  const db = getDb();
  const current = db
    .select({ value: max(iterations.ordinal) })
    .from(iterations)
    .where(eq(iterations.runId, input.runId))
    .get();

  const ordinal = (current?.value ?? 0) + 1;
  const id = newIterationId();

  db.insert(iterations)
    .values({
      id,
      runId: input.runId,
      ordinal,
      kind: input.kind,
      prompt: input.prompt,
      status: 'running',
      sessionId: input.sessionId,
      resumed: input.resumed,
    })
    .run();

  const row = db.select().from(iterations).where(eq(iterations.id, id)).get();
  if (!row) throw new Error('Failed to create iteration');
  return hydrateIteration(row);
}

export function finishIteration(
  iterationId: string,
  fields: {
    status: IterationStatus;
    sessionId?: string | null;
    exitCode?: number | null;
    numTurns?: number | null;
    costUsd?: number | null;
    finalText?: string | null;
    error?: string | null;
  },
): void {
  const db = getDb();
  db.update(iterations)
    .set({ ...fields, finishedAt: new Date().toISOString() })
    .where(eq(iterations.id, iterationId))
    .run();
}

/**
 * Records a transformer's reading of the agent's closing message.
 *
 * Separate from `finishIteration` because it lands later — the summary is
 * produced after the iteration is already closed, and must never overwrite
 * `finalText`.
 */
export function setIterationSummary(
  iterationId: string,
  summary: string,
  provider: string,
): void {
  const db = getDb();
  db.update(iterations)
    .set({ summary, summaryProvider: provider })
    .where(eq(iterations.id, iterationId))
    .run();
}

export function latestIteration(runId: string): IterationView | null {
  const db = getDb();
  const row = db
    .select()
    .from(iterations)
    .where(eq(iterations.runId, runId))
    .orderBy(desc(iterations.ordinal))
    .limit(1)
    .get();
  return row ? hydrateIteration(row) : null;
}

/* ------------------------------------------------------------------ *
 * Changed files
 * ------------------------------------------------------------------ */

/** Replaces the recorded file set. The diff is recomputed, not accumulated. */
export function replaceChangedFiles(runId: string, files: readonly FileChange[]): void {
  const db = getDb();
  db.delete(changedFiles).where(eq(changedFiles.runId, runId)).run();
  if (files.length === 0) return;

  db.insert(changedFiles)
    .values(
      files.map((f) => ({
        runId,
        path: f.path,
        changeType: f.changeType,
        additions: f.additions,
        deletions: f.deletions,
        previousPath: f.previousPath,
        binary: f.binary,
      })),
    )
    .run();
}

/* ------------------------------------------------------------------ *
 * Validation results
 * ------------------------------------------------------------------ */

export function nextValidationAttempt(runId: string): number {
  const db = getDb();
  const row = db
    .select({ value: max(validationResults.attempt) })
    .from(validationResults)
    .where(eq(validationResults.runId, runId))
    .get();
  return (row?.value ?? 0) + 1;
}

export function upsertValidationResult(input: {
  id: string;
  runId: string;
  attempt: number;
  kind: ValidationKind;
  commandSource?: string;
  command: string | null;
  workingDir: string | null;
  outcome: ValidationOutcome;
  blocking: boolean;
  exitCode?: number | null;
  durationMs?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}): void {
  const db = getDb();
  const existing = db
    .select({ id: validationResults.id })
    .from(validationResults)
    .where(eq(validationResults.id, input.id))
    .get();

  const values = {
    runId: input.runId,
    attempt: input.attempt,
    kind: input.kind,
    commandSource: input.commandSource ?? 'project',
    command: input.command,
    workingDir: input.workingDir,
    outcome: input.outcome,
    blocking: input.blocking,
    exitCode: input.exitCode ?? null,
    durationMs: input.durationMs ?? null,
    stdout: input.stdout ?? null,
    stderr: input.stderr ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
  };

  if (existing) {
    db.update(validationResults).set(values).where(eq(validationResults.id, input.id)).run();
    return;
  }

  db.insert(validationResults)
    .values({ id: input.id, ...values })
    .run();
}

export function latestValidationAttempt(runId: string): ValidationResultView[] {
  const db = getDb();
  const attempt = db
    .select({ value: max(validationResults.attempt) })
    .from(validationResults)
    .where(eq(validationResults.runId, runId))
    .get();
  if (!attempt?.value) return [];

  return db
    .select()
    .from(validationResults)
    .where(
      and(eq(validationResults.runId, runId), eq(validationResults.attempt, attempt.value)),
    )
    .all()
    .map(hydrateValidation);
}

/* ------------------------------------------------------------------ *
 * Review findings
 * ------------------------------------------------------------------ */

export function nextReviewAttempt(runId: string): number {
  const db = getDb();
  const row = db
    .select({ value: max(reviewFindings.attempt) })
    .from(reviewFindings)
    .where(eq(reviewFindings.runId, runId))
    .get();
  return (row?.value ?? 0) + 1;
}

export function insertFindings(
  runId: string,
  attempt: number,
  provider: string,
  findings: readonly ReviewFinding[],
): ReviewFindingView[] {
  if (findings.length === 0) return [];
  const db = getDb();
  const rows = findings.map((f, index) => ({
    id: `fnd_${runId}_${attempt}_${index}`,
    runId,
    attempt,
    provider,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    file: f.file,
    line: f.line,
    suggestion: f.suggestion,
  }));

  db.insert(reviewFindings).values(rows).run();

  return rows.map((r) => ({
    id: r.id,
    attempt: r.attempt,
    provider: r.provider,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    file: r.file,
    line: r.line,
    suggestion: r.suggestion,
    createdAt: new Date().toISOString(),
  }));
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

export interface ReadinessAssessment {
  ready: boolean;
  /** Human-facing reasons the run is not ready. */
  reasons: string[];
  /** Which mode the assessment was made for. The bar differs. */
  mode: ResolvedWorkMode;
  validationsPassed: number;
  validationsFailed: number;
  validationsNotConfigured: number;
  blockingFindings: number;
}

/**
 * Decides whether a run may become READY, from stored state alone.
 *
 * Nothing the implementer said is consulted, in any mode. What changes with the
 * mode is what counts as evidence: a build run is judged on validation results
 * and a diff, a read-only run on whether its deliverable exists and nothing was
 * touched while producing it.
 */
export function assessReadiness(run: RunView, project: ProjectView): ReadinessAssessment {
  const mode = effectiveWorkMode(run);
  return mode === 'build' ? assessBuildReadiness(run, project) : assessReadOnlyReadiness(run, mode);
}

/** How many blocking findings the latest review attempt recorded. */
function countBlockingFindings(run: RunView): number {
  const attempt = run.findings.reduce((acc, f) => Math.max(acc, f.attempt), 0);
  return run.findings.filter(
    (f) => f.attempt === attempt && BLOCKING_SEVERITIES.includes(f.severity),
  ).length;
}

/**
 * Readiness for a read-only run: Ask or Plan.
 *
 * These produce a document, so the validation scorecard has nothing to say
 * about them and demanding a green one would block every plan forever. Two
 * things are checked instead: the deliverable exists, and the worktree is
 * untouched — because "changes nothing" is the promise both modes make, and a
 * broken promise is exactly what a person needs to see.
 *
 * A finished iteration is not enough on its own. An iteration that failed or
 * was cancelled can still carry partial text, and partial text presented as a
 * finished plan is the same class of mistake as a green badge on an unrun test.
 */
function assessReadOnlyReadiness(run: RunView, mode: ResolvedWorkMode): ReadinessAssessment {
  const reasons: string[] = [];
  const { deliverable, agentNoun } = WORK_MODE_WORDING[mode];
  const latest = run.iterations.at(-1) ?? null;

  if (latest === null) {
    reasons.push(`The ${agentNoun} has not run yet`);
  } else if (latest.status === 'running') {
    reasons.push(`The ${agentNoun} is still working`);
  } else if (latest.status !== 'completed') {
    reasons.push(
      `The ${agentNoun} ${
        latest.status === 'cancelled' ? 'was cancelled' : 'failed'
      }, so the ${deliverable} is unfinished`,
    );
  } else if (!latest.finalText?.trim()) {
    reasons.push(`No ${deliverable} was produced`);
  }

  if (run.changedFiles.length > 0) {
    reasons.push(
      `${WORK_MODE_LABELS[mode]} mode changed ${run.changedFiles.length} file${
        run.changedFiles.length === 1 ? '' : 's'
      }, and it should have changed none`,
    );
  }

  return {
    ready: reasons.length === 0,
    reasons,
    mode,
    validationsPassed: 0,
    validationsFailed: 0,
    validationsNotConfigured: VALIDATION_KINDS.length,
    blockingFindings: countBlockingFindings(run),
  };
}

/**
 * Readiness for a build run.
 *
 * A missing validation kind counts as not configured, never as a failure, and
 * only `blocking` commands can hold a run back.
 */
function assessBuildReadiness(run: RunView, project: ProjectView): ReadinessAssessment {
  const reasons: string[] = [];
  const attempt = run.validations.reduce((acc, v) => Math.max(acc, v.attempt), 0);
  const current = run.validations.filter((v) => v.attempt === attempt);

  const passed = current.filter((v) => v.outcome === 'pass').length;
  const failed = current.filter(
    (v) => v.blocking && BLOCKING_OUTCOMES.includes(v.outcome),
  );
  const notConfigured = VALIDATION_KINDS.filter(
    (kind) => !current.some((v) => v.kind === kind && v.outcome !== 'not_configured'),
  ).length;

  for (const failure of failed) {
    reasons.push(
      `${failure.kind} ${failure.outcome === 'error' ? 'could not run' : 'failed'}${
        failure.exitCode === null ? '' : ` (exit ${failure.exitCode})`
      }`,
    );
  }

  const stillRunning = current.filter((v) => v.outcome === 'running');
  for (const running of stillRunning) {
    reasons.push(`${running.kind} is still running`);
  }

  if (project.requireValidation) {
    const configuredKinds = project.validationCommands.filter((c) => c.enabled).map((c) => c.kind);
    if (configuredKinds.length === 0) {
      reasons.push('This project requires validation but has no validation commands configured');
    } else if (current.length === 0) {
      reasons.push('Validation has not run yet');
    }
  }

  if (project.requireE2eForUiChanges && touchesUi(run, project)) {
    const e2e = current.find((v) => v.kind === 'e2e');
    if (!e2e || e2e.outcome === 'not_configured') {
      reasons.push('This change touches UI files and the project requires an E2E check');
    }
  }

  const blockingFindings = countBlockingFindings(run);

  if (project.reviewBlocksReady && blockingFindings > 0) {
    reasons.push(
      `${blockingFindings} blocking review finding${blockingFindings === 1 ? '' : 's'}`,
    );
  }

  if (run.changedFiles.length === 0) {
    reasons.push('No files changed');
  }

  return {
    ready: reasons.length === 0,
    reasons,
    mode: 'build',
    validationsPassed: passed,
    validationsFailed: failed.length,
    validationsNotConfigured: notConfigured,
    blockingFindings,
  };
}

/** Whether any changed file matches the project's UI path patterns. */
export function touchesUi(run: RunView, project: ProjectView): boolean {
  const patterns = project.uiPathPatterns.length > 0 ? project.uiPathPatterns : DEFAULT_UI_PATTERNS;
  return run.changedFiles.some((file) => {
    const normalised = file.path.replace(/\\/g, '/').toLowerCase();
    return patterns.some((pattern) => normalised.includes(pattern.toLowerCase()));
  });
}

const DEFAULT_UI_PATTERNS = [
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.css',
  '.scss',
  'components/',
  'pages/',
  'app/',
];

/* ------------------------------------------------------------------ *
 * Restart recovery
 * ------------------------------------------------------------------ */

/**
 * Marks runs that were mid-flight when the process died.
 *
 * Child processes do not survive a restart, so a run left in an active status
 * is genuinely dead. Reporting that honestly beats leaving a spinner turning
 * forever, and the run can still be continued because the agent session id and
 * worktree are both persisted.
 */
export function reconcileInterruptedRuns(): number {
  const db = getDb();
  const stale = db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(inArray(runs.status, [...ACTIVE_STATUSES]))
    .all();

  for (const row of stale) {
    db.update(runs)
      .set({
        status: 'FAILED',
        error: 'Interrupted: the application restarted while this run was in progress.',
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runs.id, row.id))
      .run();

    appendEvent({
      runId: row.id,
      type: 'run.failed',
      level: 'error',
      message: 'Interrupted by an application restart',
      payload: { error: `Run was ${row.status} when the application stopped.` },
    });
  }

  // Any iteration still marked running belongs to a process that is now gone.
  db.update(iterations)
    .set({ status: 'failed', error: 'Interrupted by an application restart' })
    .where(eq(iterations.status, 'running'))
    .run();

  db.update(validationResults)
    .set({ outcome: 'cancelled', error: 'Interrupted by an application restart' })
    .where(eq(validationResults.outcome, 'running'))
    .run();

  return stale.length;
}

export { fromLines };
