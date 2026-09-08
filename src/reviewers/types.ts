import type { FindingSeverity, ValidationKind, ValidationOutcome } from '@/domain/types';

/**
 * The independent reviewer boundary.
 *
 * A reviewer reads evidence and returns findings. It is read-only by default
 * and the V1 implementations make that structural rather than advisory: they
 * run with no tools at all, so there is nothing available to them that could
 * edit a file.
 *
 * A finding is not a test failure. Deterministic validation produces facts with
 * exit codes; a reviewer produces opinions with severities. They are stored in
 * different tables and rendered differently on purpose, and by default a
 * finding does not block READY.
 */

export interface ReviewEvidence {
  runId: string;
  /** What the user asked for. */
  request: string;
  /** Transformed specification, when one exists. */
  spec: string | null;
  /** Unified diff. Passed verbatim; a reviewer must not rewrite it. */
  diff: string;
  changedFiles: readonly {
    path: string;
    changeType: string;
    additions: number;
    deletions: number;
  }[];
  validations: readonly {
    kind: ValidationKind;
    outcome: ValidationOutcome;
    exitCode: number | null;
    command: string | null;
    /** Tail of the output, for failures. */
    excerpt: string | null;
  }[];
  /** The agent's own closing message, for context on intent. */
  agentSummary: string | null;
  signal?: AbortSignal;
}

export interface ReviewFinding {
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  file: string | null;
  line: number | null;
  /** Advisory only. Nothing in V1 applies a suggestion automatically. */
  suggestion: string | null;
}

export interface ReviewResult {
  provider: string;
  findings: ReviewFinding[];
  /** Reviewer's overall note. Not an approval. */
  summary: string | null;
  durationMs: number;
  costUsd: number | null;
}

export interface ReviewerAvailability {
  available: boolean;
  detail: string;
}

export interface ReviewerAgent {
  readonly id: string;
  readonly label: string;
  readonly requirement: string;
  /** False would mean the reviewer can write; no V1 provider sets that. */
  readonly readOnly: boolean;

  checkAvailability(): Promise<ReviewerAvailability>;
  review(evidence: ReviewEvidence): Promise<ReviewResult>;
}
