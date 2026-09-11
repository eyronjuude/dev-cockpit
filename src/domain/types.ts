import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Run lifecycle
 * ------------------------------------------------------------------ */

export const RUN_STATUSES = [
  'DRAFT',
  'PREPARING',
  'IMPLEMENTING',
  'PAUSED',
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
 * Statuses where the run is over and its worktrees are spent.
 *
 * `APPROVED`, `MERGE_CONFLICT` and `LANDING_FAILED` are deliberately absent:
 * landing is still pending in all three, and it needs the run worktree.
 * `READY` and `NEEDS_CHANGES` are absent because the user has not decided yet.
 * `PAUSED` is absent because the run is intentionally saved for a later retry.
 * `FAILED` and `CANCELLED` are here — nothing more happens on its own — but
 * they can be reworked, so only an explicit action reclaims those.
 */
export const FINISHED_STATUSES: readonly RunStatus[] = [
  'LANDED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
];

/**
 * Statuses whose worktrees may be reclaimed without the user asking, when the
 * project allows it. Both are terminal: no rework path leads back out.
 */
export const AUTO_CLEANUP_STATUSES: readonly RunStatus[] = ['LANDED', 'REJECTED'];

export const isFinished = (status: RunStatus): boolean => FINISHED_STATUSES.includes(status);

/**
 * The orchestrator is the source of truth for run state; this table is the
 * whole of the permitted state space. Anything not listed is a bug rather than
 * a judgement call, so `assertTransition` throws on it.
 *
 * `DRAFT` appears as a target of every non-terminal status, and only because a
 * forced restart puts a run back to the state it was created in. That is the
 * one write path that produces it — `createRun` inserts `DRAFT` directly — so
 * the entrance to `PREPARING` stays a single door whichever attempt walks
 * through it. Nothing may re-enter `DRAFT` from `LANDED` or `REJECTED`: those
 * are terminal, and a restart is not an undo.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  DRAFT: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['IMPLEMENTING', 'FAILED', 'CANCELLED', 'DRAFT'],
  IMPLEMENTING: [
    'PAUSED',
    'VALIDATING',
    'REVIEWING',
    'NEEDS_CHANGES',
    'READY',
    'FAILED',
    'CANCELLED',
    'DRAFT',
  ],
  PAUSED: ['IMPLEMENTING', 'REJECTED', 'CANCELLED', 'DRAFT'],
  VALIDATING: ['REVIEWING', 'NEEDS_CHANGES', 'READY', 'FAILED', 'CANCELLED', 'DRAFT'],
  REVIEWING: ['NEEDS_CHANGES', 'READY', 'FAILED', 'CANCELLED', 'DRAFT'],
  NEEDS_CHANGES: [
    'IMPLEMENTING',
    'VALIDATING',
    'REVIEWING',
    'APPROVED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
    'DRAFT',
  ],
  READY: [
    'IMPLEMENTING',
    'VALIDATING',
    'REVIEWING',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'DRAFT',
  ],
  FAILED: ['IMPLEMENTING', 'VALIDATING', 'LANDING', 'REJECTED', 'CANCELLED', 'DRAFT'],
  CANCELLED: ['IMPLEMENTING', 'VALIDATING', 'LANDING', 'REJECTED', 'DRAFT'],
  // An approved plan is a decision to build it, not the end of the run: the
  // same session resumes into IMPLEMENTING, so the worktree and the plan that
  // was approved both survive. VALIDATING is here because re-running the
  // checks is offered on an approved build run too, and FAILED and CANCELLED
  // because that follow-up pass can stop before the first phase writes a
  // status. READY and NEEDS_CHANGES are deliberately absent: only the verdict
  // writes those, and it is reached through IMPLEMENTING.
  APPROVED: [
    'IMPLEMENTING',
    'VALIDATING',
    'REVIEWING',
    'LANDING',
    'REJECTED',
    'FAILED',
    'CANCELLED',
    'DRAFT',
  ],
  LANDING: ['LANDED', 'MERGE_CONFLICT', 'LANDING_FAILED', 'FAILED', 'CANCELLED', 'DRAFT'],
  MERGE_CONFLICT: ['LANDING', 'REJECTED', 'CANCELLED', 'DRAFT'],
  LANDING_FAILED: ['LANDING', 'REJECTED', 'CANCELLED', 'DRAFT'],
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

/**
 * Statuses the landing flow may start from.
 *
 * `MERGE_CONFLICT` and `LANDING_FAILED` are here because landing is retried
 * from exactly where it stopped; both keep their landing worktree.
 */
export const LANDABLE_STATUSES: readonly RunStatus[] = [
  'APPROVED',
  'MERGE_CONFLICT',
  'LANDING_FAILED',
];

/**
 * Whether landing may run for a run in this state.
 *
 * A cancelled run counts when it was approved first: cancelling a landing
 * leaves the approval standing, and the merge is still the outstanding step.
 * The disposition is read rather than the status alone because that approval is
 * what entitles the run to touch the target branch at all.
 */
export function isLandableStatus(
  status: RunStatus,
  disposition: Disposition | null,
): boolean {
  if (LANDABLE_STATUSES.includes(status)) return true;
  return status === 'CANCELLED' && disposition === 'approved';
}

/**
 * Whether a forced restart may throw this run's work away and begin again.
 *
 * Anything that has not reached a terminal state can be restarted, including a
 * run that is mid-flight — stopping the work is what "forced" means. A landed
 * run is not restartable: its commits are on the target branch, and undoing
 * that is a git operation the user makes deliberately, not a side effect of a
 * button here.
 */
export const canRestart = (status: RunStatus): boolean => !isTerminal(status);

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
 * Validation steps
 * ------------------------------------------------------------------ */

/**
 * When a step runs.
 *
 *  - `always` — every time its profile is selected. The default, and what
 *    every pre-existing command becomes.
 *  - `changed_files_match` — only when a changed file matches one of the
 *    patterns in `runWhenArg`. Skipping an E2E suite on a docs-only change is
 *    the case this exists for.
 *  - `depends_on` — only when the step named in `runWhenArg` passed. This is
 *    how fail-fast is expressed: opt-in, per step. Running everything after a
 *    failure remains the default, because a second failure is usually worth
 *    knowing about.
 *
 * A step held back by any of these records `skipped`, which never blocks
 * readiness. That is the whole point: not running is not failing.
 */
export const RUN_WHEN_CONDITIONS = ['always', 'changed_files_match', 'depends_on'] as const;
export type RunWhenCondition = (typeof RUN_WHEN_CONDITIONS)[number];
export const runWhenConditionSchema = z.enum(RUN_WHEN_CONDITIONS);

export const RUN_WHEN_LABELS: Record<RunWhenCondition, string> = {
  always: 'Always',
  changed_files_match: 'Only when changed files match',
  depends_on: 'Only when another step passed',
};

/**
 * Which outcomes a retry applies to.
 *
 * `error` is the useful default: the command could not start, or timed out,
 * and trying again costs little. `fail` re-runs a suite that ran and did not
 * pass, which is what a genuinely flaky test needs and what an honest one does
 * not — so it is opt-in and stated rather than assumed.
 */
export const RETRY_ON_MODES = ['error', 'fail', 'both'] as const;
export type RetryOnMode = (typeof RETRY_ON_MODES)[number];
export const retryOnModeSchema = z.enum(RETRY_ON_MODES);

/** More than this and a pipeline is being used as a build system. */
export const MAX_RETRIES = 3;

/** Positions are spaced so a step can be inserted between two without a re-number. */
export const POSITION_STRIDE = 10;

/* ------------------------------------------------------------------ *
 * Preview configuration
 * ------------------------------------------------------------------ */

/**
 * How a preview gets its port.
 *
 * `auto` asks the OS for a free one, which is what V1 always did and remains
 * the default. `fixed` exists for a project whose own configuration hard-codes
 * a URL — an OAuth callback, a CORS allowlist — and therefore cannot take
 * whatever it is given.
 */
export const PREVIEW_PORT_STRATEGIES = ['auto', 'fixed'] as const;
export type PreviewPortStrategy = (typeof PREVIEW_PORT_STRATEGIES)[number];
export const previewPortStrategySchema = z.enum(PREVIEW_PORT_STRATEGIES);

export const DEFAULT_PREVIEW_READY_PATH = '/';
export const DEFAULT_PREVIEW_READY_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------ *
 * AI configuration authority
 * ------------------------------------------------------------------ */

/**
 * How much authority the setup advisor has over a project's configuration.
 *
 *  - `off` — deterministic detection only. No model is asked anything.
 *  - `draft` — the model proposes, the user reviews and saves. The default,
 *    and what every project had before this setting existed.
 *  - `auto` — the model proposes, the configuration is saved, and a probe runs
 *    it in a disposable worktree. Whatever could not run is revised once and
 *    saved again.
 *
 * `auto` executes commands a model wrote. That is inside the threat model this
 * application already documents — a run's implementation agent does the same —
 * but it is the first path where no human reads the command first, so it is
 * opt-in, it never touches the user's checkout, and every save it makes is
 * preceded by a revision snapshot that can be restored in one click.
 */
export const AI_CONFIG_MODES = ['off', 'draft', 'auto'] as const;
export type AiConfigMode = (typeof AI_CONFIG_MODES)[number];
export const aiConfigModeSchema = z.enum(AI_CONFIG_MODES);

export const AI_CONFIG_MODE_LABELS: Record<AiConfigMode, string> = {
  off: 'Off — detect from the repository only',
  draft: 'Draft — propose, and let me review before saving',
  auto: 'Auto — propose, save, and verify in a disposable worktree',
};

/** Who wrote a stored configuration revision. */
export const CONFIG_REVISION_SOURCES = ['user', 'advisor', 'probe'] as const;
export type ConfigRevisionSource = (typeof CONFIG_REVISION_SOURCES)[number];

export const PROBE_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

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
  /** The previous iteration's prompt, issued again unchanged. */
  'retry',
  'merge_resolution',
  'landing_repair',
] as const;
export type IterationKind = (typeof ITERATION_KINDS)[number];

/**
 * Iteration kinds that work in the run's own worktree.
 *
 * The landing kinds work in a separate landing worktree against a merge of the
 * target branch, so their prompts are meaningless anywhere else. Retrying "the
 * current iteration" has to mean the last implementation pass, not the last
 * row in the table.
 */
export const IMPLEMENTATION_ITERATION_KINDS: readonly IterationKind[] = [
  'initial',
  'change_request',
  'retry',
];

export const ITERATION_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

/* ------------------------------------------------------------------ *
 * Dispositions
 * ------------------------------------------------------------------ */

export const DISPOSITIONS = ['approved', 'rejected'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
