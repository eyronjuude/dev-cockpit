import { handle } from '@/app/api/_lib/handler';
import { activeRunPhase, isRunActive } from '@/orchestrator/orchestrator';
import { listArtifacts } from '@/services/artifacts';
import { requireProject } from '@/services/projects';
import { assessReadiness, requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/**
 * The full current state of a run.
 *
 * The event stream tells the client that something changed; this tells it what
 * the state now is. Keeping the two separate means the UI never has to rebuild
 * run state by folding events, which is where drift creeps in.
 */
export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { runId } = await params;
    const run = requireRun(runId);
    const project = requireProject(run.projectId);
    const readiness = assessReadiness(run, project);

    return {
      run,
      readiness,
      artifacts: listArtifacts(runId),
      live: { active: isRunActive(runId), phase: activeRunPhase(runId) },
      // Needed so the scorecard can distinguish a kind the project never
      // configured from one that is configured but has not run yet.
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
  });
}
