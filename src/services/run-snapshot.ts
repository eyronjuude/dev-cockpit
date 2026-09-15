import 'server-only';

import { planExpiry } from '@/domain/expiry';
import type { ExpiryPlan } from '@/domain/expiry';
import type { PreviewView } from '@/domain/previews';
import type { ValidationKind } from '@/domain/types';
import {
  activeRunPhase,
  implementationAgentOptions,
  isRunActive,
} from '@/orchestrator/orchestrator';
import { transformerOptions } from '@/transformers/registry';
import { listArtifacts, type ArtifactView } from './artifacts';
import { canModifyAttachments } from './attachments';
import { getRunPreview } from './previews';
import { getProject, retentionPolicy } from './projects';
import { assessReadiness, getRun, type ReadinessAssessment, type RunView } from './runs';
import { runWorktrees, type RunWorktree } from './worktrees';

/**
 * The whole current state of a run, in one place.
 *
 * The run screen is server-rendered with a snapshot and then keeps it fresh by
 * refetching one. Both used to assemble the same object literal by hand, which
 * meant a field added to one and not the other made the first paint disagree
 * with the first refresh — a flicker that looks like a bug in whatever reads
 * the field rather than in the two places that build it.
 */

export interface ConfiguredValidation {
  key: string;
  label: string;
  /** A tag. Null for a step that fits none of the six kinds. */
  kind: ValidationKind | null;
  command: string;
  blocking: boolean;
}

export interface ImplementationAgentOption {
  id: string;
  label: string;
}

export interface RunSnapshot {
  run: RunView;
  readiness: ReadinessAssessment;
  artifacts: ArtifactView[];
  live: { active: boolean; phase: string | null };
  preview: PreviewView;
  /** This run's worktrees, and whether each is still on disk. */
  worktrees: RunWorktree[];
  /**
   * When retention will reclaim this run's storage. Computed server-side from
   * the project's windows, so the screen and the sweep can never disagree.
   */
  expiry: ExpiryPlan;
  /** Implementation providers the user may choose for the next agent pass. */
  implementationAgents: ImplementationAgentOption[];
  /** Transformers the user may choose for this and later iterations' summaries. */
  transformers: ImplementationAgentOption[];
  /**
   * Whether the attachment list can still be added to or removed from.
   *
   * Server-decided rather than derived on the client from the status, because
   * it also accounts for whether the orchestrator is mid-flight, which the
   * status alone does not say.
   */
  attachmentsMutable: boolean;
  configuredValidations: ConfiguredValidation[];
  policies: {
    requireValidation: boolean;
    requireE2eForUiChanges: boolean;
    reviewBlocksReady: boolean;
    allowAgentCommit: boolean;
    protectedBranches: string[];
    worktreeRetentionDays: number;
    artifactRetentionDays: number;
    /**
     * Carried so the Preview tab can tell a change to the site from a change
     * to a document without a round trip, using the same patterns `touchesUi`
     * matches on.
     */
    uiPathPatterns: string[];
    /** Where the preview opens by default, and what its readiness probe hits. */
    previewReadyPath: string;
  };
}

/** Null when the run or its project has gone; the callers decide what that means. */
export function buildRunSnapshot(runId: string): RunSnapshot | null {
  const run = getRun(runId);
  if (!run) return null;

  const project = getProject(run.projectId);
  if (!project) return null;

  const active = isRunActive(runId);

  return {
    run,
    readiness: assessReadiness(run, project),
    artifacts: listArtifacts(runId),
    live: { active, phase: activeRunPhase(runId) },
    preview: getRunPreview(runId),
    // Which of this run's worktrees are still on disk, so the action bar can
    // offer to reclaim them without guessing from the status alone.
    worktrees: runWorktrees(run, project),
    // Computed rather than stored: the answer changes when the project's
    // windows change, and a cached one would be wrong the moment they did.
    expiry: planExpiry(run, retentionPolicy(project)),
    implementationAgents: implementationAgentOptions(),
    transformers: transformerOptions(),
    attachmentsMutable: canModifyAttachments(runId) && !active,
    // Needed so the scorecard can distinguish a kind the project never
    // configured from one that is configured but has not run yet.
    configuredValidations: project.validationSteps
      .filter((step) => step.enabled && step.command.trim().length > 0)
      .map((step) => ({
        key: step.key,
        label: step.label,
        kind: step.kind,
        command: step.command,
        blocking: step.blocking,
      })),
    policies: {
      requireValidation: project.requireValidation,
      requireE2eForUiChanges: project.requireE2eForUiChanges,
      reviewBlocksReady: project.reviewBlocksReady,
      allowAgentCommit: project.allowAgentCommit,
      protectedBranches: project.protectedBranches,
      worktreeRetentionDays: project.worktreeRetentionDays,
      artifactRetentionDays: project.artifactRetentionDays,
      uiPathPatterns: project.uiPathPatterns,
      previewReadyPath: project.preview.readyPath,
    },
  };
}
