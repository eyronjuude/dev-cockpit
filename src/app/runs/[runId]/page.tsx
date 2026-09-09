import { notFound } from 'next/navigation';

import { RunView } from '@/components/run-view';
import { activeRunPhase, isRunActive } from '@/orchestrator/orchestrator';
import { listArtifacts } from '@/services/artifacts';
import { canModifyAttachments } from '@/services/attachments';
import { getRunPreview } from '@/services/previews';
import { getProject } from '@/services/projects';
import { assessReadiness, getRun } from '@/services/runs';
import { runWorktrees } from '@/services/worktrees';

export const dynamic = 'force-dynamic';

/**
 * The run screen.
 *
 * Server-rendered with a complete snapshot so the page is useful before any
 * JavaScript runs, then the client component subscribes to the event stream
 * and keeps it current.
 */
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = getRun(runId);
  if (!run) notFound();

  const project = getProject(run.projectId);
  if (!project) notFound();

  const active = isRunActive(runId);

  const initial = {
    run,
    readiness: assessReadiness(run, project),
    artifacts: listArtifacts(runId),
    live: { active, phase: activeRunPhase(runId) },
    preview: getRunPreview(runId),
    worktrees: runWorktrees(run, project),
    attachmentsMutable: canModifyAttachments(runId) && !active,
    configuredValidations: project.validationCommands
      .filter((c) => c.enabled && c.command.trim().length > 0)
      .map((c) => ({ kind: c.kind, command: c.command, blocking: c.blocking })),
    policies: {
      requireValidation: project.requireValidation,
      requireE2eForUiChanges: project.requireE2eForUiChanges,
      reviewBlocksReady: project.reviewBlocksReady,
      allowAgentCommit: project.allowAgentCommit,
      protectedBranches: project.protectedBranches,
    },
  };

  return <RunView initial={initial} />;
}
