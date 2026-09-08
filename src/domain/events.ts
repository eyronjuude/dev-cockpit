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

  'transform.started',
  'transform.completed',
  'transform.skipped',
  'transform.failed',
  'summarise.completed',
  'summarise.skipped',

  'worktree.prepared',
  'worktree.setup',

  'agent.started',
  'agent.message',
  'agent.thinking',
  'agent.tool_started',
  'agent.tool_completed',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'agent.notice',

  'file.changed',

  'validation.started',
  'validation.result',
  'validation.completed',

  'artifact.created',
  'visualisation.skipped',

  'review.started',
  'review.finding',
  'review.completed',
  'review.skipped',

  'landing.started',
  'landing.merged',
  'landing.conflicted',
  'landing.resolution_started',
  'landing.resolution_completed',
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
  'run.created': { title: string; request: string; profile: string };
  'run.status_changed': { from: RunStatus; to: RunStatus; reason?: string };

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
  'agent.failed': { iterationId: string; error: string; exitCode: number | null };
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

  'artifact.created': { artifactId: string; kind: ArtifactKind; label: string; bytes: number };
  /** The implementation map could not be drawn. The run itself is unaffected. */
  'visualisation.skipped': { reason: string };

  'review.started': { provider: string };
  'review.finding': {
    findingId: string;
    severity: FindingSeverity;
    title: string;
    file: string | null;
  };
  'review.completed': { provider: string; findingCount: number; blocking: boolean };
  'review.skipped': { provider: string; reason: string };

  'landing.started': {
    path: string;
    branch: string;
    targetBranch: string;
    sourceBranch: string;
  };
  'landing.merged': { branch: string; targetBranch: string; sourceBranch: string; commitSha: string };
  'landing.conflicted': { files: string[] };
  'landing.resolution_started': { path: string; files: string[] };
  'landing.resolution_completed': { iterationId: string; unresolved: string[] };
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

/** Events that belong in the compact "useful progress" feed. */
export const PROGRESS_EVENT_TYPES: readonly EventType[] = [
  'run.created',
  'run.status_changed',
  'transform.completed',
  'transform.skipped',
  'transform.failed',
  'summarise.completed',
  'worktree.prepared',
  'worktree.setup',
  'agent.started',
  'agent.message',
  'agent.tool_started',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'validation.started',
  'validation.result',
  'validation.completed',
  'visualisation.skipped',
  'review.started',
  'review.finding',
  'review.completed',
  'review.skipped',
  'landing.started',
  'landing.merged',
  'landing.conflicted',
  'landing.resolution_started',
  'landing.resolution_completed',
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
];

export function isProgressEvent(type: EventType): boolean {
  return PROGRESS_EVENT_TYPES.includes(type);
}
