import type { ExpiryTarget } from './expiry';
import type { ResolvedWorkMode, WorkMode } from './modes';
import type { RetryStage } from './retry';
import type {
  ArtifactKind,
  ChangeType,
  FindingSeverity,
  RunStatus,
  ValidationKind,
  ValidationOutcome,
} from './types';

/**
 * The internal event catalogue. Every visible thing that happens during a run
 * is one of these, appended to an append-only log keyed by run. The UI derives
 * its progress display from this log rather than from a terminal transcript,
 * which is why the payloads are structured instead of pre-rendered strings.
 */
export const EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'run.mode_selected',
  'run.mode_switched',
  'run.retried',
  'run.restarted',
  'run.paused',

  'transform.started',
  'transform.completed',
  'transform.skipped',
  'transform.failed',
  'summarise.completed',
  'summarise.skipped',

  'worktree.prepared',
  'worktree.setup',
  'worktree.removed',
  'run.expired',

  'preview.started',
  'preview.ready',
  'preview.stopped',
  'preview.failed',

  'agent.started',
  'agent.message',
  'agent.thinking',
  'agent.tool_started',
  'agent.tool_completed',
  'agent.completed',
  'agent.failed',
  'agent.fallback_started',
  'agent.cancelled',
  'agent.notice',

  'file.changed',

  'validation.started',
  'validation.result',
  'validation.completed',
  'validation.skipped',

  'artifact.created',
  'visualisation.skipped',

  'attachment.added',
  'attachment.removed',

  'review.started',
  'review.finding',
  'review.completed',
  'review.skipped',

  'landing.queued',
  'landing.dequeued',
  'landing.cancelled',
  'landing.started',
  'landing.merged',
  'landing.conflicted',
  'landing.resolution_started',
  'landing.resolution_completed',
  'landing.refresh_started',
  'landing.refresh_completed',
  'landing.repair_started',
  'landing.repair_committed',
  'landing.manual_instructions',
  'landing.validation_failed',
  'landing.applied',
  'landing.failed',

  'run.ready',
  'run.needs_changes',
  'run.approved',
  'run.rejected',
  'run.failed',
  'run.cancelled',
  'run.commit_created',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Severity for UI grouping. `error` events are always surfaced. */
export const EVENT_LEVELS = ['debug', 'info', 'notice', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/* ------------------------------------------------------------------ *
 * Per-type payloads
 * ------------------------------------------------------------------ */

export interface EventPayloads {
  'run.created': {
    title: string;
    request: string;
    profile: string;
    mode: WorkMode;
    resolvedMode: ResolvedWorkMode;
  };
  'run.status_changed': { from: RunStatus; to: RunStatus; reason?: string };
  /** Recorded when Auto chose the mode, so the choice and its reason survive. */
  'run.mode_selected': {
    requested: WorkMode;
    resolved: ResolvedWorkMode;
    reason: string;
  };
  'run.mode_switched': { from: ResolvedWorkMode; to: ResolvedWorkMode; reason: string };
  /** A stopped run was picked back up. `stage` says where it resumed. */
  'run.retried': {
    stage: RetryStage;
    reason: string;
    resumedSession: boolean;
    /** The iteration whose prompt was re-issued, when one was. */
    iterationOrdinal: number | null;
  };
  /** The run was thrown away and started again on a fresh branch. */
  'run.restarted': {
    reason: string;
    branch: string;
    previousBranch: string | null;
    worktreeRemoved: boolean;
    stoppedActiveWork: boolean;
  };
  /** The run is saved for a later retry because no implementation agent can work now. */
  'run.paused': {
    reason: string;
    agents: { provider: string; label: string; reason: string; exitCode: number | null }[];
  };

  'transform.started': { provider: string };
  'transform.completed': { provider: string; specLength: number; durationMs: number };
  'transform.skipped': { provider: string; reason: string };
  'transform.failed': { provider: string; error: string };

  'summarise.completed': {
    provider: string;
    iterationId: string;
    durationMs: number;
  };
  'summarise.skipped': { provider: string; iterationId: string; reason: string };

  'worktree.prepared': { path: string; branch: string; baseCommit: string; baseBranch: string };
  'worktree.setup': {
    linked: string[];
    setupCommand: string | null;
    setupExitCode: number | null;
  };
  /**
   * A cleanup pass over the run's worktrees. One entry per worktree it looked
   * at, kept whole so a refusal is as visible as a removal.
   */
  'worktree.removed': {
    automatic: boolean;
    removed: number;
    kept: number;
    targets: {
      kind: 'run' | 'landing';
      path: string;
      branch: string | null;
      removed: boolean;
      branchDeleted: boolean;
      reason: string | null;
    }[];
  };

  /**
   * A retention window elapsed and the run's storage was reclaimed. Recorded
   * against the run because the run is where someone will look for the reason
   * its diff can no longer be opened.
   */
  'run.expired': {
    targets: ExpiryTarget[];
    retentionDays: Record<ExpiryTarget, number>;
    /** Null when the worktree window had not elapsed. */
    worktreesRemoved: number | null;
    worktreesKept: number | null;
    /** Null when the artifact window had not elapsed. */
    artifactsExpired: number | null;
    bytesReclaimed: number;
    /** Set when the pass was a preview and nothing was actually removed. */
    dryRun: boolean;
  };

  'preview.started': {
    command: string;
    url: string;
    port: number;
    pid: number | null;
    artifactId: string | null;
  };
  'preview.ready': { url: string; port: number };
  'preview.stopped': { exitCode: number | null; signal: string | null; reason: string | null };
  'preview.failed': { error: string; exitCode: number | null; signal: string | null };

  'agent.started': {
    iterationId: string;
    provider: string;
    sessionId: string | null;
    resumed: boolean;
    model: string | null;
  };
  'agent.message': { iterationId: string; text: string };
  'agent.thinking': { iterationId: string; text: string };
  'agent.tool_started': {
    iterationId: string;
    toolUseId: string;
    tool: string;
    summary: string;
  };
  'agent.tool_completed': {
    iterationId: string;
    toolUseId: string;
    tool: string;
    isError: boolean;
    summary: string;
  };
  'agent.completed': {
    iterationId: string;
    sessionId: string | null;
    numTurns: number | null;
    durationMs: number | null;
    costUsd: number | null;
    finalText: string | null;
  };
  'agent.failed': {
    iterationId: string;
    error: string;
    exitCode: number | null;
    provider?: string;
  };
  'agent.fallback_started': {
    iterationId: string;
    from: string;
    to: string;
    reason: string;
  };
  'agent.cancelled': { iterationId: string };
  'agent.notice': { iterationId: string; text: string };

  'file.changed': { path: string; changeType: ChangeType; additions: number; deletions: number };

  'validation.started': { kind: ValidationKind; command: string; validationId: string };
  'validation.result': {
    kind: ValidationKind;
    validationId: string;
    outcome: ValidationOutcome;
    exitCode: number | null;
    durationMs: number | null;
  };
  'validation.completed': {
    total: number;
    passed: number;
    failed: number;
    notConfigured: number;
    blocking: boolean;
  };
  /** The whole validation phase did not run. A read-only mode is the reason. */
  'validation.skipped': { reason: string };

  'artifact.created': { artifactId: string; kind: ArtifactKind; label: string; bytes: number };
  /** The implementation map could not be drawn. The run itself is unaffected. */
  'visualisation.skipped': { reason: string };

  /**
   * An attachment arrived or left. Both are recorded because the attachment
   * list is part of what was asked for: a file removed after an iteration read
   * it would otherwise leave the run looking like it never had it.
   */
  'attachment.added': {
    attachmentId: string;
    fileName: string;
    mimeType: string;
    bytes: number;
  };
  'attachment.removed': { attachmentId: string; fileName: string };

  'review.started': { provider: string };
  'review.finding': {
    findingId: string;
    severity: FindingSeverity;
    title: string;
    file: string | null;
  };
  'review.completed': { provider: string; findingCount: number; blocking: boolean };
  'review.skipped': { provider: string; reason: string };

  'landing.queued': {
    repositoryPath: string;
    targetBranch: string;
    ahead: number;
    position: number;
  };
  'landing.dequeued': { repositoryPath: string; targetBranch: string };
  'landing.cancelled': { repositoryPath: string; targetBranch: string; reason: string };
  'landing.started': {
    path: string;
    branch: string;
    targetBranch: string;
    sourceBranch: string;
  };
  'landing.merged': { branch: string; targetBranch: string; sourceBranch: string; commitSha: string };
  'landing.conflicted': { files: string[] };
  'landing.resolution_started': { path: string; files: string[] };
  'landing.resolution_completed': {
    iterationId: string;
    unresolved: string[];
    staged?: string[];
    markerFiles?: string[];
  };
  'landing.refresh_started': { path: string; targetBranch: string; targetCommit: string };
  'landing.refresh_completed': { branch: string; targetBranch: string; commitSha: string };
  'landing.repair_started': { path: string; failed: ValidationKind[] };
  'landing.repair_committed': { branch: string; commitSha: string };
  'landing.manual_instructions': {
    reason: string;
    artifactId: string | null;
    path: string;
    targetBranch: string;
  };
  'landing.validation_failed': { failed: number; targetBranch: string };
  'landing.applied': { targetBranch: string; commitSha: string };
  'landing.failed': { error: string };

  'run.ready': { validationsPassed: number; blockingFindings: number };
  'run.needs_changes': { reasons: string[] };
  'run.approved': { note: string | null; commitSha: string | null };
  'run.rejected': { note: string | null };
  'run.failed': { error: string };
  'run.cancelled': { reason: string };
  'run.commit_created': { sha: string; message: string };
}

/** A persisted event as it comes back out of the database. */
export interface RunEvent<T extends EventType = EventType> {
  seq: number;
  id: string;
  runId: string;
  type: T;
  level: EventLevel;
  message: string;
  payload: T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;
  createdAt: string;
}

/** An event on its way in, before the store assigns `seq` and `createdAt`. */
export interface NewRunEvent<T extends EventType = EventType> {
  runId: string;
  type: T;
  level?: EventLevel;
  /** Short human-facing line. The UI shows this; payload drives the detail. */
  message: string;
  payload?: T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;
}
