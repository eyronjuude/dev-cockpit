import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import { newValidationId } from '@/core/ids';
import { isInside } from '@/core/paths';
import { runCommand, type CommandResult } from '@/process/spawn';
import {
  BLOCKING_OUTCOMES,
  VALIDATION_KINDS,
  type ExecutionProfileName,
  type ValidationKind,
  type ValidationOutcome,
} from '@/domain/types';
import { appendEvent } from '@/services/events';
import { writeTextArtifact } from '@/services/artifacts';
import { nextValidationAttempt, upsertValidationResult } from '@/services/runs';
import type { ProjectView, ValidationCommandView } from '@/services/projects';

/**
 * Deterministic validation.
 *
 * Entirely separate from the implementation agent: it executes the project's
 * own configured commands and records what happened. It never edits a file and
 * never asks a model anything, which is why its results are the factual basis
 * for a run becoming READY.
 *
 * `Validator` is the plugin seam. V1 ships one implementation — the configured
 * shell command — and the engine does not care how a result was produced.
 */

export interface ValidatorContext {
  runId: string;
  worktreePath: string;
  project: ProjectView;
  profile: ExecutionProfileName;
  signal?: AbortSignal;
  onOutput?: (kind: ValidationKind, chunk: string) => void;
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
  readonly kind: ValidationKind;
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

/** Runs one project-configured command. */
export class CommandValidator implements Validator {
  readonly kind: ValidationKind;
  readonly blocking: boolean;

  constructor(private readonly config: ValidationCommandView) {
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

    const result: CommandResult = await runCommand({
      command: this.config.command,
      cwd,
      timeoutMs: this.config.timeoutMs,
      signal,
      onStdout: onOutput ? (chunk) => onOutput(this.kind, chunk) : undefined,
      onStderr: onOutput ? (chunk) => onOutput(this.kind, chunk) : undefined,
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

export interface ValidationRunSummary {
  attempt: number;
  results: {
    kind: ValidationKind;
    outcome: ValidationOutcome;
    blocking: boolean;
    exitCode: number | null;
    durationMs: number | null;
  }[];
  passed: number;
  failed: number;
  notConfigured: number;
  /** True when at least one blocking command failed or errored. */
  blocking: boolean;
  cancelled: boolean;
}

/** Which validation kinds a profile runs. */
export function kindsForProfile(
  project: ProjectView,
  profile: ExecutionProfileName,
): ValidationCommandView[] {
  return project.validationCommands
    .filter((c) => c.enabled && c.command.trim().length > 0)
    .filter((c) => c.profiles.length === 0 || c.profiles.includes(profile))
    .slice()
    .sort(
      (a, b) => VALIDATION_KINDS.indexOf(a.kind) - VALIDATION_KINDS.indexOf(b.kind),
    );
}

/**
 * Runs the project's validation for one attempt, recording every outcome.
 *
 * Kinds with no configured command are recorded as `not_configured` rather than
 * omitted, so the scorecard can distinguish "never set up" from "failed".
 * Execution is sequential: these commands compete for the same CPU, ports and
 * lockfiles, and interleaving them produces flaky results.
 */
export async function runValidation(context: ValidatorContext): Promise<ValidationRunSummary> {
  const { runId, project, profile, signal } = context;
  const attempt = nextValidationAttempt(runId);
  const configured = kindsForProfile(project, profile);
  const configuredKinds = new Set(configured.map((c) => c.kind));

  appendEvent({
    runId,
    type: 'validation.started',
    message:
      configured.length === 0
        ? 'No validation commands are configured for this profile'
        : `Running ${configured.length} validation command(s): ${configured
            .map((c) => c.kind)
            .join(', ')}`,
    payload: {
      kind: (configured[0]?.kind ?? 'typecheck') as ValidationKind,
      command: configured.map((c) => c.kind).join(', '),
      validationId: `attempt-${attempt}`,
    },
  });

  // Record the unconfigured kinds up front so the scorecard is complete from
  // the first render rather than filling in as it goes.
  for (const kind of VALIDATION_KINDS) {
    if (configuredKinds.has(kind)) continue;
    upsertValidationResult({
      id: newValidationId(),
      runId,
      attempt,
      kind,
      command: null,
      workingDir: null,
      outcome: 'not_configured',
      blocking: false,
    });
  }

  const results: ValidationRunSummary['results'] = [];
  let cancelled = false;

  for (const config of configured) {
    if (signal?.aborted) {
      cancelled = true;
      upsertValidationResult({
        id: newValidationId(),
        runId,
        attempt,
        kind: config.kind,
        command: config.command,
        workingDir: config.workingDir,
        outcome: 'cancelled',
        blocking: config.blocking,
      });
      results.push({
        kind: config.kind,
        outcome: 'cancelled',
        blocking: config.blocking,
        exitCode: null,
        durationMs: null,
      });
      continue;
    }

    const validationId = newValidationId();

    upsertValidationResult({
      id: validationId,
      runId,
      attempt,
      kind: config.kind,
      command: config.command,
      workingDir: config.workingDir,
      outcome: 'running',
      blocking: config.blocking,
      startedAt: new Date().toISOString(),
    });

    appendEvent({
      runId,
      type: 'validation.started',
      message: `${config.kind}: ${config.command}`,
      payload: { kind: config.kind, command: config.command, validationId },
    });

    const validator = new CommandValidator(config);
    const outcome = await validator.run(context);

    upsertValidationResult({
      id: validationId,
      runId,
      attempt,
      kind: config.kind,
      command: outcome.command,
      workingDir: outcome.workingDir,
      outcome: outcome.outcome,
      blocking: config.blocking,
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
        label: `${config.kind} output (attempt ${attempt})`,
        fileName: path.join('validation', `attempt-${attempt}-${config.kind}.log`),
        content: buildLog(config, outcome),
        meta: {
          validationKind: config.kind,
          attempt,
          exitCode: outcome.exitCode,
          outcome: outcome.outcome,
        },
      });
    }

    appendEvent({
      runId,
      type: 'validation.result',
      level: BLOCKING_OUTCOMES.includes(outcome.outcome) ? 'error' : 'info',
      message: `${config.kind}: ${outcome.outcome}${
        outcome.exitCode === null ? '' : ` (exit ${outcome.exitCode})`
      }${outcome.durationMs === null ? '' : ` in ${formatDuration(outcome.durationMs)}`}`,
      payload: {
        kind: config.kind,
        validationId,
        outcome: outcome.outcome,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
      },
    });

    if (outcome.outcome === 'cancelled') cancelled = true;

    results.push({
      kind: config.kind,
      outcome: outcome.outcome,
      blocking: config.blocking,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    });
  }

  const passed = results.filter((r) => r.outcome === 'pass').length;
  const failed = results.filter((r) => BLOCKING_OUTCOMES.includes(r.outcome)).length;
  const blocking = results.some((r) => r.blocking && BLOCKING_OUTCOMES.includes(r.outcome));
  const notConfigured = VALIDATION_KINDS.length - configured.length;

  const summary: ValidationRunSummary = {
    attempt,
    results,
    passed,
    failed,
    notConfigured,
    blocking,
    cancelled,
  };

  await writeTextArtifact({
    runId,
    kind: 'validation_report',
    label: `Validation report (attempt ${attempt})`,
    fileName: path.join('validation', `attempt-${attempt}-report.md`),
    content: buildReport(project, profile, summary),
    mimeType: 'text/markdown',
    meta: { attempt, passed, failed, blocking },
  });

  appendEvent({
    runId,
    type: 'validation.completed',
    level: blocking ? 'error' : 'info',
    message: `Validation finished: ${passed} passed, ${failed} failed, ${notConfigured} not configured`,
    payload: { total: results.length, passed, failed, notConfigured, blocking },
  });

  return summary;
}

function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `... [truncated to the last ${limit} characters] ...\n${text.slice(-limit)}`;
}

function buildLog(config: ValidationCommandView, outcome: ValidatorOutcome): string {
  const lines = [
    `# ${config.kind}`,
    `Command: ${config.command}`,
    `Working directory: ${outcome.workingDir ?? '(worktree root)'}`,
    `Outcome: ${outcome.outcome}`,
    `Exit code: ${outcome.exitCode ?? '(none)'}`,
    `Duration: ${outcome.durationMs === null ? '(unknown)' : `${outcome.durationMs}ms`}`,
    `Started: ${outcome.startedAt ?? '(unknown)'}`,
    `Finished: ${outcome.finishedAt ?? '(unknown)'}`,
  ];
  if (outcome.error) lines.push(`Error: ${outcome.error}`);
  lines.push('', '--- stdout ---', outcome.stdout || '(empty)', '', '--- stderr ---', outcome.stderr || '(empty)');
  return lines.join('\n');
}

function buildReport(
  project: ProjectView,
  profile: ExecutionProfileName,
  summary: ValidationRunSummary,
): string {
  const rows = VALIDATION_KINDS.map((kind) => {
    const result = summary.results.find((r) => r.kind === kind);
    if (!result) return `| ${kind} | not configured | — | — |`;
    return `| ${kind} | ${result.outcome} | ${result.exitCode ?? '—'} | ${
      result.durationMs === null ? '—' : formatDuration(result.durationMs)
    } |`;
  }).join('\n');

  return `# Validation report — attempt ${summary.attempt}

Project: ${project.name}
Profile: ${profile}
Blocking failure: ${summary.blocking ? 'yes' : 'no'}

| Check | Outcome | Exit | Duration |
| --- | --- | --- | --- |
${rows}

Passed: ${summary.passed}
Failed: ${summary.failed}
Not configured: ${summary.notConfigured}
`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
