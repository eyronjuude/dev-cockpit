import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import { newValidationId } from '@/core/ids';
import { isInside } from '@/core/paths';
import { registerExtraSecrets } from '@/core/redact';
import { runCommand, type CommandResult } from '@/process/spawn';
import {
  BLOCKING_OUTCOMES,
  type ExecutionProfileName,
  type ValidationKind,
  type ValidationOutcome,
} from '@/domain/types';
import {
  evaluateRunWhen,
  orderSteps,
  parseEnvLines,
  secretValuesIn,
  shouldRetry,
  uncoveredKinds,
} from '@/domain/validation-steps';
import { appendEvent } from '@/services/events';
import { writeTextArtifact } from '@/services/artifacts';
import { nextValidationAttempt, upsertValidationResult } from '@/services/runs';
import type { ProjectView, ValidationStepView } from '@/services/projects';

/**
 * Deterministic validation.
 *
 * Entirely separate from the implementation agent: it executes the project's
 * own configured steps and records what happened. It never edits a file and
 * never asks a model anything, which is why its results are the factual basis
 * for a run becoming READY.
 *
 * A pipeline is an ordered list of named steps, not a fixed set of six kinds.
 * Two steps may share a kind, or carry none. What has not changed is what a
 * result means: `fail` is a check that ran and did not pass, `error` is a check
 * that could not run, and `skipped` and `not_configured` are neither.
 *
 * `Validator` is the plugin seam. V1 ships one implementation — the configured
 * shell command — and the engine does not care how a result was produced.
 */

export interface ValidatorContext {
  runId: string;
  worktreePath: string;
  project: ProjectView;
  profile: ExecutionProfileName;
  /**
   * Paths the run changed, for steps conditioned on them. Empty is safe: a
   * `changed_files_match` step simply finds no match and records `skipped`.
   */
  changedPaths?: readonly string[];
  signal?: AbortSignal;
  onOutput?: (step: ValidationStepView, chunk: string) => void;
}

export interface ValidatorOutcome {
  outcome: ValidationOutcome;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  command: string | null;
  workingDir: string | null;
}

export interface Validator {
  readonly key: string;
  readonly kind: ValidationKind | null;
  /** Whether a blocking failure here holds the run back. */
  readonly blocking: boolean;
  run(context: ValidatorContext): Promise<ValidatorOutcome>;
}

const NOT_CONFIGURED: ValidatorOutcome = {
  outcome: 'not_configured',
  exitCode: null,
  durationMs: null,
  stdout: '',
  stderr: '',
  error: null,
  startedAt: null,
  finishedAt: null,
  command: null,
  workingDir: null,
};

/** Runs one project-configured step. */
export class CommandValidator implements Validator {
  readonly key: string;
  readonly kind: ValidationKind | null;
  readonly blocking: boolean;

  constructor(private readonly config: ValidationStepView) {
    this.key = config.key;
    this.kind = config.kind;
    this.blocking = config.blocking;
  }

  async run(context: ValidatorContext): Promise<ValidatorOutcome> {
    const { worktreePath, signal, onOutput } = context;

    const cwd = this.config.workingDir
      ? path.resolve(worktreePath, this.config.workingDir)
      : worktreePath;

    // A configured working directory must not escape the run's worktree, or a
    // validation could execute against the user's real checkout.
    if (cwd !== worktreePath && !isInside(worktreePath, cwd)) {
      return {
        ...NOT_CONFIGURED,
        outcome: 'error',
        command: this.config.command,
        workingDir: this.config.workingDir,
        error: `Working directory ${this.config.workingDir} escapes the worktree`,
      };
    }

    if (!fs.existsSync(cwd)) {
      return {
        ...NOT_CONFIGURED,
        outcome: 'error',
        command: this.config.command,
        workingDir: this.config.workingDir,
        error: `Working directory does not exist in the worktree: ${cwd}`,
      };
    }

    // A step's own environment never reaches `process.env`, so the redactor's
    // environment scan cannot see it. Register the secret-looking values here
    // or the one field a user is most likely to put a credential in is the one
    // field that would not be masked.
    const stepEnv = parseEnvLines(this.config.env.join('\n'));
    registerExtraSecrets(secretValuesIn(stepEnv));

    const result: CommandResult = await runCommand({
      command: this.config.command,
      cwd,
      env: { ...process.env, ...stepEnv },
      timeoutMs: this.config.timeoutMs,
      signal,
      onStdout: onOutput ? (chunk) => onOutput(this.config, chunk) : undefined,
      onStderr: onOutput ? (chunk) => onOutput(this.config, chunk) : undefined,
    });

    return {
      outcome: classify(result),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      error: describeFailure(result),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      command: result.command,
      workingDir: this.config.workingDir,
    };
  }
}

function classify(result: CommandResult): ValidationOutcome {
  if (result.aborted) return 'cancelled';
  // A command that could not start, or was killed, is not a test failure. It is
  // an error, and reporting the difference honestly matters.
  if (result.spawnError) return 'error';
  if (result.timedOut) return 'error';
  return result.exitCode === 0 ? 'pass' : 'fail';
}

function describeFailure(result: CommandResult): string | null {
  if (result.spawnError) return `Could not start the command: ${result.spawnError}`;
  if (result.timedOut) return 'The command timed out.';
  if (result.aborted) return 'Cancelled.';
  return null;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export interface ValidationStepResult {
  key: string;
  label: string;
  kind: ValidationKind | null;
  outcome: ValidationOutcome;
  blocking: boolean;
  exitCode: number | null;
  durationMs: number | null;
  /** How many extra runs the retry policy bought. Zero on the common path. */
  attempts: number;
  /** Why a step did not run, when it did not. */
  skipReason: string | null;
}

export interface ValidationRunSummary {
  attempt: number;
  results: ValidationStepResult[];
  passed: number;
  failed: number;
  skipped: number;
  notConfigured: number;
  /** True when at least one blocking step failed or errored. */
  blocking: boolean;
  cancelled: boolean;
}

/**
 * The steps a profile runs, in configured order.
 *
 * Conditions are not evaluated here: `depends_on` needs outcomes that do not
 * exist until the pipeline is part-way through, so ordering is resolved first
 * and skipping is decided step by step.
 */
export function stepsForRun(
  project: ProjectView,
  profile: ExecutionProfileName,
): ValidationStepView[] {
  return orderSteps(
    project.validationSteps
      .filter((step) => step.enabled && step.command.trim().length > 0)
      .filter((step) => step.profiles.length === 0 || step.profiles.includes(profile)),
  );
}

/**
 * Runs the project's validation for one attempt, recording every outcome.
 *
 * Kinds no step claims are recorded as `not_configured` rather than omitted, so
 * the scorecard can still distinguish "never set up" from "failed" even though
 * the pipeline no longer has one slot per kind.
 *
 * Execution is sequential: these commands compete for the same CPU, ports and
 * lockfiles, and interleaving them produces flaky results.
 */
export async function runValidation(context: ValidatorContext): Promise<ValidationRunSummary> {
  const { runId, project, profile, signal } = context;
  const attempt = nextValidationAttempt(runId);
  const configured = stepsForRun(project, profile);
  const changedPaths = context.changedPaths ?? [];

  appendEvent({
    runId,
    type: 'validation.started',
    message:
      configured.length === 0
        ? 'No validation steps are configured for this profile'
        : `Running ${configured.length} validation step(s): ${configured
            .map((step) => step.label)
            .join(', ')}`,
    payload: {
      kind: (configured[0]?.kind ?? 'typecheck') as ValidationKind,
      command: configured.map((step) => step.label).join(', '),
      validationId: `attempt-${attempt}`,
    },
  });

  // Record the kinds nothing covers up front so the scorecard is complete from
  // the first render rather than filling in as it goes.
  for (const kind of uncoveredKinds(project.validationSteps)) {
    upsertValidationResult({
      id: newValidationId(),
      runId,
      attempt,
      stepKey: kind,
      stepLabel: null,
      kind,
      command: null,
      workingDir: null,
      outcome: 'not_configured',
      blocking: false,
    });
  }

  const results: ValidationStepResult[] = [];
  const outcomes = new Map<string, ValidationOutcome>();
  let cancelled = false;

  for (const step of configured) {
    if (signal?.aborted) {
      cancelled = true;
      record(runId, attempt, step, 'cancelled', null);
      outcomes.set(step.key, 'cancelled');
      results.push(emptyResult(step, 'cancelled', null));
      continue;
    }

    const decision = evaluateRunWhen(step, { changedPaths, outcomes });
    if (decision.skipped) {
      record(runId, attempt, step, 'skipped', decision.reason);
      outcomes.set(step.key, 'skipped');
      results.push(emptyResult(step, 'skipped', decision.reason));
      appendEvent({
        runId,
        type: 'validation.result',
        message: `${step.label}: skipped — ${decision.reason}`,
        payload: {
          kind: (step.kind ?? 'build') as ValidationKind,
          validationId: `${attempt}-${step.key}`,
          outcome: 'skipped',
          exitCode: null,
          durationMs: null,
        },
      });
      continue;
    }

    const validationId = newValidationId();

    upsertValidationResult({
      id: validationId,
      runId,
      attempt,
      stepKey: step.key,
      stepLabel: step.label,
      kind: step.kind,
      command: step.command,
      workingDir: step.workingDir,
      outcome: 'running',
      blocking: step.blocking,
      startedAt: new Date().toISOString(),
    });

    appendEvent({
      runId,
      type: 'validation.started',
      message: `${step.label}: ${step.command}`,
      payload: {
        kind: (step.kind ?? 'build') as ValidationKind,
        command: step.command,
        validationId,
      },
    });

    const validator = new CommandValidator(step);
    let outcome = await validator.run(context);
    let extraAttempts = 0;

    // A retry is for a step that could not run, or one whose suite is known to
    // flake. It is never silent: the count reaches the log artifact, so a step
    // that only passed on the third go does not read as a clean pass.
    while (
      extraAttempts < step.retries &&
      !signal?.aborted &&
      shouldRetry(outcome.outcome, step.retryOn)
    ) {
      extraAttempts += 1;
      appendEvent({
        runId,
        type: 'validation.started',
        level: 'notice',
        message: `${step.label}: ${outcome.outcome}, retrying (${extraAttempts} of ${step.retries})`,
        payload: {
          kind: (step.kind ?? 'build') as ValidationKind,
          command: step.command,
          validationId,
        },
      });
      outcome = await validator.run(context);
    }

    upsertValidationResult({
      id: validationId,
      runId,
      attempt,
      stepKey: step.key,
      stepLabel: step.label,
      kind: step.kind,
      command: outcome.command,
      workingDir: outcome.workingDir,
      outcome: outcome.outcome,
      blocking: step.blocking,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      stdout: tail(outcome.stdout, 20_000),
      stderr: tail(outcome.stderr, 20_000),
      error: outcome.error,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
    });

    // Full output as an artifact; the row keeps only a tail for the UI.
    if (outcome.stdout.trim() || outcome.stderr.trim()) {
      await writeTextArtifact({
        runId,
        kind: 'stdout_log',
        label: `${step.label} output (attempt ${attempt})`,
        fileName: path.join('validation', `attempt-${attempt}-${step.key}.log`),
        content: buildLog(step, outcome, extraAttempts),
        meta: {
          validationKind: step.kind,
          stepKey: step.key,
          attempt,
          retries: extraAttempts,
          exitCode: outcome.exitCode,
          outcome: outcome.outcome,
        },
      });
    }

    appendEvent({
      runId,
      type: 'validation.result',
      level: BLOCKING_OUTCOMES.includes(outcome.outcome) ? 'error' : 'info',
      message: `${step.label}: ${outcome.outcome}${
        outcome.exitCode === null ? '' : ` (exit ${outcome.exitCode})`
      }${outcome.durationMs === null ? '' : ` in ${formatDuration(outcome.durationMs)}`}${
        extraAttempts > 0 ? ` after ${extraAttempts} retry(s)` : ''
      }`,
      payload: {
        kind: (step.kind ?? 'build') as ValidationKind,
        validationId,
        outcome: outcome.outcome,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
      },
    });

    if (outcome.outcome === 'cancelled') cancelled = true;

    outcomes.set(step.key, outcome.outcome);
    results.push({
      key: step.key,
      label: step.label,
      kind: step.kind,
      outcome: outcome.outcome,
      blocking: step.blocking,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      attempts: extraAttempts,
      skipReason: null,
    });
  }

  const passed = results.filter((r) => r.outcome === 'pass').length;
  const failed = results.filter((r) => BLOCKING_OUTCOMES.includes(r.outcome)).length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const blocking = results.some((r) => r.blocking && BLOCKING_OUTCOMES.includes(r.outcome));
  const notConfigured = uncoveredKinds(project.validationSteps).length;

  const summary: ValidationRunSummary = {
    attempt,
    results,
    passed,
    failed,
    skipped,
    notConfigured,
    blocking,
    cancelled,
  };

  await writeTextArtifact({
    runId,
    kind: 'validation_report',
    label: `Validation report (attempt ${attempt})`,
    fileName: path.join('validation', `attempt-${attempt}-report.md`),
    content: buildReport(project, profile, summary, changedPaths),
    mimeType: 'text/markdown',
    meta: { attempt, passed, failed, skipped, blocking },
  });

  appendEvent({
    runId,
    type: 'validation.completed',
    level: blocking ? 'error' : 'info',
    message: `Validation finished: ${passed} passed, ${failed} failed, ${skipped} skipped, ${notConfigured} kind(s) not configured`,
    payload: { total: results.length, passed, failed, notConfigured, blocking },
  });

  return summary;
}

/** Writes a result row for a step that never produced output. */
function record(
  runId: string,
  attempt: number,
  step: ValidationStepView,
  outcome: ValidationOutcome,
  reason: string | null,
): void {
  upsertValidationResult({
    id: newValidationId(),
    runId,
    attempt,
    stepKey: step.key,
    stepLabel: step.label,
    kind: step.kind,
    command: step.command,
    workingDir: step.workingDir,
    outcome,
    blocking: step.blocking,
    error: reason,
  });
}

function emptyResult(
  step: ValidationStepView,
  outcome: ValidationOutcome,
  skipReason: string | null,
): ValidationStepResult {
  return {
    key: step.key,
    label: step.label,
    kind: step.kind,
    outcome,
    blocking: step.blocking,
    exitCode: null,
    durationMs: null,
    attempts: 0,
    skipReason,
  };
}

function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `... [truncated to the last ${limit} characters] ...\n${text.slice(-limit)}`;
}

function buildLog(
  step: ValidationStepView,
  outcome: ValidatorOutcome,
  retries: number,
): string {
  const lines = [
    `# ${step.label}`,
    `Step: ${step.key}`,
    `Kind: ${step.kind ?? '(none)'}`,
    `Command: ${step.command}`,
    `Working directory: ${outcome.workingDir ?? '(worktree root)'}`,
    `Outcome: ${outcome.outcome}`,
    `Exit code: ${outcome.exitCode ?? '(none)'}`,
    `Duration: ${outcome.durationMs === null ? '(unknown)' : `${outcome.durationMs}ms`}`,
    `Started: ${outcome.startedAt ?? '(unknown)'}`,
    `Finished: ${outcome.finishedAt ?? '(unknown)'}`,
  ];
  // A step that only passed on a retry is not the same as one that passed, and
  // the duration above reports the last go alone.
  if (retries > 0) lines.push(`Retries used: ${retries} of ${step.retries}`);
  if (outcome.error) lines.push(`Error: ${outcome.error}`);
  lines.push('', '--- stdout ---', outcome.stdout || '(empty)', '', '--- stderr ---', outcome.stderr || '(empty)');
  return lines.join('\n');
}

function buildReport(
  project: ProjectView,
  profile: ExecutionProfileName,
  summary: ValidationRunSummary,
  changedPaths: readonly string[],
): string {
  const rows = summary.results
    .map((result) => {
      const note = result.skipReason
        ? result.skipReason
        : result.attempts > 0
          ? `${result.attempts} retry(s)`
          : '';
      return `| ${result.label} | ${result.kind ?? '—'} | ${result.outcome} | ${
        result.exitCode ?? '—'
      } | ${result.durationMs === null ? '—' : formatDuration(result.durationMs)} | ${note || '—'} |`;
    })
    .join('\n');

  const uncovered = uncoveredKinds(project.validationSteps);

  return `# Validation report — attempt ${summary.attempt}

Project: ${project.name}
Profile: ${profile}
Blocking failure: ${summary.blocking ? 'yes' : 'no'}

Conditions were evaluated against ${changedPaths.length} changed file(s) from this run.

| Step | Kind | Outcome | Exit | Duration | Note |
| --- | --- | --- | --- | --- | --- |
${rows || '| (no steps ran) | — | — | — | — | — |'}

Passed: ${summary.passed}
Failed: ${summary.failed}
Skipped: ${summary.skipped}
Kinds no step covers: ${uncovered.length === 0 ? 'none' : uncovered.join(', ')}
`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
