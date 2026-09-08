import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { revalidate } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Re-runs validation against the existing worktree, without the agent. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    revalidate(runId);
    return { accepted: true };
  });
}
