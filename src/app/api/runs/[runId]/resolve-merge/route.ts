import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { resolveLandingConflicts } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Starts AI-assisted conflict resolution in the landing worktree. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    resolveLandingConflicts(runId);
    return { accepted: true };
  });
}
