import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Run lifecycle
 * ------------------------------------------------------------------ */

export const RUN_STATUSES = [
  'DRAFT',
  'PREPARING',
  'IMPLEMENTING',
  'VALIDATING',
  'REVIEWING',
  'NEEDS_CHANGES',
  'READY',
  'APPROVED',
  'LANDING',
  'MERGE_CONFLICT',
  'LANDING_FAILED',
  'LANDED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export const runStatusSchema = z.enum(RUN_STATUSES);

/** Statuses where orchestration is actively doing something. */
export const ACTIVE_STATUSES: readonly RunStatus[] = [
  'PREPARING',
  'IMPLEMENTING',
  'VALIDATING',
  'REVIEWING',
  'LANDING',
];

/** Statuses no transition can leave. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ['LANDED', 'REJECTED'];

/**
 * The orchestrator is the source of truth for run state; this table is the
 * whole of the permitted state space. Anything not listed is a bug rather than
 * a judgement call, so `assertTransition` throws on it.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  DRAFT: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['IMPLEMENTING', 'FAILED', 'CANCELLED'],
  IMPLEMENTING: ['VALIDATING', 'REVIEWING', 'NEEDS_CHANGES', 'READY', 'FAILED', 'CANCELLED'],
  VALIDATING: ['REVIEWING', 'NEEDS_CHANGES', 'READY', 'FAILED', 'CANCELLED'],
  REVIEWING: ['NEEDS_CHANGES', 'READY', 'FAILED', 'CANCELLED'],
  NEEDS_CHANGES: [
    'IMPLEMENTING',
    'VALIDATING',
    'REVIEWING',
    'APPROVED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
  ],
  READY: ['IMPLEMENTING', 'VALIDATING', 'REVIEWING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  FAILED: ['IMPLEMENTING', 'VALIDATING', 'LANDING', 'REJECTED', 'CANCELLED'],
  CANCELLED: ['IMPLEMENTING', 'VALIDATING', 'LANDING', 'REJECTED'],
  APPROVED: ['LANDING', 'REJECTED'],
  LANDING: ['LANDED', 'MERGE_CONFLICT', 'LANDING_FAILED', 'FAILED', 'CANCELLED'],
  MERGE_CONFLICT: ['LANDING', 'REJECTED', 'CANCELLED'],
  LANDING_FAILED: ['LANDING', 'REJECTED', 'CANCELLED'],
  LANDED: [],
  REJECTED: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export const isActive = (status: RunStatus): boolean => ACTIVE_STATUSES.includes(status);
export const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.includes(status);

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export const VALIDATION_KINDS = [
  'typecheck',
  'lint',
  'unit',
  'integration',
  'e2e',
  'build',
] as const;

export type ValidationKind = (typeof VALIDATION_KINDS)[number];
export const validationKindSchema = z.enum(VALIDATION_KINDS);

export const VALIDATION_KIND_LABELS: Record<ValidationKind, string> = {
  typecheck: 'Typecheck',
  lint: 'Lint',
  unit: 'Unit',
  integration: 'Integration',
  e2e: 'E2E',
  build: 'Build',
};

export const VALIDATION_OUTCOMES = [
  'pass',
  'fail',
  'running',
  'error',
  'skipped',
  'not_configured',
  'cancelled',
] as const;

export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];
export const validationOutcomeSchema = z.enum(VALIDATION_OUTCOMES);

/**
 * Outcomes that must block READY. `skipped` and `not_configured` are
 * deliberately non-blocking: a project that never defined an E2E command has
 * not failed E2E.
 */
export const BLOCKING_OUTCOMES: readonly ValidationOutcome[] = ['fail', 'error'];

/**
 * Where a command came from. V1 only ever runs `project` commands. The field
 * exists so a future dynamically-generated command is visibly different in the
 * database and the UI rather than indistinguishable from configuration.
 */
export const COMMAND_SOURCES = ['project', 'dynamic'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

/* ------------------------------------------------------------------ *
 * Agent permissions
 * ------------------------------------------------------------------ */

/**
 * Permission modes a project may store.
 *
 * Only `acceptEdits`, `bypassPermissions` and `plan` map onto a Claude Code
 * `--permission-mode` value today. The rest are kept because older projects may
 * hold them; `claudePermissionArgs` falls back rather than passing a flag value
 * the CLI would reject.
 */
export const AGENT_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
  'manual',
] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];
export const agentPermissionModeSchema = z.enum(AGENT_PERMISSION_MODES);

/**
 * Runs are unattended: no human is watching the session, so nothing may stop to
 * ask. `bypassPermissions` is therefore the default — the agent can run the
 * project's own checks instead of working blind. The worktree is disposable and
 * on its own branch, which is what makes that trade payable. See ADR 0010.
 */
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'bypassPermissions';

/** Whether a mode lets the agent run Bash or PowerShell at all. */
export function permissionModeAllowsCommands(mode: string): boolean {
  return mode === 'bypassPermissions';
}

/* ------------------------------------------------------------------ *
 * Execution profiles
 * ------------------------------------------------------------------ */

export const EXECUTION_PROFILES = ['quick', 'standard', 'deep'] as const;
export type ExecutionProfileName = (typeof EXECUTION_PROFILES)[number];
export const executionProfileSchema = z.enum(EXECUTION_PROFILES);

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export const ARTIFACT_KINDS = [
  'git_diff',
  'changed_files',
  'implementation_map',
  'implementation_log',
  'validation_report',
  'stdout_log',
  'stderr_log',
  'screenshot',
  'playwright_report',
  'markdown_report',
  'review_report',
  'transform_spec',
  /** A plan run's deliverable: the planner's own plan, verbatim. */
  'plan',
  /** An ask run's deliverable: the agent's own answer, verbatim. */
  'answer',
  'other',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  git_diff: 'Git diff',
  changed_files: 'Changed files',
  implementation_map: 'Implementation map',
  implementation_log: 'Implementation log',
  validation_report: 'Validation report',
  stdout_log: 'stdout',
  stderr_log: 'stderr',
  screenshot: 'Screenshot',
  playwright_report: 'Playwright report',
  markdown_report: 'Report',
  review_report: 'Review report',
  transform_spec: 'Specification',
  plan: 'Plan',
  answer: 'Answer',
  other: 'File',
};

/* ------------------------------------------------------------------ *
 * File changes
 * ------------------------------------------------------------------ */

export const CHANGE_TYPES = ['added', 'modified', 'deleted', 'renamed', 'untracked'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Review findings
 * ------------------------------------------------------------------ */

export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);

/** Severities that block READY when the project treats review as blocking. */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ['high', 'critical'];

/* ------------------------------------------------------------------ *
 * Iterations
 * ------------------------------------------------------------------ */

export const ITERATION_KINDS = [
  'initial',
  'change_request',
  'merge_resolution',
  'landing_repair',
] as const;
export type IterationKind = (typeof ITERATION_KINDS)[number];

export const ITERATION_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

/* ------------------------------------------------------------------ *
 * Dispositions
 * ------------------------------------------------------------------ */

export const DISPOSITIONS = ['approved', 'rejected'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
