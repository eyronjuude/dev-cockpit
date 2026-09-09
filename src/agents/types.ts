/**
 * The implementation agent boundary.
 *
 * The orchestrator talks only to this interface. CLI-backed implementation
 * agents slot in behind this boundary without changing run orchestration.
 *
 * IMPLEMENTER != APPROVER. Nothing an agent reports here marks a run complete.
 * `AgentOutcome.ok` means "the process ended without erroring", not "the work
 * is correct" — that judgement belongs to the validation engine and the user.
 */

export interface AgentStartInput {
  runId: string;
  iterationId: string;
  /** The prompt for this iteration. */
  prompt: string;
  /** Absolute path of the isolated worktree the agent must work inside. */
  worktreePath: string;
  /** Extra directories the agent may read, if the project needs them. */
  additionalDirs?: readonly string[];
  model?: string | null;
  /** Claude Code permission mode, or the provider's equivalent. */
  permissionMode?: string;
  /** Provider-specific effort/verbosity hint from the execution profile. */
  effort?: string | null;
  /** Wall-clock cap. The process is killed past it. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void | Promise<void>;
}

export interface AgentContinueInput extends AgentStartInput {
  /** Provider session to continue, so implementation context is not lost. */
  sessionId: string;
}

/**
 * Normalised agent events. Deliberately not the provider's wire format: the
 * orchestrator persists these, so a provider change must not rewrite history.
 */
export type AgentStreamEvent =
  | { kind: 'session'; sessionId: string; model: string | null; permissionMode: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_start'; toolUseId: string; tool: string; input: unknown }
  | { kind: 'tool_end'; toolUseId: string; tool: string; isError: boolean; summary: string }
  | { kind: 'notice'; text: string; level: 'info' | 'notice' | 'error' }
  | {
      kind: 'result';
      ok: boolean;
      finalText: string | null;
      numTurns: number | null;
      durationMs: number | null;
      costUsd: number | null;
      errorMessage: string | null;
      /** Tool names the provider refused, e.g. Bash under a restrictive mode. */
      deniedTools: string[];
    };

export interface AgentOutcome {
  /** Process-level success only. Not an approval signal. */
  ok: boolean;
  sessionId: string | null;
  exitCode: number | null;
  finalText: string | null;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  cancelled: boolean;
  timedOut: boolean;
  /**
   * Tool names the provider refused during the iteration.
   *
   * Non-empty means the agent worked with less capability than the prompt
   * assumed, which is worth telling the user rather than leaving them to infer
   * it from a summary that says "I could not run the checks".
   */
  deniedTools: string[];
  /** Path of the raw provider stream captured for the Logs tab. */
  rawLogPath: string | null;
}

export interface AgentAvailability {
  available: boolean;
  /** e.g. the resolved binary and version, or why it is unavailable. */
  detail: string;
  version: string | null;
}

export interface ImplementationAgent {
  readonly id: string;
  readonly label: string;

  /** Whether this provider can actually run right now. */
  checkAvailability(): Promise<AgentAvailability>;

  /** Fresh session. */
  startRun(input: AgentStartInput): Promise<AgentOutcome>;

  /** Continue an existing session so prior context survives. */
  continueRun(input: AgentContinueInput): Promise<AgentOutcome>;

  /** Best-effort termination of a running iteration. */
  cancelRun(iterationId: string): Promise<boolean>;

  /** Whether this provider currently has a process for that iteration. */
  getStatus(iterationId: string): AgentRunStatus;
}

export interface AgentRunStatus {
  running: boolean;
  iterationId: string;
  pid: number | null;
  startedAt: string | null;
  sessionId: string | null;
}
