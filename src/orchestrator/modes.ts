import { RESOLVED_WORK_MODES, type ResolvedWorkMode } from '@/domain/modes';
import type { ArtifactKind } from '@/domain/types';

/**
 * What each working mode does to a run.
 *
 * A mode is a bundle of behaviour, not a separate code path: the orchestrator
 * reads these fields and skips or runs phases accordingly, in the same way it
 * reads an execution profile. Adding a mode means adding an entry here and a
 * set of prompt rules in `prompt.ts`.
 *
 * The two are orthogonal. A profile sets effort, timeout and which validation
 * commands apply; a mode sets whether anything is allowed to change at all.
 *
 * The words a mode is described with live in `domain/modes.ts`, because
 * readiness and the UI need the same nouns and three copies would drift.
 */
export interface WorkModeBehaviour {
  readonly id: ResolvedWorkMode;
  /** Whether the implementer is allowed to change files. */
  readonly editsCode: boolean;
  /**
   * Permission mode forced on the agent, or null to use the project's.
   *
   * The read-only modes force Claude Code's own `plan` permission mode rather
   * than relying on the prompt alone. A prompt is an instruction; a permission
   * mode is a refusal, and "changes nothing" has to be the second kind of
   * promise.
   */
  readonly agentPermissionMode: string | null;
  /** Whether the project's validation commands run. */
  readonly runValidation: boolean;
  /** Whether an independent review runs, when one is configured. */
  readonly runReviewer: boolean;
  /**
   * Whether the transformer rewrites the implementer's closing message.
   *
   * Off for the read-only modes: there the closing message *is* the
   * deliverable, and the summary prompt compresses to three sentences.
   */
  readonly summariseOutcome: boolean;
  /** Where the closing message is stored, and what it is called. */
  readonly outcomeArtifact: {
    readonly kind: ArtifactKind;
    readonly label: string;
    /** Sub-directory of the run's artifact directory. */
    readonly directory: string;
  };
}

export const WORK_MODE_BEHAVIOURS: Record<ResolvedWorkMode, WorkModeBehaviour> = {
  ask: {
    id: 'ask',
    editsCode: false,
    agentPermissionMode: 'plan',
    runValidation: false,
    runReviewer: false,
    summariseOutcome: false,
    outcomeArtifact: { kind: 'answer', label: 'Answer', directory: 'answers' },
  },
  plan: {
    id: 'plan',
    editsCode: false,
    agentPermissionMode: 'plan',
    runValidation: false,
    runReviewer: false,
    summariseOutcome: false,
    outcomeArtifact: { kind: 'plan', label: 'Plan', directory: 'plans' },
  },
  build: {
    id: 'build',
    editsCode: true,
    agentPermissionMode: null,
    runValidation: true,
    runReviewer: true,
    summariseOutcome: true,
    outcomeArtifact: {
      kind: 'markdown_report',
      label: 'Implementation summary',
      directory: 'summaries',
    },
  },
};

export function getWorkMode(mode: string | null | undefined): WorkModeBehaviour {
  if (mode === 'plan') return WORK_MODE_BEHAVIOURS.plan;
  if (mode === 'ask') return WORK_MODE_BEHAVIOURS.ask;
  return WORK_MODE_BEHAVIOURS.build;
}

export function listWorkModes(): WorkModeBehaviour[] {
  return RESOLVED_WORK_MODES.map((id) => WORK_MODE_BEHAVIOURS[id]);
}

/**
 * The permission mode the agent actually runs under.
 *
 * The mode wins over the project setting, in one direction only: a mode can
 * take capability away, never add it. Ask and Plan override
 * `bypassPermissions`; nothing here can escalate a restrictive project.
 */
export function effectivePermissionMode(
  projectPermissionMode: string,
  mode: WorkModeBehaviour,
): string {
  return mode.agentPermissionMode ?? projectPermissionMode;
}
